#!/usr/bin/env python3
"""Тесты update-worker.py: контракт заявки и статуса, доверие по подписи Ed25519,
откат после точки невозврата, протокол архивации с маркером.

Подпись в happy path создаётся настоящим scripts/ci/release.py (байтовая
совместимость с CI); чужая подпись — сырым openssl. Docker compose и HTTP
подменяются через Deps; chown/geteuid подменяются, проверки владельца
перенастраиваются на текущего пользователя через константы модуля.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timezone, timedelta

SPEC = importlib.util.spec_from_file_location(
    'update_worker', Path(__file__).with_name('update-worker.py'))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)

OPENSSL = os.environ.get('HOMECLOUD_OPENSSL', 'openssl')
RELEASE_PY = Path(__file__).resolve().parents[2] / 'scripts' / 'ci' / 'release.py'

# RFC 8032 Test 2 — релизный ключ тестов (как в scripts/ci/test-release-sign.py).
RFC_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
RFC_PUBLIC = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
# RFC 8032 Test 1 — чужой ключ.
FOREIGN_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
PKCS8_PREFIX = bytes.fromhex('302e020100300506032b657004220420')
SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
PRIVATE_DER = PKCS8_PREFIX + bytes.fromhex(RFC_SEED)
PUBLIC_B64 = base64.b64encode(SPKI_PREFIX + bytes.fromhex(RFC_PUBLIC)).decode()
FOREIGN_PRIVATE_DER = PKCS8_PREFIX + bytes.fromhex(FOREIGN_SEED)

REPO = 'acme/homecloud'
NOW = datetime(2026, 11, 25, 12, 0, 0, tzinfo=timezone.utc)
OLD_BACKEND = (
    'ghcr.io/' + REPO + '/backend@sha256:'
    + hashlib.sha256(b'v1.1.0:backend').hexdigest()
)
OLD_FRONTEND = (
    'ghcr.io/' + REPO + '/frontend@sha256:'
    + hashlib.sha256(b'v1.1.0:frontend').hexdigest()
)


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


def release_py_sign(payload, directory):
    """Подпись настоящим CI-подписантом: байтовая совместимость контракта."""
    lock_path = Path(directory) / 'release-lock.json'
    sig_path = Path(directory) / 'release-lock.json.sig'
    public_path = Path(directory) / 'public.b64'
    lock_path.write_bytes(payload)
    public_path.write_text(PUBLIC_B64 + '\n')
    env = dict(os.environ)
    env['RELEASE_SIGNING_PRIVATE_KEY_B64'] = base64.b64encode(PRIVATE_DER).decode()
    result = subprocess.run(
        [sys.executable, str(RELEASE_PY), 'sign-lock', '--lock', str(lock_path),
         '--signature', str(sig_path), '--public-key', str(public_path)],
        capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise AssertionError('release.py sign-lock failed: ' + result.stderr)
    return sig_path.read_text().strip()


def fixture_deployment_hashes():
    return {
        name: hashlib.sha256(('fixture:' + name).encode()).hexdigest()
        for name in worker.USER_DEPLOYMENT_PATHS
    }


def make_lock(tag='v1.2.0', migrations=('20260101000000Init',),
              commit=None, source_files=None):
    commit = commit or hashlib.sha256(('commit:' + tag).encode()).hexdigest()[:40]
    hashes = dict(
        fixture_deployment_hashes()
        if source_files is None else source_files
    )

    for migration in migrations:
        hashes.setdefault(
            'backend/src/migrations/' + migration + '.ts',
            hashlib.sha256(migration.encode()).hexdigest(),
        )

    lock = {
        'format': 'homecloud-ci-candidate-v1',
        'repository': REPO,
        'tag_object': 'c' * 40,
        'deployment_status': 'NOT_DEPLOYED',
        'ci': {
            'status': 'success',
            'run_id': '1',
            'attempt': '1',
            'url': 'https://github.com/' + REPO + '/actions/runs/1',
        },
        'production_qualification': {
            'format': 'homecloud-production-qualification-v2',
            'status': 'PASS',
            'coverage': 'COVERED',
            'qualification_profile': 'release',
            'source_commit': commit,
            'ci': {'run_id': '1', 'attempt': '1'},
        },
        'tag': tag,
        'commit': commit,
        'schema_migrations': list(migrations),
        'source_files': hashes,
        'images': {
            role: {
                'repository': 'ghcr.io/' + REPO + '/' + role,
                'digest': 'sha256:' + hashlib.sha256((tag + ':' + role).encode()).hexdigest(),
                'revision': commit,
                'version': tag,
                'platform': 'linux/amd64',
                'provenance_verification': {
                    'index_digest': 'sha256:' + hashlib.sha256(
                        (tag + ':' + role).encode()).hexdigest(),
                    'verified':
                        'DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS',
                },
            } for role in ('backend', 'frontend')
        },
    }
    lock['manifest_sha256'] = hashlib.sha256(
        worker.canonical(dict(lock)).encode()).hexdigest()
    payload = (json.dumps(lock, indent=2, ensure_ascii=False) + '\n').encode()
    return lock, payload


def github_routes(payload, signature_b64, extra_releases=()):
    releases = list(extra_releases) + [{
        'draft': False,
        'tag_name': json.loads(payload)['tag'],
        'assets': [
            {'name': 'release-lock.json',
             'url': 'https://api.github.com/repos/' + REPO + '/releases/assets/111'},
            {'name': 'release-lock.json.sig',
             'url': 'https://api.github.com/repos/' + REPO + '/releases/assets/222'},
        ],
    }]
    return {
        'https://api.github.com/repos/' + REPO + '/releases?per_page=20':
            (200, {}, json.dumps(releases).encode()),
        'https://api.github.com/repos/' + REPO + '/releases/assets/111': (200, {}, payload),
        'https://api.github.com/repos/' + REPO + '/releases/assets/222':
            (200, {}, signature_b64.encode()),
    }


class FakeDeps:
    """Подменённые побочные эффекты: openssl выполняется по-настоящему,
    docker compose и HTTP — записью и сценарными ответами."""

    def __init__(self, routes=None, compose_failures=None, smoke_statuses=(200,),
                 moment=NOW, registry_digests=None):
        self.routes = routes or {}
        self.compose_failures = compose_failures or {}
        self.smoke_statuses = list(smoke_statuses)
        self.moment = moment
        self.registry_digests = registry_digests or {}
        self.compose_calls = []
        self.smoke_calls = []
        self.http_calls = []
        self.readonly_calls = []
        self.actual_migrations = ['20260101000000Init']
        self.inspected_image_override = None
        self.runtime_path = None

    def run(self, args, **kwargs):
        args = list(args)
        if 'pkeyutl' in args:
            return subprocess.run(args, capture_output=True, timeout=60)
        # docker compose --project-directory .. --env-file .. -f .. -f .. -f .. <sub> ...
        if 'inspect' in args:
            self.readonly_calls.append(['inspect', args[-1]])

            role = 'backend' if args[-1] == 'a' * 64 else 'frontend'

            values = dict(
                line.split('=', 1)
                for line in self.runtime_path.read_text().splitlines()
                if '=' in line
            )

            ref = (
                self.inspected_image_override
                or values['RELEASE_' + role.upper() + '_IMAGE']
            )

            return subprocess.CompletedProcess(
                args, 0,
                stdout=(ref + ' running healthy').encode(),
            )

        index = max(i for i, item in enumerate(args) if item == '-f') + 2
        sub = args[index:]

        if sub[0] == 'ps':
            self.readonly_calls.append(sub)
            self.runtime_path = Path(
                args[args.index('--env-file') + 1])

            container = 'a' if sub[-1] == 'backend' else 'b'

            return subprocess.CompletedProcess(
                args, 0, stdout=(container * 64).encode())

        if sub[0] == 'exec':
            self.readonly_calls.append(sub)

            return subprocess.CompletedProcess(
                args, 0,
                stdout='\n'.join(self.actual_migrations).encode(),
            )

        self.compose_calls.append(sub)
        queue = self.compose_failures.get(sub[0], [])
        code = queue.pop(0) if queue else 0
        return subprocess.CompletedProcess(args, code)

    def http_get(self, url, headers=None):
        self.http_calls.append(url)
        if url.startswith('https://ghcr.io/token?'):
            return 200, {}, json.dumps({'token': 'registry-token'}).encode()
        if url.startswith('https://ghcr.io/v2/'):
            digest = url.rsplit('/', 1)[1]
            return 200, {'Docker-Content-Digest': self.registry_digests.get(digest, digest)}, b''
        if url in self.routes:
            return self.routes[url]
        raise AssertionError('unexpected URL: ' + url)

    def now(self):
        return self.moment

    def smoke_get(self, url, host_header):
        self.smoke_calls.append((url, host_header))
        if len(self.smoke_statuses) > 1:
            return self.smoke_statuses.pop(0)
        return self.smoke_statuses[0]


class DockerAuthorityTests(unittest.TestCase):
    def test_local_docker_authority_and_clean_environment(self):
        config = {
            'docker_config': '/etc/homecloud/docker',
            'compose_project_dir': '/opt/homecloud/repo',
            'runtime_env': '/etc/homecloud/runtime.env',
        }

        with mock.patch.dict(os.environ, {
            'DOCKER_HOST': 'ssh://untrusted',
            'DOCKER_CONTEXT': 'untrusted',
            'DOCKER_CONFIG': '/untrusted/docker',
            'COMPOSE_PROJECT_NAME': 'untrusted',
        }):
            deps = mock.Mock()
            deps.run.return_value.returncode = 0

            worker.compose(config, deps, 'pull')

        args, kwargs = deps.run.call_args

        self.assertEqual(
            args[0][:6],
            ['docker', '--config', '/etc/homecloud/docker',
             '--host', 'unix:///var/run/docker.sock', 'compose'],
        )
        self.assertEqual(
            kwargs['env'],
            {'HOME': '/root', 'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'},
        )
        self.assertEqual(args[0][-1], 'pull')


class WorkerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            version = subprocess.check_output([OPENSSL, 'version'], text=True,
                                              stderr=subprocess.PIPE).strip()
        except OSError:
            raise unittest.SkipTest('OpenSSL недоступен: ' + OPENSSL)
        if not version.startswith('OpenSSL 3.'):
            raise unittest.SkipTest('требуется OpenSSL 3.x, получен: ' + version)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.base = root / 'update'
        (self.base / 'inbox').mkdir(parents=True)
        (self.base / 'status').mkdir(parents=True)
        self.project = (root / 'project').resolve()
        self.project.mkdir()

        for name in worker.USER_DEPLOYMENT_PATHS:
            target = self.project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(('fixture:' + name).encode())
            target.chmod(0o755 if name.endswith('.sh') else 0o644)

        evidence = self.project / worker.RELEASE_EVIDENCE_DIR
        evidence.mkdir(mode=0o700)
        evidence.chmod(0o700)

        _, payload = make_lock(tag='v1.1.0')

        self.proof_lock = evidence / 'release-lock.json'
        self.proof_sig = evidence / 'release-lock.json.sig'

        self.proof_lock.write_bytes(payload)
        self.proof_sig.write_text(openssl_sign(payload))

        self.proof_lock.chmod(0o600)
        self.proof_sig.chmod(0o600)
        etc = root / 'etc'
        etc.mkdir()
        (etc / 'docker').mkdir()
        self.env_path = etc / 'runtime.env'
        self.config_path = etc / 'update-worker.json'
        self.key_path = etc / 'release-public.b64'
        self.token_path = etc / 'github-token'
        self.key_path.write_text(PUBLIC_B64 + '\n')
        self.config_path.write_text(json.dumps({
            'format': 'homecloud-user-update-worker-v1',
            'compose_project_dir': str(self.project),
            'runtime_env': str(self.env_path),
            'docker_config': str(etc / 'docker'),
            'public_host': 'cloud.example.com',
            'https_port': 443,
            'repositories': [REPO],
        }))
        os.chmod(self.config_path, 0o600)
        patches = [
            mock.patch.object(worker, 'BASE_DIR', self.base),
            # External macOS fixture ancestors are not Linux root paths.
            # All deployment files and internal directories remain real.
            mock.patch.object(worker, 'verify_deployment_parents'),
            mock.patch.object(worker, 'CONFIG_PATH', self.config_path),
            mock.patch.object(worker, 'PUBLIC_KEY_PATH', self.key_path),
            mock.patch.object(worker, 'TOKEN_PATH', self.token_path),
            mock.patch.object(worker, 'ROOT_UID', os.getuid()),
            mock.patch.object(worker, 'ROOT_GID', os.getgid()),
            mock.patch.object(worker, 'BACKEND_UID', os.getuid()),
            mock.patch.object(worker, 'GID', os.getgid()),
            mock.patch('os.geteuid', return_value=0),
            mock.patch('os.fchown', lambda *args: None),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def write_env(self, backend_ref=OLD_BACKEND, frontend_ref=OLD_FRONTEND):
        self.env_path.write_text('RELEASE_BACKEND_IMAGE=' + backend_ref + '\n'
                                 'RELEASE_FRONTEND_IMAGE=' + frontend_ref + '\n'
                                 'PUBLIC_BIND_IP=192.168.1.10\n'
                                 'OTHER_KEY=keep\n')
        os.chmod(self.env_path, 0o600)
        return self.env_path

    def read_env(self):
        return self.env_path.read_text()

    def write_installed_lock(self, tag='v1.1.0', migrations=('20260101000000Init',)):
        _, payload = make_lock(tag=tag, migrations=migrations)
        path = self.base / 'status' / 'installed-lock.json'
        path.write_bytes(payload)
        os.chmod(path, 0o640)

    def write_request(self, identity):
        path = self.base / 'inbox' / 'request.json'
        path.write_text(json.dumps({'format': 'homecloud-update-request-v1',
                                    'channel': 'release',
                                    'manifestSha256': identity}) + '\n')
        os.chmod(path, 0o600)

    def write_receipt(self, status='INSTALLED', phase='COMPLETE', identity='a' * 64,
                      updated='2026-11-25T11:00:00+00:00'):
        receipt = {'format': 'homecloud-update-status-v1', 'status': status,
                   'manifestSha256': identity, 'phase': phase, 'updatedAt': updated}
        path = self.base / 'status' / 'current.json'
        path.write_text(json.dumps(receipt) + '\n')
        os.chmod(path, 0o640)
        return receipt

    def read_status(self):
        return json.loads((self.base / 'status' / 'current.json').read_text())

    def candidate_deps(self, tag='v1.2.0', signer=None, **kwargs):
        """Заявка + маршруты GitHub для кандидата; возвращает (lock, payload, deps)."""
        lock, payload = make_lock(tag=tag, migrations=kwargs.pop(
            'migrations', ('20260101000000Init',)))
        signature = signer(payload) if signer else openssl_sign(payload)
        self.write_request(lock['manifest_sha256'])
        deps = FakeDeps(github_routes(payload, signature), **kwargs)
        return lock, payload, deps


class InstallTests(WorkerCase):
    def test_tampered_local_deployment_blocks_update(self):
        self.write_env()
        self.write_installed_lock()
        before = self.read_env()

        (self.project / 'deploy/linux/startup-gate.sh').write_bytes(
            b'tampered')

        _, _, deps = self.candidate_deps()

        with self.assertRaisesRegex(
            worker.Refusal, 'local deployment hash mismatch'
        ):
            worker.install(deps)

        self.assertEqual(self.read_env(), before)
        self.assertEqual(deps.compose_calls, [])
        self.assertEqual(self.read_status()['status'], 'STOP')

    def test_extra_deployment_file_blocks_update(self):
        self.write_env()
        self.write_installed_lock()
        (self.project / '.env').write_text('unexpected=value')

        _, _, deps = self.candidate_deps()

        with self.assertRaisesRegex(
            worker.Refusal, 'unexpected deployment path'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])
        self.assertEqual(self.read_status()['status'], 'STOP')

    def test_changed_signed_deployment_blocks_image_update(self):
        self.write_env()
        self.write_installed_lock()
        before = self.read_env()

        sources = fixture_deployment_hashes()
        sources['deploy/linux/startup-gate.sh'] = 'f' * 64

        lock, payload = make_lock(source_files=sources)

        self.write_request(lock['manifest_sha256'])

        deps = FakeDeps(github_routes(
            payload, openssl_sign(payload)))

        with self.assertRaisesRegex(
            worker.Refusal, 'manual deployment update required'
        ):
            worker.install(deps)

        self.assertEqual(self.read_env(), before)
        self.assertEqual(deps.compose_calls, [])
        self.assertEqual(self.read_status()['status'], 'STOP')

    def test_installer_only_changes_allow_image_update(self):
        self.write_env()
        self.write_installed_lock()

        sources = fixture_deployment_hashes()
        sources['deploy/user/install.sh'] = 'f' * 64

        lock, payload = make_lock(source_files=sources)

        self.write_request(lock['manifest_sha256'])

        deps = FakeDeps(github_routes(
            payload, openssl_sign(payload)))

        worker.install(deps)

        self.assertEqual(self.read_status()['status'], 'INSTALLED')
        self.assertEqual(
            [call[0] for call in deps.compose_calls],
            ['pull', 'up'],
        )

    def test_stable_version_is_newer_than_beta(self):
        self.assertGreater(
            worker.version_key('v1.2.0'),
            worker.version_key('v1.2.0-beta.99'),
        )
        self.assertGreater(
            worker.version_key('v1.2.0-beta.10'),
            worker.version_key('v1.2.0-beta.9'),
        )

    def test_changed_migration_contents_refused(self):
        self.write_env()
        self.write_installed_lock()

        sources = fixture_deployment_hashes()
        sources[
            'backend/src/migrations/20260101000000Init.ts'
        ] = 'f' * 64

        lock, payload = make_lock(source_files=sources)
        self.write_request(lock['manifest_sha256'])

        deps = FakeDeps(github_routes(
            payload, openssl_sign(payload)))

        with self.assertRaisesRegex(
            worker.Refusal, 'migration contents differ'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])
        self.assertFalse(worker.journal_exists())

    def test_actual_database_schema_mismatch_refused(self):
        self.write_env()
        self.write_installed_lock()

        _, _, deps = self.candidate_deps()
        deps.actual_migrations.append('UnexpectedMigration')

        with self.assertRaisesRegex(
            worker.Refusal, 'actual database migrations differ'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])
        self.assertFalse(worker.journal_exists())

    def test_runtime_digest_mismatch_refused(self):
        self.write_env(
            backend_ref='ghcr.io/' + REPO +
            '/backend@sha256:' + 'f' * 64
        )
        self.write_installed_lock()

        _, _, deps = self.candidate_deps()

        with self.assertRaisesRegex(
            worker.Refusal, 'runtime image references differ'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])

    def test_running_container_identity_mismatch_refused(self):
        self.write_env()
        self.write_installed_lock()

        _, _, deps = self.candidate_deps()
        deps.inspected_image_override = 'foreign/image:latest'

        with self.assertRaisesRegex(
            worker.Refusal, 'unexpected running image'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])

    def test_duplicate_environment_key_refused(self):
        self.write_env()
        self.write_installed_lock()

        with self.env_path.open('a') as stream:
            stream.write(
                'RELEASE_BACKEND_IMAGE=' + OLD_BACKEND + '\n')

        _, _, deps = self.candidate_deps()

        with self.assertRaisesRegex(
            worker.Refusal, 'duplicate runtime environment key'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])

    def test_http_404_causes_rollback(self):
        self.write_env()
        self.write_installed_lock()

        _, _, deps = self.candidate_deps(
            smoke_statuses=[404, 200])

        with self.assertRaises(worker.RecoveryRequired):
            worker.install(deps)

        self.assertEqual(self.read_status()['status'], 'STOP')
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertFalse(worker.journal_exists())

    def test_crash_after_reference_switch_recovers_from_timer(self):
        self.write_env()
        self.write_installed_lock()

        path = worker.installed_lock_path()
        previous = path.read_bytes()

        _, _, deps = self.candidate_deps()
        switch = worker.switch_images

        def crash(config, lock):
            self.assertTrue(worker.journal_exists())
            switch(config, lock)
            raise KeyboardInterrupt('simulated process crash')

        with mock.patch.object(
            worker, 'switch_images', side_effect=crash
        ):
            with self.assertRaises(KeyboardInterrupt):
                worker.install(deps)

        self.assertTrue(worker.journal_exists())
        self.assertNotIn(OLD_BACKEND + '\n', self.read_env())

        recovery = FakeDeps()
        worker.archive(recovery)

        self.assertEqual(path.read_bytes(), previous)
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertEqual(self.read_status()['status'], 'STOP')
        self.assertEqual(recovery.compose_calls[0][0], 'up')
        self.assertFalse(worker.journal_exists())

    def test_crash_after_installed_lock_write_restores_old_release(self):
        self.write_env()
        self.write_installed_lock()

        path = worker.installed_lock_path()
        previous = path.read_bytes()

        _, _, deps = self.candidate_deps()
        write = worker.write_installed_lock

        def crash(payload):
            write(payload)
            raise KeyboardInterrupt('crash after installed lock write')

        with mock.patch.object(
            worker, 'write_installed_lock', side_effect=crash
        ):
            with self.assertRaises(KeyboardInterrupt):
                worker.install(deps)

        self.assertTrue(worker.journal_exists())
        self.assertNotEqual(path.read_bytes(), previous)

        worker.archive(FakeDeps())

        self.assertEqual(path.read_bytes(), previous)
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertFalse(worker.journal_exists())

    def test_crash_after_terminal_receipt_does_not_rollback(self):
        self.write_env()
        self.write_installed_lock()

        _, payload, deps = self.candidate_deps()

        with mock.patch.object(
            worker, 'clear_journal',
            side_effect=KeyboardInterrupt('crash before journal cleanup'),
        ):
            with self.assertRaises(KeyboardInterrupt):
                worker.install(deps)

        self.assertTrue(worker.journal_exists())
        self.assertEqual(
            self.read_status()['status'], 'INSTALLED')

        recovery = FakeDeps()
        worker.archive(recovery)

        self.assertEqual(recovery.compose_calls, [])
        self.assertEqual(
            worker.installed_lock_path().read_bytes(), payload)
        self.assertFalse(worker.journal_exists())

    def test_failed_recovery_retains_transaction(self):
        self.write_env()
        self.write_installed_lock()

        _, _, deps = self.candidate_deps(
            compose_failures={'up': [1, 1]})

        with self.assertRaises(worker.RecoveryRequired):
            worker.install(deps)

        self.assertTrue(worker.journal_exists())
        self.assertEqual(
            self.read_status()['status'],
            'MANUAL_RECOVERY_REQUIRED',
        )

        recovery = FakeDeps()
        worker.archive(recovery)

        self.assertTrue(worker.journal_exists())
        self.assertEqual(recovery.compose_calls, [])

    def test_timer_reconciles_stale_receipt_without_request(self):
        old = (NOW - timedelta(minutes=45)).isoformat()

        self.write_receipt(
            status='RUNNING', phase='VERIFY_TRUST', updated=old)

        worker.archive(FakeDeps())

        self.assertEqual(
            self.read_status()['status'],
            'MANUAL_RECOVERY_REQUIRED',
        )

    def test_unqualified_release_is_rejected(self):
        self.write_env()
        self.write_installed_lock()

        lock, _ = make_lock()
        lock['production_qualification']['status'] = 'BLOCKED'
        lock.pop('manifest_sha256')

        lock['manifest_sha256'] = hashlib.sha256(
            worker.canonical(lock).encode()).hexdigest()

        payload = json.dumps(lock).encode()
        self.write_request(lock['manifest_sha256'])

        deps = FakeDeps(github_routes(
            payload, openssl_sign(payload)))

        with self.assertRaisesRegex(
            worker.Refusal, 'release qualification required'
        ):
            worker.install(deps)

        self.assertEqual(deps.compose_calls, [])

    def test_happy_path_installs_signed_release(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        with tempfile.TemporaryDirectory() as directory:
            lock, payload = make_lock(tag='v1.2.0')
            signature = release_py_sign(payload, directory)  # подпись настоящим CI
            self.write_request(lock['manifest_sha256'])
            deps = FakeDeps(github_routes(payload, signature))
            worker.install(deps)
        status = self.read_status()
        self.assertEqual(status['status'], 'INSTALLED')
        self.assertEqual(status['phase'], 'COMPLETE')
        self.assertEqual(status['manifestSha256'], lock['manifest_sha256'])
        env = self.read_env()
        for role in ('backend', 'frontend'):
            image = lock['images'][role]
            self.assertIn('RELEASE_' + role.upper() + '_IMAGE=' +
                          image['repository'] + '@' + image['digest'] + '\n', env)
        self.assertIn('OTHER_KEY=keep\n', env)
        self.assertEqual((self.base / 'status' / 'installed-lock.json').read_bytes(), payload)
        self.assertFalse((self.base / 'inbox' / 'request.json').exists())
        self.assertEqual([call[0] for call in deps.compose_calls], ['pull', 'up'])
        for call in deps.compose_calls:
            if call[0] == 'up':
                self.assertIn('--no-build', call)
        self.assertEqual(deps.smoke_calls, [('https://192.168.1.10:443/', 'cloud.example.com')])

    def test_fifo_request_is_rejected_without_blocking(self):
        self.write_env()
        self.write_installed_lock()

        request = self.base / 'inbox' / 'request.json'
        os.mkfifo(request, 0o600)

        real_open = os.open

        def guarded_open(path, flags, *args, **kwargs):
            if Path(path) == request:
                self.assertTrue(flags & os.O_NONBLOCK)

            return real_open(path, flags, *args, **kwargs)

        deps = FakeDeps()

        with mock.patch.object(
            worker.os, 'open', side_effect=guarded_open
        ):
            with self.assertRaises(worker.Refusal):
                worker.install(deps)

        self.assertEqual(deps.compose_calls, [])
        self.assertFalse(worker.journal_exists())

    def test_no_request_is_noop(self):
        worker.install(FakeDeps())
        self.assertFalse((self.base / 'status' / 'current.json').exists())

    def test_foreign_signature_rejected(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        lock, payload, deps = self.candidate_deps(
            signer=lambda data: openssl_sign(data, FOREIGN_PRIVATE_DER))
        with self.assertRaises(worker.Refusal):
            worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']), ('STOP', 'PREPARATION'))
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertEqual(deps.compose_calls, [])

    def test_missing_signature_asset_rejected(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        _, payload, deps = self.candidate_deps()
        url = 'https://api.github.com/repos/' + REPO + '/releases?per_page=20'
        releases = json.loads(deps.routes[url][2])
        releases[0]['assets'] = releases[0]['assets'][:1]
        deps.routes[url] = (200, {}, json.dumps(releases).encode())
        with self.assertRaises(worker.Refusal):
            worker.install(deps)
        self.assertEqual(self.read_status()['status'], 'STOP')
        self.assertEqual(deps.compose_calls, [])

    def test_unknown_identity_rejected(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        _, payload = make_lock(tag='v1.2.0')
        self.write_request('f' * 64)  # релиз с такой идентичностью не публиковался
        deps = FakeDeps(github_routes(payload, openssl_sign(payload)))
        with self.assertRaises(worker.Refusal):
            worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']), ('STOP', 'PREPARATION'))
        self.assertEqual(deps.compose_calls, [])

    def test_missing_installed_lock_rejected(self):
        self.write_env()
        _, _, deps = self.candidate_deps()
        with self.assertRaises(worker.Refusal) as caught:
            worker.install(deps)
        self.assertIn('not bootstrapped', str(caught.exception))
        self.assertEqual(self.read_status()['status'], 'STOP')

    def test_different_migrations_rejected(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0', migrations=('20260101000000Init',))
        _, _, deps = self.candidate_deps(
            migrations=('20260101000000Init', '20260202000000Second'))
        with self.assertRaises(worker.Refusal):
            worker.install(deps)
        self.assertEqual(self.read_status()['status'], 'STOP')
        self.assertEqual(deps.compose_calls, [])

    def test_older_candidate_rejected(self):
        self.write_env()
        self.write_installed_lock(tag='v1.2.0')
        _, _, deps = self.candidate_deps(tag='v1.1.0')
        with self.assertRaises(worker.Refusal):
            worker.install(deps)
        self.assertEqual(self.read_status()['status'], 'STOP')
        self.assertEqual(deps.compose_calls, [])

    def test_registry_digest_mismatch_rejected(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        lock, payload = make_lock(tag='v1.2.0')
        self.write_request(lock['manifest_sha256'])
        # Реестр отвечает другим дайджестом для backend-манифеста.
        fake = 'sha256:' + '0' * 64
        deps = FakeDeps(github_routes(payload, openssl_sign(payload)),
                        registry_digests={lock['images']['backend']['digest']: fake})
        with self.assertRaises(worker.Refusal):
            worker.install(deps)
        self.assertEqual(self.read_status()['status'], 'STOP')
        self.assertEqual(deps.compose_calls, [])

    def test_compose_up_failure_rolls_back(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        _, _, deps = self.candidate_deps(compose_failures={'up': [1]})
        with self.assertRaises(worker.RecoveryRequired):
            worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']), ('STOP', 'ROLLBACK'))
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertIn(OLD_FRONTEND + '\n', self.read_env())
        self.assertEqual([call[0] for call in deps.compose_calls], ['pull', 'up', 'up'])
        for call in deps.compose_calls:
            if call[0] == 'up':
                self.assertIn('--no-build', call)

    def test_pull_failure_rolls_back(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        _, _, deps = self.candidate_deps(compose_failures={'pull': [1]})
        with self.assertRaises(worker.RecoveryRequired):
            worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']), ('STOP', 'ROLLBACK'))
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertEqual([call[0] for call in deps.compose_calls], ['pull', 'up'])
        for call in deps.compose_calls:
            if call[0] == 'up':
                self.assertIn('--no-build', call)

    def test_rollback_failure_requires_manual_review(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        _, _, deps = self.candidate_deps(compose_failures={'up': [1, 1]})
        with self.assertRaises(worker.RecoveryRequired):
            worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']),
                         ('MANUAL_RECOVERY_REQUIRED', 'ROLLBACK'))

    def test_smoke_failure_rolls_back(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        _, _, deps = self.candidate_deps(smoke_statuses=[503, 200])
        with self.assertRaises(worker.RecoveryRequired):
            worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']), ('STOP', 'ROLLBACK'))
        self.assertIn(OLD_BACKEND + '\n', self.read_env())
        self.assertEqual(len(deps.smoke_calls), 2)

    def test_stale_running_receipt_escalates(self):
        old = (NOW - timedelta(minutes=45)).isoformat()
        self.write_receipt(status='RUNNING', phase='SMOKE', updated=old)
        self.write_request('b' * 64)
        deps = FakeDeps()
        worker.install(deps)
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']),
                         ('MANUAL_RECOVERY_REQUIRED', 'STALE_RUN'))
        self.assertTrue((self.base / 'inbox' / 'request.json').exists())
        self.assertEqual(deps.compose_calls, [])

    def test_active_receipt_blocks_install(self):
        recent = (NOW - timedelta(minutes=5)).isoformat()
        self.write_receipt(status='RUNNING', phase='SMOKE', updated=recent)
        self.write_request('b' * 64)
        worker.install(FakeDeps())
        status = self.read_status()
        self.assertEqual((status['status'], status['phase']), ('RUNNING', 'SMOKE'))
        self.assertTrue((self.base / 'inbox' / 'request.json').exists())

    def test_terminal_receipt_waits_for_archive(self):
        self.write_receipt(status='INSTALLED', phase='COMPLETE')
        self.write_request('b' * 64)
        worker.install(FakeDeps())
        self.assertEqual(self.read_status()['status'], 'INSTALLED')
        self.assertTrue((self.base / 'inbox' / 'request.json').exists())

    def test_invalid_config_rejected(self):
        self.config_path.write_text(json.dumps({'format': 'other'}) + '\n')
        os.chmod(self.config_path, 0o600)
        with self.assertRaises(worker.Refusal):
            worker.install(FakeDeps())
        self.assertFalse((self.base / 'status' / 'current.json').exists())


class BootstrapTests(WorkerCase):
    def install_lock(self):
        return self.base / 'status' / 'installed-lock.json'

    def test_bootstrap_binds_installed_release(self):
        lock, payload = make_lock(tag='v1.1.0')
        backend_ref = lock['images']['backend']['repository'] + '@' + lock['images']['backend']['digest']
        frontend_ref = lock['images']['frontend']['repository'] + '@' + lock['images']['frontend']['digest']
        self.write_env(backend_ref, frontend_ref)
        deps = FakeDeps(github_routes(payload, openssl_sign(payload)))
        worker.bootstrap(deps)
        self.assertEqual(deps.http_calls, [])

        self.assertTrue(deps.readonly_calls)
        self.assertIn(
            ('https://192.168.1.10:443/', 'cloud.example.com'),
            deps.smoke_calls,
        )

        self.assertEqual(self.install_lock().read_bytes(), payload)
        self.assertEqual(deps.compose_calls, [])
        self.assertFalse((self.base / 'status' / 'current.json').exists())

    def test_bootstrap_requires_actual_healthy_runtime(self):
        self.write_env()

        for failure in ('image', 'database', 'https'):
            with self.subTest(failure=failure):
                deps = FakeDeps()

                if failure == 'image':
                    deps.inspected_image_override = 'foreign/image:latest'
                elif failure == 'database':
                    deps.actual_migrations.append('UnexpectedMigration')
                else:
                    deps.smoke_statuses = [404]

                with self.assertRaises(worker.Refusal):
                    worker.bootstrap(deps)

                self.assertFalse(self.install_lock().exists())
                self.assertEqual(deps.compose_calls, [])

    def test_bootstrap_refuses_existing_lock(self):
        self.write_env()
        self.write_installed_lock(tag='v1.1.0')
        with self.assertRaises(worker.Refusal):
            worker.bootstrap(FakeDeps())

    def test_bootstrap_refuses_when_runtime_images_differ_from_signed_deployment(self):
        for role in ('backend', 'frontend'):
            with self.subTest(role=role):
                foreign_ref = (
                    'ghcr.io/' + REPO + '/' + role
                    + '@sha256:' + 'f' * 64
                )

                self.write_env(**{
                    role + '_ref': foreign_ref,
                })

                deps = FakeDeps()

                with self.assertRaisesRegex(
                    worker.Refusal,
                    'installed images differ from signed deployment',
                ):
                    worker.bootstrap(deps)

                self.assertFalse(self.install_lock().exists())
                self.assertEqual(deps.http_calls, [])
                self.assertEqual(deps.compose_calls, [])

    def test_bootstrap_refuses_foreign_signature(self):
        lock, payload = make_lock(tag='v1.1.0')
        backend_ref = lock['images']['backend']['repository'] + '@' + lock['images']['backend']['digest']
        frontend_ref = lock['images']['frontend']['repository'] + '@' + lock['images']['frontend']['digest']
        self.write_env(backend_ref, frontend_ref)
        foreign = openssl_sign(payload, FOREIGN_PRIVATE_DER)
        self.proof_sig.write_text(foreign)

        with self.assertRaises(worker.Refusal):
            worker.bootstrap(FakeDeps())
        self.assertFalse(self.install_lock().exists())

    def test_bootstrap_refuses_unpinned_refs(self):
        self.write_env('ghcr.io/' + REPO + '/backend:latest',
                       'ghcr.io/' + REPO + '/frontend:latest')
        with self.assertRaises(worker.Refusal):
            worker.bootstrap(FakeDeps())


class ArchiveTests(WorkerCase):
    def archive_dir(self):
        return self.base / 'status' / 'archive'

    def test_archive_rotates_installed_receipt(self):
        self.write_receipt()
        worker.archive(FakeDeps())
        self.assertFalse((self.base / 'status' / 'current.json').exists())
        self.assertFalse((self.base / 'status' / 'archiving.json').exists())
        archived = list(self.archive_dir().iterdir())
        self.assertEqual(len(archived), 1)
        value = json.loads(archived[0].read_text())
        self.assertEqual(value['status'], 'INSTALLED')

    def test_archive_without_receipt_is_noop(self):
        worker.archive(FakeDeps())
        self.assertFalse(self.archive_dir().exists())

    def test_interrupted_marker_write_does_not_block_next_archive(self):
        self.write_receipt()
        original_replace = worker.os.replace

        def interrupted(source, destination):
            if str(destination).endswith('/archiving.json'):
                raise OSError('simulated crash before durable marker')
            return original_replace(source, destination)

        with mock.patch.object(worker.os, 'replace', side_effect=interrupted):
            with self.assertRaises(OSError):
                worker.archive(FakeDeps())
        self.assertFalse((self.base / 'status' / 'archiving.json').exists())
        worker.archive(FakeDeps())
        self.assertFalse((self.base / 'status' / 'current.json').exists())
        self.assertEqual(len(list(self.archive_dir().iterdir())), 1)

    def test_short_marker_writes_publish_complete_json(self):
        receipt = self.write_receipt()
        name = worker.receipt_archive_name(receipt)
        original_write = worker.os.write

        def short_write(descriptor, data):
            return original_write(descriptor, bytes(data)[:3])

        with mock.patch.object(worker.os, 'write', side_effect=short_write):
            worker.create_marker(receipt['manifestSha256'], name)

        marker = json.loads((self.base / 'status' / 'archiving.json').read_text())
        self.assertEqual(marker['archiveName'], name)
        worker.archive(FakeDeps())
        self.assertFalse((self.base / 'status' / 'archiving.json').exists())

    def test_archive_manual_recovery_refused(self):
        self.write_receipt(status='MANUAL_RECOVERY_REQUIRED', phase='ROLLBACK')
        with self.assertRaises(worker.Refusal):
            worker.archive(FakeDeps())
        self.assertTrue((self.base / 'status' / 'current.json').exists())

    def test_archive_blocked_by_pending_request(self):
        self.write_receipt()
        self.write_request('b' * 64)
        with self.assertRaises(worker.Refusal):
            worker.archive(FakeDeps())
        self.assertTrue((self.base / 'status' / 'current.json').exists())

    def test_archive_resumes_after_crash_post_link(self):
        # Крах после hardlink, до удаления current.json: marker + обе копии.
        receipt = self.write_receipt()
        name = worker.receipt_archive_name(receipt)
        worker.create_marker(receipt['manifestSha256'], name)
        self.archive_dir().mkdir()
        os.link(self.base / 'status' / 'current.json', self.archive_dir() / name)
        worker.archive(FakeDeps())
        self.assertFalse((self.base / 'status' / 'current.json').exists())
        self.assertFalse((self.base / 'status' / 'archiving.json').exists())
        self.assertTrue((self.archive_dir() / name).exists())

    def test_archive_resumes_marker_only(self):
        # Крах после удаления current.json, до удаления marker.
        receipt = self.write_receipt()
        name = worker.receipt_archive_name(receipt)
        worker.create_marker(receipt['manifestSha256'], name)
        self.archive_dir().mkdir()
        os.link(self.base / 'status' / 'current.json', self.archive_dir() / name)
        os.unlink(self.base / 'status' / 'current.json')
        worker.archive(FakeDeps())
        self.assertFalse((self.base / 'status' / 'archiving.json').exists())

    def test_conflicting_marker_refused(self):
        receipt = self.write_receipt()
        worker.create_marker('c' * 64, 'c' * 64 + '-' + '0' * 16 + '.json')
        with self.assertRaises(worker.Refusal):
            worker.archive(FakeDeps())
        self.assertTrue((self.base / 'status' / 'current.json').exists())


if __name__ == '__main__':
    unittest.main()
