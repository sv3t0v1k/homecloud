#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты bootstrap.py: доверие к скачиваемому репозиторию.

Happy path: release-lock подписывается сырым openssl (Ed25519, тот же контракт,
что в update-worker и release.py); архив собирается в памяти. Сеть подменяется
канированным fetcher'ом.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import urllib.error

SPEC = importlib.util.spec_from_file_location(
    'bootstrap', Path(__file__).with_name('bootstrap.py'))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)

OPENSSL = os.environ.get('HOMECLOUD_OPENSSL', 'openssl')

# RFC 8032 Test 2 — релизный ключ тестов (как в test_update_worker.py).
RFC_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
RFC_PUBLIC = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
PKCS8_PREFIX = bytes.fromhex('302e020100300506032b657004220420')
SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
PRIVATE_DER = PKCS8_PREFIX + bytes.fromhex(RFC_SEED)
PUBLIC_B64 = base64.b64encode(SPKI_PREFIX + bytes.fromhex(RFC_PUBLIC)).decode()
FOREIGN_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
FOREIGN_PRIVATE_DER = PKCS8_PREFIX + bytes.fromhex(FOREIGN_SEED)

TAG = 'v1.2.0'

INSTALLER_FILES = {
    'deploy/user/install.sh': b'#!/bin/sh\necho install\n',
    'deploy/user/probe.py': b'print("probe")\n',
    'deploy/user/generate.py': b'print("generate")\n',
    'deploy/user/update-worker.py': b'print("worker")\n',
    'deploy/user/bootstrap.py': b'print("bootstrap")\n',
    'deploy/user/bootstrap.sh': b'#!/bin/sh\nexit 0\n',
    'deploy/user/release-public.b64': (PUBLIC_B64 + '\n').encode(),
    'deploy/user/systemd/homecloud-user-update.path': b'[Path]\n',
    'deploy/linux/preflight.py': b'print("preflight")\n',
    'docker-compose.yml': b'services: {}\n',
    'docker-compose.production.yml': b'services: {}\n',
    'docker-compose.production-updates.yml': b'services: {}\n',
    'docs/updates/user-update-channel-design.md': '# дизайн\n'.encode(),
}


def openssl_sign(payload, private_der=PRIVATE_DER):
    with tempfile.TemporaryDirectory() as directory:
        key = Path(directory) / 'private.der'
        msg = Path(directory) / 'payload.bin'
        sig = Path(directory) / 'signature.bin'
        key.write_bytes(private_der)
        msg.write_bytes(payload)
        result = subprocess.run([OPENSSL, 'pkeyutl', '-sign', '-inkey', str(key),
                                 '-keyform', 'DER', '-rawin', '-in', str(msg),
                                 '-out', str(sig)], capture_output=True)
        if result.returncode != 0:
            raise AssertionError('openssl sign failed: ' + result.stderr.decode())
        return base64.b64encode(sig.read_bytes()).decode()


def make_lock(tag=TAG, files=None, include_required=True):
    files = INSTALLER_FILES if files is None else files
    if not include_required:
        files = {name: data for name, data in files.items()
                 if name != 'deploy/user/install.sh'}
    lock = {
        'format': 'homecloud-ci-candidate-v1',
        'tag': tag,
        'commit': 'a' * 40,
        'images': {
            role: {
                'repository': 'ghcr.io/sv3t0v1k/homecloud/' + role,
                'digest': 'sha256:' + hashlib.sha256((tag + role).encode()).hexdigest(),
            } for role in ('backend', 'frontend')
        },
        'source_files': {name: hashlib.sha256(data).hexdigest()
                         for name, data in files.items()},
    }
    payload = (json.dumps(lock, indent=2, ensure_ascii=False) + '\n').encode()
    return lock, payload


