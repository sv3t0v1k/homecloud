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
    'deploy/user/systemd/homecloud-user-update.service': b'[Service]\n',
    'deploy/user/systemd/homecloud-user-update-archive.service': b'[Service]\n',
    'deploy/user/systemd/homecloud-user-update-archive.timer': b'[Timer]\n',
    'deploy/linux/startup-gate.sh': b'#!/bin/sh\nexit 0\n',
    'deploy/ingress/19-validate-public-host.sh': b'#!/bin/sh\nexit 0\n',
    'deploy/ingress/default.conf.template': b'# fixture\n',
    'deploy/ingress/upgrade.conf': b'# fixture\n',
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


def make_tarball(files, prefix='homecloud-' + TAG + '/',
                 extra_members=(), file_mode=0o644):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo(prefix.rstrip('/'))
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        archive.addfile(info)
        for name, data in files.items():
            info = tarfile.TarInfo(prefix + name)
            info.size = len(data)
            info.mode = file_mode
            archive.addfile(info, io.BytesIO(data))
        for info, data in extra_members:
            archive.addfile(info, io.BytesIO(data) if data is not None else None)
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

    def test_beta_only_repository_requires_explicit_tag(self):
        url = bootstrap.API + '/releases/latest'
        fetch = mock.Mock(side_effect=urllib.error.HTTPError(
            url, 404, 'Not Found', None, None))

        with self.assertRaisesRegex(
            bootstrap.Failure, r'для beta укажите тег явно'
        ):
            bootstrap.latest_release_tag(fetch)

        fetch.assert_called_once_with(url)

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

        # macOS disposable fixture ancestors are not production
        # root-owned Linux installation directories.
        parent_guard = mock.patch.object(
            bootstrap, 'assert_trusted_release_destination')
        parent_guard.start()
        self.addCleanup(parent_guard.stop)

    def dest(self):
        return tempfile.TemporaryDirectory()

    def test_retained_release_evidence_verifies_offline(self):
        routes = release_routes()

        with self.dest() as directory:
            original = bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            evidence = Path(directory) / bootstrap.EVIDENCE_DIR

            self.assertEqual(
                (evidence / bootstrap.EVIDENCE_LOCK).read_bytes(),
                routes[bootstrap.RELEASES + TAG + '/release-lock.json'],
            )

            self.assertEqual(
                (evidence / bootstrap.EVIDENCE_SIGNATURE).read_bytes(),
                routes[bootstrap.RELEASES + TAG + '/release-lock.json.sig'],
            )

            with mock.patch.object(
                bootstrap, 'real_fetch',
                side_effect=AssertionError('network forbidden'),
            ):
                self.assertEqual(
                    bootstrap.verify_local_release(directory),
                    original,
                )

    def test_generator_requires_exact_signed_image_pair(self):
        spec = importlib.util.spec_from_file_location(
            'generate_for_release_test',
            Path(__file__).with_name('generate.py'),
        )

        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)

        routes = release_routes()

        with self.dest() as directory:
            root = Path(directory).resolve()

            verified = bootstrap.fetch_signed(
                TAG, str(root), fetch=canned_fetch(routes))

            config = {
                'project_root': str(root),
                'update_channel': 'release',
                'backend_image': verified['images']['backend'],
                'frontend_image': verified['images']['frontend'],
            }

            with mock.patch.object(
                generator, 'load_release_bootstrap',
                return_value=bootstrap,
            ):
                generator.assert_install_identity(config, root)

                for role in ('backend', 'frontend'):
                    with self.subTest(role=role):
                        modified = dict(config)
                        modified[role + '_image'] = (
                            'ghcr.io/sv3t0v1k/homecloud/' + role
                            + '@sha256:' + 'f' * 64
                        )

                        with self.assertRaisesRegex(
                            generator.Refusal,
                            'differs from signed lock',
                        ):
                            generator.assert_install_identity(
                                modified, root)

                evidence = root / bootstrap.EVIDENCE_DIR
                (evidence / bootstrap.EVIDENCE_SIGNATURE).unlink()

                with self.assertRaises(generator.Refusal):
                    generator.assert_install_identity(config, root)

    def test_tampered_retained_lock_rejected(self):
        routes = release_routes()

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            path = (
                Path(directory) / bootstrap.EVIDENCE_DIR
                / bootstrap.EVIDENCE_LOCK
            )

            lock = json.loads(path.read_text())
            lock['images']['backend']['digest'] = 'sha256:' + 'f' * 64
            path.write_text(json.dumps(lock))

            with self.assertRaises(bootstrap.Failure):
                bootstrap.verify_local_release(directory)

    def test_missing_retained_evidence_rejected(self):
        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.verify_local_release(directory)

    def test_symlinked_evidence_rejected(self):
        with self.dest() as directory:
            root = Path(directory)
            foreign = root / 'foreign'
            foreign.mkdir()

            (root / bootstrap.EVIDENCE_DIR).symlink_to(
                foreign, target_is_directory=True)

            with self.assertRaises(bootstrap.Failure):
                bootstrap.verify_local_release(directory)

    def test_archive_cannot_supply_release_evidence(self):
        files = dict(INSTALLER_FILES)
        files[bootstrap.EVIDENCE_DIR + '/release-lock.json'] = b'fake'

        routes = release_routes(files=files)

        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_release_extracts_only_deployment_allowlist(self):
        files = dict(INSTALLER_FILES)
        files['.env'] = b'RELEASE_BACKEND_IMAGE=untrusted'
        files['backend/evil.py'] = b'unsigned content'
        files['docker-compose.override.yml'] = b'unsigned override'

        routes = release_routes()
        routes[bootstrap.CODELOAD + TAG] = make_tarball(
            files, file_mode=0o7777)

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            root = Path(directory)

            actual = {
                str(path.relative_to(root))
                for path in root.rglob('*')
                if path.is_file()
            }

            expected = set(bootstrap.USER_DEPLOYMENT_PATHS) | {
                bootstrap.EVIDENCE_DIR + '/' + bootstrap.EVIDENCE_LOCK,
                bootstrap.EVIDENCE_DIR + '/' + bootstrap.EVIDENCE_SIGNATURE,
            }

            self.assertEqual(actual, expected)

            for name in bootstrap.USER_DEPLOYMENT_PATHS:
                mode = (root / name).stat().st_mode & 0o7777

                self.assertEqual(
                    mode, 0o755 if name.endswith('.sh') else 0o644)

    def test_duplicate_release_member_rejected(self):
        payload = INSTALLER_FILES['deploy/user/install.sh']

        duplicate = tarfile.TarInfo(
            'homecloud-' + TAG + '/deploy/user/install.sh')
        duplicate.size = len(payload)

        routes = release_routes()
        routes[bootstrap.CODELOAD + TAG] = make_tarball(
            INSTALLER_FILES,
            extra_members=[(duplicate, payload)],
        )

        with self.dest() as directory:
            with self.assertRaisesRegex(
                bootstrap.Failure, 'дублирующийся путь'
            ):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_required_symlink_rejected(self):
        name = 'deploy/linux/startup-gate.sh'
        files = dict(INSTALLER_FILES)
        del files[name]

        link = tarfile.TarInfo('homecloud-' + TAG + '/' + name)
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'

        routes = release_routes()
        routes[bootstrap.CODELOAD + TAG] = make_tarball(
            files, extra_members=[(link, None)])

        with self.dest() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_deployment_parent_conflict_rejected(self):
        files = dict(INSTALLER_FILES)
        files['deploy/linux'] = b'not a directory'

        routes = release_routes()
        routes[bootstrap.CODELOAD + TAG] = make_tarball(files)

        with self.dest() as directory:
            with self.assertRaisesRegex(
                bootstrap.Failure, 'конфликт файла и каталога'
            ):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_every_deployment_file_must_be_signed(self):
        for name in bootstrap.USER_DEPLOYMENT_PATHS:
            with self.subTest(name=name):
                _, payload = make_lock()

                lock = json.loads(payload)
                del lock['source_files'][name]
                payload = json.dumps(lock).encode()

                routes = release_routes()
                routes[bootstrap.RELEASES + TAG + '/release-lock.json'] = payload
                routes[bootstrap.RELEASES + TAG + '/release-lock.json.sig'] = (
                    openssl_sign(payload).encode()
                )

                with self.dest() as directory:
                    with self.assertRaises(bootstrap.Failure):
                        bootstrap.fetch_signed(
                            TAG, directory, fetch=canned_fetch(routes))

                    self.assertEqual(list(Path(directory).iterdir()), [])

    def test_existing_destination_never_overwritten(self):
        routes = release_routes()

        with self.dest() as directory:
            existing = Path(directory) / 'existing'
            existing.write_bytes(b'preserved')

            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(
                    TAG, directory, fetch=canned_fetch(routes))

            self.assertEqual(existing.read_bytes(), b'preserved')
            self.assertEqual(list(Path(directory).iterdir()), [existing])

    def test_every_local_deployment_file_is_hash_verified(self):
        routes = release_routes()

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            root = Path(directory)

            for name in bootstrap.USER_DEPLOYMENT_PATHS:
                with self.subTest(name=name):
                    target = root / name
                    original = target.read_bytes()

                    try:
                        target.write_bytes(original + b"tampered")

                        with self.assertRaisesRegex(
                            bootstrap.Failure,
                            'хэш локального deployment не совпадает',
                        ):
                            bootstrap.verify_local_release(directory)
                    finally:
                        target.write_bytes(original)

            bootstrap.verify_local_release(directory)

    def test_extra_local_files_and_directories_rejected(self):
        routes = release_routes()

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            root = Path(directory)

            for name in ('.env', 'docker-compose.override.yml',
                         'deploy/user/unknown.py'):
                with self.subTest(name=name):
                    target = root / name
                    target.write_bytes(b'untrusted')

                    try:
                        with self.assertRaisesRegex(
                            bootstrap.Failure, 'посторонний путь'
                        ):
                            bootstrap.verify_local_release(directory)
                    finally:
                        target.unlink()

            extra = root / 'unexpected'
            extra.mkdir()

            try:
                with self.assertRaises(bootstrap.Failure):
                    bootstrap.verify_local_release(directory)
            finally:
                extra.rmdir()

            bootstrap.verify_local_release(directory)

    def test_local_symlink_and_hardlink_rejected(self):
        routes = release_routes()

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            target = Path(directory) / 'deploy/linux/startup-gate.sh'
            original = target.read_bytes()

            with self.dest() as foreign_directory:
                foreign = Path(foreign_directory) / 'gate'
                foreign.write_bytes(original)
                foreign.chmod(0o755)

                target.unlink()
                target.symlink_to(foreign)

                try:
                    with self.assertRaises(bootstrap.Failure):
                        bootstrap.verify_local_release(directory)
                finally:
                    target.unlink()

                os.link(foreign, target)

                try:
                    with self.assertRaises(bootstrap.Failure):
                        bootstrap.verify_local_release(directory)
                finally:
                    target.unlink()

            target.write_bytes(original)
            target.chmod(0o755)

            bootstrap.verify_local_release(directory)

    def test_local_permissions_and_missing_files_rejected(self):
        routes = release_routes()

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            root = Path(directory)

            for name, mode in (
                ('deploy/user/install.sh', 0o777),
                ('docker-compose.yml', 0o666),
                (bootstrap.EVIDENCE_DIR, 0o755),
                (bootstrap.EVIDENCE_DIR + '/' +
                 bootstrap.EVIDENCE_LOCK, 0o644),
                ('deploy/linux', 0o777),
            ):
                with self.subTest(name=name):
                    target = root / name
                    original = target.stat().st_mode & 0o7777

                    try:
                        target.chmod(mode)

                        with self.assertRaises(bootstrap.Failure):
                            bootstrap.verify_local_release(directory)
                    finally:
                        target.chmod(original)

            target = root / 'deploy/linux/startup-gate.sh'
            target.unlink()

            with self.assertRaises(bootstrap.Failure):
                bootstrap.verify_local_release(directory)

    def test_local_lock_without_deployment_coverage_rejected(self):
        routes = release_routes()

        with self.dest() as directory:
            bootstrap.fetch_signed(
                TAG, directory, fetch=canned_fetch(routes))

            proof = Path(directory) / bootstrap.EVIDENCE_DIR

            lock = json.loads(
                (proof / bootstrap.EVIDENCE_LOCK).read_bytes())

            del lock['source_files']['deploy/linux/startup-gate.sh']

            payload = json.dumps(lock).encode()

            (proof / bootstrap.EVIDENCE_LOCK).write_bytes(payload)
            (proof / bootstrap.EVIDENCE_SIGNATURE).write_bytes(
                openssl_sign(payload).encode())

            with self.assertRaisesRegex(
                bootstrap.Failure, 'нет подписанного хэша'
            ):
                bootstrap.verify_local_release(directory)

    def test_explicit_signed_beta_without_stable_release(self):
        tag = 'v1.2.0-beta.1'
        routes = release_routes(tag=tag)
        url = bootstrap.API + '/releases/latest'
        routes[url] = urllib.error.HTTPError(
            url, 404, 'Not Found', None, None)

        fetch = mock.Mock(side_effect=canned_fetch(routes))

        with self.dest() as directory:
            result = bootstrap.fetch_signed(
                tag, directory, fetch=fetch)
            self.assertEqual(result['tag'], tag)
            self.assertEqual(
                bootstrap.verify_local_release(directory), result)

        self.assertNotIn(
            mock.call(url), fetch.call_args_list)

    def test_happy_extracts_and_reports_images(self):
        routes = release_routes()
        with self.dest() as directory:
            result = bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))
            self.assertEqual(result['tag'], TAG)
            self.assertEqual(
                result['images']['backend'],
                'ghcr.io/sv3t0v1k/homecloud/backend@sha256:' +
                hashlib.sha256((TAG + 'backend').encode()).hexdigest())
            for name in bootstrap.USER_DEPLOYMENT_PATHS:
                data = INSTALLER_FILES[name]
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

    def test_path_traversal_member_rejected(self):
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
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_signed(TAG, directory, fetch=canned_fetch(routes))

            self.assertFalse(os.path.exists(directory))


