#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bootstrap пользовательского установщика: скачивание проверяемой копии репозитория.

Режимы:
  latest-tag                    — тег последнего GitHub-релиза (проверка формата).
  fetch --tag TAG --dest DIR    — скачать релиз TAG, проверить подпись Ed25519
                                  release-lock.json.sig и хэши source_files,
                                  распаковать в DIR (который должен отсутствовать
                                  или быть пустым).
  fetch --ref REF --dest DIR    — скачать tarball ветки/коммита БЕЗ проверки
                                  подписи (только test-канал; предупреждение
                                  печатает bootstrap.sh).

Вывод fetch — JSON на stdout: {"tag": ..., "images": {"backend": ..., "frontend": ...}}
(images только для подписанного релиза). Прогресс — в stderr.

Fetcher инъектируется для тестов: fetch(url) -> bytes.
"""
import argparse
import base64
import io
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

REPOSITORY = 'sv3t0v1k/homecloud'
API = 'https://api.github.com/repos/' + REPOSITORY
CODELOAD = 'https://codeload.github.com/' + REPOSITORY + '/tar.gz/'
RELEASES = 'https://github.com/' + REPOSITORY + '/releases/download/'
USER_AGENT = 'homecloud-user-bootstrap'
TAG_RE = re.compile(r'^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.[0-9]+)?$')
HEX64_RE = re.compile(r'^[0-9a-f]{64}$')
BASE64_RE = re.compile(r'^[A-Za-z0-9+/=\n]+$')
LOCK_FORMAT = 'homecloud-ci-candidate-v1'
PUBLIC_KEY_MEMBER = 'deploy/user/release-public.b64'
# Файлы без которых установщик не работает (должны входить в source_files lock).
REQUIRED_PATHS = ('deploy/user/install.sh', 'deploy/user/probe.py',
                  'deploy/user/generate.py', 'deploy/linux/preflight.py',
                  'docker-compose.yml', 'docker-compose.production.yml')


class Failure(Exception):
    pass


def log(message):
    print('bootstrap: ' + message, file=sys.stderr, flush=True)


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def real_fetch(url):
    accept = ('application/vnd.github+json' if 'api.github.com' in url
              else 'application/octet-stream')
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT,
                                                   'Accept': accept})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def latest_release_tag(fetch=real_fetch):
    try:
        data = json.loads(fetch(API + '/releases/latest').decode('utf-8'))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise Failure('у репозитория пока нет опубликованных релизов; '
                          'укажите тег явно: --tag vX.Y.Z')
        raise
    tag = data.get('tag_name')
    if not isinstance(tag, str) or not TAG_RE.fullmatch(tag):
        raise Failure('неожиданный тег последнего релиза: %r' % (tag,))
    return tag


def verify_signature(payload, signature_b64, public_der):
    """Проверка Ed25519 через openssl 3 (pkeyutl -rawin), как в update-worker."""
    try:
        signature = base64.b64decode(signature_b64.strip(), validate=True)
    except Exception:
        raise Failure('подпись релиза: невалидный base64')
    if len(signature) != 64:
        raise Failure('подпись релиза: неверная длина Ed25519')
    openssl = os.environ.get('HOMECLOUD_OPENSSL', 'openssl')
    with tempfile.TemporaryDirectory() as directory:
        key_path = os.path.join(directory, 'public.der')
        sig_path = os.path.join(directory, 'signature.bin')
        msg_path = os.path.join(directory, 'payload.bin')
        with open(key_path, 'wb') as handle:
            handle.write(public_der)
        with open(sig_path, 'wb') as handle:
            handle.write(signature)
        with open(msg_path, 'wb') as handle:
            handle.write(payload)
        result = subprocess.run([openssl, 'pkeyutl', '-verify', '-pubin',
                                 '-inkey', key_path, '-keyform', 'DER',
                                 '-rawin', '-in', msg_path, '-sigfile', sig_path],
                                capture_output=True)
    if result.returncode != 0:
        raise Failure('подпись release-lock не подтверждается ключом релизов')


def member_map(archive):
    """relpath -> TarInfo, без top-level каталога tarball (homecloud-<ref>/).

    Отбрасывает небезопасные имена (абсолютные, с '..', не-файлы/не-каталоги).
    """
    members = {}
    for info in archive.getmembers():
        parts = [part for part in info.name.split('/') if part not in ('', '.')]
        if not parts or any(part == '..' for part in parts):
            continue
        if not (info.isfile() or info.isdir()):
            continue
        relpath = '/'.join(parts[1:]) if len(parts) > 1 else ''
        if relpath:
            members.setdefault(relpath, info)
    return members


def verify_source_tree(archive, members, lock):
    source_files = lock.get('source_files')
    if not isinstance(source_files, dict):
        raise Failure('в lock отсутствует source_files')
    missing_required = [path for path in REQUIRED_PATHS if path not in source_files]
    if missing_required:
        raise Failure('lock не покрывает файлы установщика: %s' % ', '.join(missing_required))
    problems = []
    for relpath, expected in sorted(source_files.items()):
        if not isinstance(expected, str) or not HEX64_RE.fullmatch(expected):
            problems.append('%s: невалидный хэш в lock' % relpath)
            continue
        info = members.get(relpath)
        if info is None or not info.isfile():
            problems.append('%s: отсутствует в архиве' % relpath)
            continue
        actual = sha256_hex(archive.extractfile(info).read())
        if actual != expected:
            problems.append('%s: хэш не совпадает' % relpath)
    if problems:
        raise Failure('подписанный lock не соответствует архиву:\n  ' + '\n  '.join(problems))


def extract_archive(archive, members, destination):
    """Распаковка в destination с проверкой имён (python 3.9, без tarfile filter)."""
    os.makedirs(destination, exist_ok=True)
    for relpath, info in members.items():
        target = os.path.realpath(os.path.join(destination, relpath))
        root = os.path.realpath(destination)
        if target != root and not target.startswith(root + os.sep):
            raise Failure('небезопасный путь в архиве: %s' % relpath)
        if info.isdir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        source = archive.extractfile(info)
        with open(target, 'wb') as handle:
            shutil.copyfileobj(source, handle)
        os.chmod(target, info.mode & 0o777)


def load_public_key(archive, members):
    info = members.get(PUBLIC_KEY_MEMBER)
    if info is None or not info.isfile():
        raise Failure('в архиве нет публичного ключа ' + PUBLIC_KEY_MEMBER)
    text = archive.extractfile(info).read().decode('ascii').strip()
    if not BASE64_RE.fullmatch(text):
        raise Failure('невалидный публичный ключ релизов')
    return base64.b64decode(text, validate=True)


def images_from_lock(lock):
    images = lock.get('images')
    if not isinstance(images, dict):
        return None
    pair = {}
    for role in ('backend', 'frontend'):
        item = images.get(role)
        if not isinstance(item, dict) or not isinstance(item.get('repository'), str) \
                or not isinstance(item.get('digest'), str):
            return None
        pair[role] = item['repository'] + '@' + item['digest']
    return pair


def fetch_signed(tag, destination, fetch=real_fetch):
    log('скачиваю release-lock.json и подпись для %s' % tag)
    lock_payload = fetch(RELEASES + tag + '/release-lock.json')
    signature = fetch(RELEASES + tag + '/release-lock.json.sig')
    log('скачиваю архив репозитория (%s)' % tag)
    tarball = fetch(CODELOAD + tag)
    with tarfile.open(fileobj=io.BytesIO(tarball), mode='r:gz') as archive:
        members = member_map(archive)
        public_der = load_public_key(archive, members)
        log('проверяю подпись Ed25519 release-lock')
        verify_signature(lock_payload, signature.decode('ascii'), public_der)
        lock = json.loads(lock_payload.decode('utf-8'))
        if lock.get('format') != LOCK_FORMAT:
            raise Failure('неверный формат lock: %r' % (lock.get('format'),))
        if lock.get('tag') != tag:
            raise Failure('lock относится к %r, а не к %r' % (lock.get('tag'), tag))
        log('проверяю хэши исходников по подписанному lock (%d файлов)' % len(lock.get('source_files', {})))
        verify_source_tree(archive, members, lock)
        log('распаковываю в %s' % destination)
        extract_archive(archive, members, destination)
    return {'tag': tag, 'images': images_from_lock(lock)}


def fetch_unsigned(ref, destination, fetch=real_fetch):
    log('скачиваю архив репозитория (%s), БЕЗ проверки подписи' % ref)
    tarball = fetch(CODELOAD + ref)
    with tarfile.open(fileobj=io.BytesIO(tarball), mode='r:gz') as archive:
        members = member_map(archive)
        for relpath in REQUIRED_PATHS:
            info = members.get(relpath)
            if info is None or not info.isfile():
                raise Failure('в архиве нет %s — это не установочный репозиторий' % relpath)
        log('распаковываю в %s' % destination)
        extract_archive(archive, members, destination)
    return {'ref': ref, 'images': None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('latest-tag', help='тег последнего GitHub-релиза')
    fetch_parser = sub.add_parser('fetch', help='скачать и распаковать репозиторий')
    source = fetch_parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--tag', help='подписанный релизный тег')
    source.add_argument('--ref', help='ветка/коммит без проверки подписи (test)')
    fetch_parser.add_argument('--dest', required=True, help='целевой каталог (пустой или новый)')
    args = parser.parse_args(argv)

    try:
        if args.command == 'latest-tag':
            print(latest_release_tag())
            return 0
        destination = args.dest
        if os.path.exists(destination) and os.listdir(destination):
            raise Failure('целевой каталог не пуст: %s' % destination)
        result = fetch_signed(args.tag, destination) if args.tag else fetch_unsigned(args.ref, destination)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Failure as error:
        log('STOP: %s' % error)
        return 1
    except Exception as error:  # сеть, JSON, tar — всё равно fail-closed
        log('STOP: %s: %s' % (type(error).__name__, error))
        return 1


if __name__ == '__main__':
    sys.exit(main())
