#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bootstrap пользовательского установщика: скачивание проверяемой копии репозитория.

Режимы:
  verify-local --repo-dir DIR  — повторная offline-проверка подписи RELEASE.
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
from pathlib import Path
import re
import shutil
import stat
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
EVIDENCE_DIR = '.homecloud-release'
EVIDENCE_LOCK = 'release-lock.json'
EVIDENCE_SIGNATURE = 'release-lock.json.sig'
MAX_LOCK_BYTES = 8 * 1024 * 1024

# Trust anchor belongs to the trusted bootstrap, not the downloaded release.
# Changing this key requires an explicit key rotation procedure.
TRUSTED_RELEASE_PUBLIC_B64 = (
    'MCowBQYDK2VwAyEA0ILGVqfbCeMUPX2Nj5cfOCRJNrVyhoNm33YUrAiqR2U='
)
# Файлы без которых установщик не работает (должны входить в source_files lock).
REQUIRED_PATHS = ('deploy/user/install.sh', 'deploy/user/probe.py',
                  'deploy/user/generate.py', 'deploy/linux/preflight.py',
                  'docker-compose.yml', 'docker-compose.production.yml')


# Explicit allowlist for signed user deployment.
USER_DEPLOYMENT_PATHS = (
    'docker-compose.yml',
    'docker-compose.production.yml',
    'docker-compose.production-updates.yml',
    'deploy/user/install.sh',
    'deploy/user/probe.py',
    'deploy/user/generate.py',
    'deploy/user/update-worker.py',
    'deploy/user/bootstrap.py',
    'deploy/user/bootstrap.sh',
    'deploy/user/release-public.b64',
    'deploy/user/systemd/homecloud-user-update.path',
    'deploy/user/systemd/homecloud-user-update.service',
    'deploy/user/systemd/homecloud-user-update-archive.service',
    'deploy/user/systemd/homecloud-user-update-archive.timer',
    'deploy/linux/preflight.py',
    'deploy/linux/startup-gate.sh',
    'deploy/ingress/19-validate-public-host.sh',
    'deploy/ingress/default.conf.template',
    'deploy/ingress/upgrade.conf',
)

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
    missing_required = [path for path in USER_DEPLOYMENT_PATHS if path not in source_files]
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


def reject_evidence_members(members):
    for name in members:
        if name == EVIDENCE_DIR or name.startswith(EVIDENCE_DIR + '/'):
            raise Failure('архив содержит зарезервированный каталог доказательства RELEASE')


def release_member_map(archive):
    """Strict RELEASE index: no ambiguous paths or archive aliases."""
    members = {}
    seen = set()
    top = None

    for info in archive.getmembers():
        name = info.name.rstrip('/') if info.isdir() else info.name
        parts = name.split('/')

        if (not name or name.startswith('/') or '\\' in name
                or '\x00' in name
                or any(part in ('', '.', '..') for part in parts)):
            raise Failure('небезопасное имя в архиве RELEASE')

        if top is None:
            top = parts[0]

        if parts[0] != top:
            raise Failure('несколько корней архива RELEASE')

        if name in seen:
            raise Failure('дублирующийся путь в архиве RELEASE: ' + name)

        seen.add(name)

        if len(parts) == 1:
            if not info.isdir():
                raise Failure('корень архива RELEASE не является каталогом')
            continue

        relpath = '/'.join(parts[1:])
        members[relpath] = info

    reject_evidence_members(members)

    return members


def assert_trusted_release_destination(destination):
    """Root CLI may write only below trusted canonical directories."""
    root = Path(destination)

    if not root.is_absolute() or str(root) != destination or '..' in root.parts:
        raise Failure('неканонический каталог RELEASE')

    for directory in reversed((root, *root.parents)):
        try:
            info = directory.lstat()
        except FileNotFoundError:
            continue

        if not stat.S_ISDIR(info.st_mode):
            raise Failure('небезопасный родительский путь RELEASE')

        if info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
            raise Failure('недоверенный родительский каталог RELEASE')

        if hasattr(os, 'listxattr'):
            attributes = os.listxattr(directory, follow_symlinks=False)

            if any(
                attr in ('system.posix_acl_access',
                         'system.posix_acl_default')
                for attr in attributes
            ):
                raise Failure('ACL на родительском каталоге RELEASE')


def create_release_directories(path):
    for directory in reversed((path, *path.parents)):
        if not directory.exists():
            os.mkdir(directory, 0o755)

        if not directory.is_dir():
            raise Failure('некорректный каталог deployment')