class FetchUnsignedTests(OpensslRequired):
    def test_unsigned_archive_cannot_supply_release_evidence(self):
        files = dict(INSTALLER_FILES)
        files[bootstrap.EVIDENCE_DIR + '/release-lock.json'] = b'fake'

        routes = {
            bootstrap.CODELOAD + 'test': make_tarball(files),
        }

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(bootstrap.Failure):
                bootstrap.fetch_unsigned(
                    'test', directory, fetch=canned_fetch(routes))

            self.assertEqual(list(Path(directory).iterdir()), [])

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
            with mock.patch.object(
                bootstrap, 'assert_trusted_release_destination'
            ):
                with mock.patch('urllib.request.urlopen',
                                side_effect=urllib.error.URLError('offline')) as fetch:
                    code = bootstrap.main(['fetch', '--tag', TAG, '--dest', directory])

                fetch.assert_called_once()
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


class LocalDeploymentTrustTests(unittest.TestCase):
    def test_parent_path_policy_rejects_untrusted_ancestors(self):
        good = mock.Mock(
            st_mode=bootstrap.stat.S_IFDIR | 0o755,
            st_uid=os.geteuid(),
        )

        unsafe = (
            mock.Mock(
                st_mode=bootstrap.stat.S_IFDIR | 0o777,
                st_uid=os.geteuid(),
            ),
            mock.Mock(
                st_mode=bootstrap.stat.S_IFLNK | 0o777,
                st_uid=os.geteuid(),
            ),
            mock.Mock(
                st_mode=bootstrap.stat.S_IFDIR | 0o755,
                st_uid=os.geteuid() + 10000,
            ),
        )

        with mock.patch.object(
            bootstrap.os, 'listxattr',
            return_value=[], create=True,
        ):
            with mock.patch.object(
                Path, 'lstat', return_value=good
            ):
                bootstrap.assert_trusted_release_destination(
                    '/opt/homecloud/repo')

            for item in unsafe:
                with self.subTest(mode=item.st_mode, uid=item.st_uid):
                    with mock.patch.object(
                        Path, 'lstat', return_value=item
                    ):
                        with self.assertRaises(bootstrap.Failure):
                            bootstrap.assert_trusted_release_destination(
                                '/opt/homecloud/repo')

        foreign = mock.Mock(
            st_mode=bootstrap.stat.S_IFREG | 0o644,
            st_uid=os.geteuid() + 10000,
            st_nlink=1,
        )

        with self.assertRaises(bootstrap.Failure):
            bootstrap.check_local_file_metadata(foreign, 0o644)


if __name__ == '__main__':
    unittest.main(verbosity=2)