def make_tarball(files, prefix='homecloud-' + TAG + '/'):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo(prefix.rstrip('/'))
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        archive.addfile(info)
        for name, data in files.items():
            info = tarfile.TarInfo(prefix + name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def canned_fetch(routes):
    def fetch(url):
        if url not in routes:
            raise AssertionError('неожиданный URL: ' + url)
        value = routes[url]
        if isinstance(value, Exception):
            raise value
        return value
    return fetch


def release_routes(tag=TAG, files=None, signer=openssl_sign, prefix=None,
                   include_required=True):
    lock, payload = make_lock(tag=tag, files=files, include_required=include_required)
    signature = signer(payload)
    tarball = make_tarball(files if files is not None else INSTALLER_FILES,
                           prefix or 'homecloud-' + tag + '/')
    return {
        bootstrap.API + '/releases/latest':
            json.dumps({'tag_name': tag}).encode(),
        bootstrap.RELEASES + tag + '/release-lock.json': payload,
        bootstrap.RELEASES + tag + '/release-lock.json.sig': signature.encode(),
        bootstrap.CODELOAD + tag: tarball,
    }


class OpensslRequired(unittest.TestCase):
    def setUp(self):
        result = subprocess.run([OPENSSL, 'version'], capture_output=True, text=True)
        if result.returncode != 0 or 'OpenSSL' not in result.stdout:
            self.skipTest('OpenSSL 3 недоступен: ' + OPENSSL)


class LatestTagTests(OpensslRequired):
    def test_happy(self):
        fetch = canned_fetch({bootstrap.API + '/releases/latest':
                              json.dumps({'tag_name': 'v0.4.2'}).encode()})
        self.assertEqual(bootstrap.latest_release_tag(fetch), 'v0.4.2')

    def test_bad_format_rejected(self):
        fetch = canned_fetch({bootstrap.API + '/releases/latest':
                              json.dumps({'tag_name': 'main'}).encode()})
        with self.assertRaises(bootstrap.Failure):
            bootstrap.latest_release_tag(fetch)


class FetchSignedTests(OpensslRequired):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(
            bootstrap, 'TRUSTED_RELEASE_PUBLIC_B64', PUBLIC_B64)
        patcher.start()
        self.addCleanup(patcher.stop)

    def dest(self):
        return tempfile.TemporaryDirectory()

    def test_happy_extracts_and_reports_images(self):
        routes = release_routes()
        with self.dest() as directory:
            result = bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))
            self.assertEqual(result['tag'], TAG)
            self.assertEqual(
                result['images']['backend'],
                'ghcr.io/sv3t0v1k/homecloud/backend@sha256:' +
                hashlib.sha256((TAG + 'backend').encode()).hexdigest())
            for name, data in INSTALLER_FILES.items():
                target = Path(directory) / name
                self.assertTrue(target.is_file(), 'нет ' + name)
                self.assertEqual(target.read_bytes(), data)

    def test_tampered_source_rejected(self):
        files = dict(INSTALLER_FILES)
        files['deploy/user/install.sh'] = b'#!/bin/sh\nevil\n'
        routes = release_routes(files=INSTALLER_FILES)
        routes[bootstrap.CODELOAD + TAG] = make_tarball(files)
        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))

    def test_foreign_signature_rejected(self):
        routes = release_routes(signer=lambda payload: openssl_sign(
            payload, FOREIGN_PRIVATE_DER))
        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))

    def test_foreign_key_and_signature_rejected_before_archive_download(self):
        # Both the release lock and the archive key are replaced.
        foreign_public = bytes.fromhex(
            'd75a980182b10ab7d54bfed3c964073a'
            '0ee172f3daa62325af021a68f707511a'
        )

        files = dict(INSTALLER_FILES)
        files[bootstrap.PUBLIC_KEY_MEMBER] = (
            base64.b64encode(SPKI_PREFIX + foreign_public) + b'\n'
        )

        routes = release_routes(
            files=files,
            signer=lambda payload: openssl_sign(
                payload, FOREIGN_PRIVATE_DER)
        )

        fetch = mock.Mock(side_effect=canned_fetch(routes))

        with self.dest() as directory:
            with self.assertRaisesRegex(
                bootstrap.Failure, 'подпись release-lock'
            ):
                bootstrap.fetch_signed(TAG, directory, fetch=fetch)

            self.assertEqual(list(Path(directory).iterdir()), [])

        # An invalid signature must stop the process before archive download.
        self.assertNotIn(
            mock.call(bootstrap.CODELOAD + TAG),
            fetch.call_args_list,
        )

    def test_valid_signature_with_foreign_archive_key_rejected(self):
        foreign_public = bytes.fromhex(
            'd75a980182b10ab7d54bfed3c964073a'
            '0ee172f3daa62325af021a68f707511a'
        )

        files = dict(INSTALLER_FILES)
        files[bootstrap.PUBLIC_KEY_MEMBER] = (
            base64.b64encode(SPKI_PREFIX + foreign_public) + b'\n'
        )

        # Even an authentic signature does not authorize a silent key change.
        routes = release_routes(files=files)

        with self.dest() as directory:
            with self.assertRaisesRegex(
                bootstrap.Failure, 'не совпадает с доверенным ключом'
            ):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_missing_archive_key_rejected(self):
        files = dict(INSTALLER_FILES)
        del files[bootstrap.PUBLIC_KEY_MEMBER]

        routes = release_routes(files=files)

        with self.dest() as directory:
            with self.assertRaisesRegex(
                bootstrap.Failure, 'нет публичного ключа'
            ):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_signed_invalid_images_rejected_before_archive_download(self):
        for role in ('backend', 'frontend'):
            for key, value in (
                ('repository', 'ghcr.io/foreign/homecloud/' + role),
                ('digest', 'latest'),
            ):
                with self.subTest(role=role, key=key):
                    lock, _ = make_lock()
                    lock['images'][role][key] = value

                    payload = json.dumps(lock).encode()
                    routes = release_routes()

                    routes[bootstrap.RELEASES + TAG + '/release-lock.json'] = payload
                    routes[bootstrap.RELEASES + TAG + '/release-lock.json.sig'] = (
                        openssl_sign(payload).encode()
                    )

                    fetch = mock.Mock(
                        side_effect=canned_fetch(routes))

                    with self.dest() as directory:
                        with self.assertRaises(bootstrap.Failure):
                            bootstrap.fetch_signed(
                                TAG, directory, fetch=fetch)

                        self.assertEqual(
                            list(Path(directory).iterdir()), [])

                    self.assertNotIn(
                        mock.call(bootstrap.CODELOAD + TAG),
                        fetch.call_args_list,
                    )

    def test_lock_tag_mismatch_rejected(self):
        # Ассеты отдаются по запрошенному тегу, но lock внутри — от другого
        # релиза: подпись валидна, а привязка к тегу нарушена.
        _, payload = make_lock(tag='v9.9.9')
        routes = release_routes()
        routes[bootstrap.RELEASES + TAG + '/release-lock.json'] = payload
        routes[bootstrap.RELEASES + TAG + '/release-lock.json.sig'] = \
            openssl_sign(payload).encode()
        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))

    def test_lock_without_installer_coverage_rejected(self):
        # make_lock не включил install.sh в source_files — архив тот же,
        # но lock не покрывает файлы установщика.
        routes = release_routes(include_required=False)
        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))

    def test_path_traversal_member_ignored(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            for name, data in INSTALLER_FILES.items():
                info = tarfile.TarInfo('homecloud-' + TAG + '/' + name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            evil = tarfile.TarInfo('../../etc/evil')
            payload = b'evil'
            evil.size = len(payload)
            archive.addfile(evil, io.BytesIO(payload))
        routes = release_routes()
        routes[bootstrap.CODELOAD + TAG] = buffer.getvalue()
        with tempfile.TemporaryDirectory() as parent:
            directory = os.path.join(parent, 'repo')
            bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))
            self.assertFalse(os.path.exists(os.path.join(parent, '..', 'etc', 'evil')))