def extract_release(archive, members, destination):
    """Write only the authenticated allowlist, never archive metadata."""
    root = Path(destination)

    if root.is_symlink():
        raise Failure('целевой каталог RELEASE является symlink')

    if root.exists() and (
            not root.is_dir() or any(root.iterdir())):
        raise Failure('целевой каталог RELEASE не пуст')

    # Validate every required member before the first write.
    for name in USER_DEPLOYMENT_PATHS:
        info = members.get(name)

        if info is None or not info.isfile():
            raise Failure('недопустимый deployment-файл: ' + name)

        parts = name.split('/')

        for index in range(1, len(parts)):
            ancestor = members.get('/'.join(parts[:index]))

            if ancestor is not None and not ancestor.isdir():
                raise Failure('конфликт файла и каталога deployment')

    create_release_directories(root)

    for name in USER_DEPLOYMENT_PATHS:
        target = root / name
        create_release_directories(target.parent)

        mode = 0o755 if name.endswith('.sh') else 0o644

        descriptor = os.open(
            target,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
        )

        with os.fdopen(descriptor, 'wb') as handle:
            os.fchmod(handle.fileno(), mode)

            with archive.extractfile(members[name]) as stream:
                shutil.copyfileobj(stream, handle)

            handle.flush()
            os.fsync(handle.fileno())


def extract_archive(archive, members, destination):
    """Распаковка в destination с проверкой имён (python 3.9, без tarfile filter)."""
    reject_evidence_members(members)
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


def trusted_public_key():
    return base64.b64decode(
        TRUSTED_RELEASE_PUBLIC_B64, validate=True)


def verify_archive_public_key(archive, members, trusted_der):
    info = members.get(PUBLIC_KEY_MEMBER)
    if info is None or not info.isfile():
        raise Failure('в архиве нет публичного ключа ' + PUBLIC_KEY_MEMBER)

    try:
        text = archive.extractfile(info).read().decode('ascii').strip()
        if not BASE64_RE.fullmatch(text):
            raise ValueError('invalid public key encoding')
        archive_der = base64.b64decode(text, validate=True)
    except (ValueError, UnicodeError):
        raise Failure('невалидный публичный ключ в архиве')

    if archive_der != trusted_der:
        raise Failure('публичный ключ архива не совпадает с доверенным ключом bootstrap')


def images_from_lock(lock):
    images = lock.get('images')

    if not isinstance(images, dict):
        raise Failure('release-lock: отсутствуют образы')

    pair = {}

    for role in ('backend', 'frontend'):
        item = images.get(role)

        if not isinstance(item, dict):
            raise Failure('release-lock: отсутствует образ ' + role)

        repository = 'ghcr.io/' + REPOSITORY + '/' + role
        digest = item.get('digest')

        if item.get('repository') != repository:
            raise Failure('release-lock: неверный репозиторий ' + role)

        if (not isinstance(digest, str)
                or not digest.startswith('sha256:')
                or not HEX64_RE.fullmatch(digest[7:])):
            raise Failure('release-lock: неверный digest ' + role)

        pair[role] = repository + '@' + digest

    return pair


def verify_release_lock(payload, signature, expected_tag=None):
    if not payload or len(payload) > MAX_LOCK_BYTES:
        raise Failure('release-lock: недопустимый размер')
    if not signature or len(signature) > 4096:
        raise Failure('release-lock: недопустимый размер подписи')

    verify_signature(
        payload, signature.decode('ascii'), trusted_public_key())

    lock = json.loads(payload.decode('utf-8'))

    if not isinstance(lock, dict) or lock.get('format') != LOCK_FORMAT:
        raise Failure('неверная структура release-lock')

    tag = lock.get('tag')

    if not isinstance(tag, str) or not TAG_RE.fullmatch(tag):
        raise Failure('release-lock: неверный тег')

    if expected_tag is not None and tag != expected_tag:
        raise Failure('release-lock относится к другому тегу')

    return lock, images_from_lock(lock)


def save_release_evidence(destination, payload, signature):
    directory = os.path.join(destination, EVIDENCE_DIR)

    # Exclusive creation: never reuse an existing proof directory.
    os.mkdir(directory, 0o700)

    for name, data in (
        (EVIDENCE_LOCK, payload),
        (EVIDENCE_SIGNATURE, signature),
    ):
        path = os.path.join(directory, name)

        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )

        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())


def check_local_file_metadata(info, mode):
    if (not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != mode):
        raise Failure('недопустимый владелец, тип или права файла RELEASE')


def check_local_acl(path):
    if hasattr(os, 'listxattr'):
        attributes = os.listxattr(path, follow_symlinks=False)

        if any(
            attr in ('system.posix_acl_access',
                     'system.posix_acl_default')
            for attr in attributes
        ):
            raise Failure('недопустимый ACL deployment RELEASE')


def check_local_directory(path, evidence=False):
    info = path.lstat()
    mode = stat.S_IMODE(info.st_mode)

    if (not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid()
            or mode & 0o7022
            or mode & 0o700 != 0o700):
        raise Failure('недоверенный каталог deployment RELEASE')

    if evidence and mode != 0o700:
        raise Failure('неверные права каталога доказательства RELEASE')

    check_local_acl(path)


def local_deployment_files():
    files = {
        name: 0o755 if name.endswith('.sh') else 0o644
        for name in USER_DEPLOYMENT_PATHS
    }

    files[EVIDENCE_DIR + '/' + EVIDENCE_LOCK] = 0o600
    files[EVIDENCE_DIR + '/' + EVIDENCE_SIGNATURE] = 0o600

    return files