class FetchUnsignedTests(OpensslRequired):
    def test_ref_extracts_without_signature(self):
        routes = {bootstrap.CODELOAD + 'test':
                  make_tarball(INSTALLER_FILES, prefix='homecloud-test/')}
        with tempfile.TemporaryDirectory() as directory:
            result = bootstrap.fetch_unsigned('test', directory, fetch=canned_fetch(routes))
            self.assertIsNone(result['images'])
            self.assertTrue((Path(directory) / 'deploy/user/install.sh').is_file())

    def test_ref_without_installer_files_rejected(self):
        routes = {bootstrap.CODELOAD + 'test':
                  make_tarball({'README.md': b'hi\n'}, prefix='homecloud-test/')}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_unsigned('test', directory, fetch=canned_fetch(routes))


class MainTests(OpensslRequired):
    def test_dest_not_empty_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'occupied').write_text('x')
            code = bootstrap.main(['fetch', '--tag', TAG, '--dest', directory])
            self.assertEqual(code, 1)

    def test_network_error_fails_closed(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = os.path.join(parent, 'repo')
            with mock.patch('urllib.request.urlopen',
                            side_effect=urllib.error.URLError('offline')):
                code = bootstrap.main(['fetch', '--tag', TAG, '--dest', directory])
            self.assertEqual(code, 1)
            self.assertFalse(os.path.exists(directory))


class ImagesFromLockTests(unittest.TestCase):
    def test_incomplete_images_rejected(self):
        lock, _ = make_lock()
        del lock['images']['frontend']

        with self.assertRaises(bootstrap.Failure):
            bootstrap.images_from_lock(lock)

    def test_invalid_image_identities_rejected(self):
        mutations = (
            ('repository', 'docker.io/example/backend'),
            ('repository', 'ghcr.io/sv3t0v1k/homecloud/frontend'),
            ('repository', 'ghcr.io/sv3t0v1k/homecloud/backend:latest'),
            ('digest', 'latest'),
            ('digest', 'sha256:' + 'a' * 63),
            ('digest', 'sha256:' + 'a' * 65),
            ('digest', 'sha256:' + 'G' * 64),
            ('digest', 'sha256:' + 'A' * 64),
            ('digest', None),
        )

        for key, value in mutations:
            with self.subTest(key=key, value=value):
                lock, _ = make_lock()
                lock['images']['backend'][key] = value

                with self.assertRaises(bootstrap.Failure):
                    bootstrap.images_from_lock(lock)

        for images in (None, [], {}, 'invalid'):
            with self.subTest(images=images):
                with self.assertRaises(bootstrap.Failure):
                    bootstrap.images_from_lock({'images': images})


class ProductionTrustAnchorTests(unittest.TestCase):
    def test_embedded_key_matches_production_key(self):
        key_file = Path(__file__).with_name('release-public.b64')

        self.assertEqual(
            bootstrap.TRUSTED_RELEASE_PUBLIC_B64,
            key_file.read_text().strip(),
        )

        der = bootstrap.trusted_public_key()

        self.assertEqual(len(der), 44)
        self.assertTrue(der.startswith(SPKI_PREFIX))


if __name__ == '__main__':
    unittest.main(verbosity=2)