def verify_local_layout(destination):
    root = Path(destination)
    expected_files = local_deployment_files()

    expected_dirs = {
        str(parent)
        for name in expected_files
        for parent in Path(name).parents
        if str(parent) != '.'
    }

    check_local_directory(root)

    found_files = set()
    found_dirs = set()
    pending = [root]

    while pending:
        directory = pending.pop()

        for target in directory.iterdir():
            name = str(target.relative_to(root))
            info = target.lstat()

            if name in expected_files:
                check_local_file_metadata(
                    info, expected_files[name])
                check_local_acl(target)
                found_files.add(name)

            elif name in expected_dirs:
                check_local_directory(
                    target, evidence=(name == EVIDENCE_DIR))
                found_dirs.add(name)
                pending.append(target)

            else:
                raise Failure(
                    'посторонний путь в deployment RELEASE: ' + name)

    if found_files != set(expected_files):
        raise Failure('отсутствуют обязательные файлы deployment RELEASE')

    if found_dirs != expected_dirs:
        raise Failure('отсутствуют обязательные каталоги deployment RELEASE')


def verify_local_deployment_hashes(destination, lock):
    source_files = lock.get('source_files')

    if not isinstance(source_files, dict):
        raise Failure('в lock отсутствует source_files')

    descriptor = os.open(
        destination,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )

    try:
        for name in USER_DEPLOYMENT_PATHS:
            expected = source_files.get(name)

            if (not isinstance(expected, str)
                    or not HEX64_RE.fullmatch(expected)):
                raise Failure(
                    'нет подписанного хэша deployment: ' + name)

            data = read_evidence_file(
                descriptor,
                name,
                MAX_LOCK_BYTES,
                mode=0o755 if name.endswith('.sh') else 0o644,
            )

            if sha256_hex(data) != expected:
                raise Failure(
                    'хэш локального deployment не совпадает: ' + name)
    finally:
        os.close(descriptor)


def read_evidence_file(directory_fd, name, limit, mode=0o600):
    descriptor = os.open(
        name,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        dir_fd=directory_fd,
    )

    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())

        check_local_file_metadata(info, mode)

        if not 0 <= info.st_size <= limit:
            raise Failure('недопустимый размер локального файла RELEASE')

        content = handle.read(limit + 1)

        if len(content) > limit:
            raise Failure('доказательство RELEASE превышает допустимый размер')

        return content


def verify_local_release(destination):
    directory = os.path.join(destination, EVIDENCE_DIR)

    try:
        assert_trusted_release_destination(destination)
        verify_local_layout(destination)

        descriptor = os.open(
            directory,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )

        try:
            payload = read_evidence_file(
                descriptor, EVIDENCE_LOCK, MAX_LOCK_BYTES)
            signature = read_evidence_file(
                descriptor, EVIDENCE_SIGNATURE, 4096)
        finally:
            os.close(descriptor)

        lock, images = verify_release_lock(payload, signature)
        verify_local_deployment_hashes(destination, lock)

    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError) as error:
        raise Failure('локальное доказательство RELEASE отклонено: ' + str(error))

    return {'tag': lock['tag'], 'images': images}


def fetch_signed(tag, destination, fetch=real_fetch):
    assert_trusted_release_destination(destination)

    log('скачиваю release-lock.json и подпись для %s' % tag)
    lock_payload = fetch(RELEASES + tag + '/release-lock.json')
    signature = fetch(RELEASES + tag + '/release-lock.json.sig')
    public_der = trusted_public_key()
    log('проверяю подпись Ed25519 доверенным ключом bootstrap')
    lock, images = verify_release_lock(lock_payload, signature, tag)

    log('скачиваю архив репозитория (%s)' % tag)
    tarball = fetch(CODELOAD + tag)

    with tarfile.open(fileobj=io.BytesIO(tarball), mode='r:gz') as archive:
        members = release_member_map(archive)
        verify_archive_public_key(archive, members, public_der)
        log('проверяю хэши исходников по подписанному lock (%d файлов)' % len(lock.get('source_files', {})))
        verify_source_tree(archive, members, lock)
        log('распаковываю в %s' % destination)
        extract_release(archive, members, destination)

    save_release_evidence(destination, lock_payload, signature)

    verified = verify_local_release(destination)

    if verified != {'tag': tag, 'images': images}:
        raise Failure('локальное доказательство RELEASE изменилось')

    return verified


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
    verify_parser = sub.add_parser(
        'verify-local', help='проверить сохранённое доказательство RELEASE')
    verify_parser.add_argument('--repo-dir', required=True)

    args = parser.parse_args(argv)

    try:
        if args.command == 'latest-tag':
            print(latest_release_tag())
            return 0
        if args.command == 'verify-local':
            result = verify_local_release(args.repo_dir)
            print(json.dumps(result, ensure_ascii=False))
            return 0

        destination = args.dest
        if os.path.exists(destination) and os.listdir(destination):
            raise Failure('целевой каталог не пуст: %s' % destination)
        if args.tag:
            assert_trusted_release_destination(destination)
            result = fetch_signed(args.tag, destination)
        else:
            result = fetch_unsigned(args.ref, destination)
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
