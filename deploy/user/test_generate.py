#!/usr/bin/env python3
"""Синтетические тесты generate.py: контракт артефактов без root и записи."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'generate', Path(__file__).with_name('generate.py'))
generate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generate)


def answers(**over):
    base = {
        'project_name': 'mycloud',
        'project_root': '/opt/mycloud',
        'public_host': '192.168.1.10',
        'public_bind_ip': '192.168.1.10',
        'http_port': 80,
        'https_port': 443,
        'layout': {
            'mode': 'two-disk',
            'db_dir': '/srv/ssd/mycloud/postgres',
            'storage_dir': '/srv/data/mycloud/storage',
            'db_uuid': 'ssd-uuid',
            'storage_uuid': 'hdd-uuid-1',
            'db_serial': 'SSD123',
            'storage_serial': 'HDD456',
            'db_mount': '/srv/ssd',
            'storage_mount': '/srv/data',
        },
        'backend_image': 'ghcr.io/acme/backend@sha256:' + 'a' * 64,
        'frontend_image': 'ghcr.io/acme/frontend@sha256:' + 'b' * 64,
        'postgres_uid': 70, 'postgres_gid': 70,
        'backend_uid': 1001, 'backend_gid': 65533,
        'install_root': '/opt/mycloud',
        'tls_cert_dir': '/opt/mycloud/.runtime/tls',
        'acme_webroot_dir': '/opt/mycloud/.runtime/acme',
        'ingress_subnet': '172.29.0.0/24', 'ingress_proxy_ip': '172.29.0.10',
        'backend_proxy_subnet': '172.30.0.0/24', 'frontend_proxy_ip': '172.30.0.10',
        'update_channel': 'release',
    }
    base.update(over)
    return base


class GenerateContractTests(unittest.TestCase):
    def build(self, **over):
        return generate.build(answers(**over))

    def test_env_has_all_compose_keys(self):
        plan = self.build()
        env = plan['files']['/etc/homecloud/runtime.env']['content']
        for key in generate.ENV_KEYS:
            self.assertIn(key + '=', env)
        self.assertNotIn('None', env)
        self.assertIn('PUBLIC_ORIGIN=https://192.168.1.10:443', env)
        self.assertEqual(plan['files']['/etc/homecloud/runtime.env']['mode'], 0o600)

    def test_secrets_unique_and_hex(self):
        plan = self.build()
        env = plan['files']['/etc/homecloud/runtime.env']['content']
        values = {}
        for line in env.splitlines():
            key, _, value = line.partition('=')
            values[key] = value
        secrets = [values[key] for key in plan['generated_keys']]
        self.assertEqual(len(set(secrets)), len(secrets))
        for value in secrets:
            self.assertRegex(value, r'^[a-f0-9]{64}$')

    def test_gates_match_startup_gate_format(self):
        plan = self.build()
        db_gate = plan['files']['/etc/homecloud/startup-db.gate']
        self.assertEqual(db_gate['mode'], 0o644)
        self.assertEqual(db_gate['owner'], (0, 0))
        line = db_gate['content']
        self.assertEqual(line.count('\n'), 1)
        fields = line.split()
        self.assertEqual(fields[0], 'db')
        self.assertEqual(fields[1], 'ssd-uuid')
        self.assertEqual(fields[2], '/srv/ssd')
        self.assertEqual(fields[3], '/srv/ssd/mycloud/postgres')
        self.assertEqual(fields[4:6], ['70', '70'])
        self.assertEqual(len(fields), 6)
        backend = plan['files']['/etc/homecloud/startup-backend.gate']['content'].split()
        self.assertEqual(backend[0], 'backend')
        self.assertEqual(backend[4:6], ['1001', '65533'])
        self.assertEqual(len(backend), 6)

    def test_system_root_gate_extra_mode(self):
        plan = self.build(layout={
            'mode': 'system-root',
            'db_dir': '/opt/mycloud/data/postgres',
            'storage_dir': '/srv/data/mycloud/storage',
            'db_uuid': 'root-uuid',
            'storage_uuid': 'hdd-uuid-1',
            'db_serial': 'SSD123',
            'storage_serial': 'HDD456',
            'storage_mount': '/srv/data'})
        fields = plan['files']['/etc/homecloud/startup-db.gate']['content'].split()
        self.assertEqual(fields[2], '/')
        self.assertEqual(fields[-1], 'system-root-lvm')

    def test_markers_at_data_parents(self):
        plan = self.build()
        marker = plan['files']['/srv/ssd/mycloud/.homecloud-db']
        self.assertEqual(marker['owner'], (70, 70))
        self.assertEqual(marker['mode'], 0o400)
        self.assertIn('ssd-uuid', marker['content'])
        backend = plan['files']['/srv/data/mycloud/.homecloud-backend']
        self.assertEqual(backend['owner'], (1001, 65533))

    def test_dirs_ownership(self):
        plan = self.build()
        self.assertEqual(plan['dirs']['/srv/ssd/mycloud/postgres'], (0o700, (70, 70)))
        self.assertEqual(plan['dirs']['/srv/data/mycloud/storage'], (0o700, (1001, 65533)))
        self.assertEqual(plan['dirs']['/opt/mycloud/.runtime'], (0o700, (0, 0)))

    def test_etc_homecloud_layout(self):
        plan = self.build()
        self.assertEqual(plan['dirs']['/etc/homecloud'], (0o700, (0, 0)))
        self.assertEqual(plan['dirs']['/etc/homecloud/maintenance'], (0o711, (0, 0)))
        self.assertEqual(plan['dirs']['/etc/homecloud/docker'], (0o700, (0, 0)))
        self.assertEqual(plan['dirs']['/var/lib/homecloud-update'], (0o750, (0, 0)))
        self.assertEqual(plan['dirs']['/var/lib/homecloud-update/inbox'], (0o770, (0, 65533)))
        self.assertEqual(plan['dirs']['/var/lib/homecloud-update/status'], (0o750, (0, 65533)))

    def test_inventory_matches_layout(self):
        plan = self.build()
        inventory = json.loads(plan['files']['/etc/homecloud/host-disks.json']['content'])
        self.assertEqual(inventory['ssd']['data'], '/srv/ssd/mycloud/postgres')
        self.assertEqual(inventory['ssd']['serial'], 'SSD123')
        self.assertEqual(inventory['hdd']['uuid'], 'hdd-uuid-1')
        self.assertEqual(inventory['hdd']['serial'], 'HDD456')
        self.assertEqual(inventory['hdd']['mount'], '/srv/data')
        self.assertEqual(inventory['postgres_uid'], 70)

    def test_tls_san_ip_and_dns(self):
        plan = self.build()
        self.assertEqual(plan['tls']['san_ip'], ['192.168.1.10'])
        self.assertEqual(plan['tls']['san_dns'], [])
        named = self.build(public_host='cloud.example.com')
        self.assertEqual(named['tls']['san_dns'], ['cloud.example.com'])

    def test_plan_redacts_secrets(self):
        plan = self.build()
        redacted = json.dumps(generate.redact_plan(plan))
        env = plan['files']['/etc/homecloud/runtime.env']['content']
        for line in env.splitlines():
            key, _, value = line.partition('=')
            if key in plan['generated_keys']:
                self.assertNotIn(value, redacted)
        self.assertIn('<generated>', redacted)

    def test_update_channel_and_release_key(self):
        env = self.build()['files']['/etc/homecloud/runtime.env']['content']
        self.assertIn('UPDATE_CHANNEL=release\n', env)
        key = generate.load_release_public_key()
        self.assertIn('UPDATE_RELEASE_PUBLIC_KEY=' + key + '\n', env)
        self.assertIn('UPDATE_INSTALL_BRIDGE_ENABLED=false\n', env)
        test_env = self.build(update_channel='test')['files']['/etc/homecloud/runtime.env']['content']
        self.assertIn('UPDATE_CHANNEL=test\n', test_env)

    def test_release_public_key_file(self):
        plan = self.build()
        entry = plan['files']['/etc/homecloud/release-public.b64']
        self.assertEqual(entry['mode'], 0o644)
        self.assertEqual(entry['owner'], (0, 0))
        self.assertEqual(entry['content'].strip(), generate.load_release_public_key())

    def test_worker_config_contract(self):
        plan = self.build()
        entry = plan['files']['/etc/homecloud/update-worker.json']
        self.assertEqual(entry['mode'], 0o600)
        self.assertEqual(entry['owner'], (0, 0))
        config = json.loads(entry['content'])
        self.assertEqual(config['format'], 'homecloud-user-update-worker-v1')
        self.assertEqual(config['compose_project_dir'], '/opt/mycloud')
        self.assertEqual(config['runtime_env'], '/etc/homecloud/runtime.env')
        self.assertEqual(config['docker_config'], '/etc/homecloud/docker')
        self.assertEqual(config['public_host'], '192.168.1.10')
        self.assertEqual(config['https_port'], 443)
        self.assertIn('sv3t0v1k/homecloud', config['repositories'])

    def test_host_worker_and_systemd_provisioned(self):
        plan = self.build()
        worker = plan['files']['/usr/local/sbin/homecloud-user-update']
        self.assertEqual(worker['mode'], 0o700)
        self.assertEqual(worker['owner'], (0, 0))
        self.assertIn('homecloud-user-update-worker-v1', worker['content'])
        for unit in generate.SYSTEMD_UNITS:
            entry = plan['files']['/etc/systemd/system/' + unit]
            self.assertEqual(entry['mode'], 0o644)
            self.assertEqual(entry['owner'], (0, 0))
            self.assertTrue(entry['content'].endswith('\n'))


class GenerateRefusalTests(unittest.TestCase):
    def refuse(self, **over):
        with self.assertRaises(generate.Refusal):
            generate.build(answers(**over))

    def test_reserved_project_name(self):
        self.refuse(project_name='homecloud-preview')

    def test_bad_project_name(self):
        self.refuse(project_name='My Cloud!')

    def test_bad_project_root(self):
        self.refuse(project_root='relative/path')
        self.refuse(project_root='/opt/../escape')

    def test_bad_port(self):
        self.refuse(https_port=70000)

    def test_trailing_slash_dir(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/opt/x/data/postgres/',
                            'storage_dir': '/srv/data/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_dot_dot_dir(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/opt/x/../postgres',
                            'storage_dir': '/srv/data/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_same_dirs(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/srv/data/storage',
                            'storage_dir': '/srv/data/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_empty_image(self):
        self.refuse(backend_image='')

    def test_zero_uid(self):
        self.refuse(postgres_uid=0)

    def test_missing_serial(self):
        layout = dict(answers()['layout'])
        layout.pop('db_serial')
        self.refuse(layout=layout)
        layout = dict(answers()['layout'])
        layout.pop('storage_serial')
        self.refuse(layout=layout)

    def test_serial_with_whitespace(self):
        layout = dict(answers()['layout'])
        layout['db_serial'] = 'SSD 123'
        self.refuse(layout=layout)

    def test_two_disk_requires_uuids(self):
        self.refuse(layout={'mode': 'two-disk',
                            'db_dir': '/opt/x/db', 'storage_dir': '/srv/data/storage',
                            'db_uuid': 'ssd-uuid', 'storage_uuid': '',
                            'db_mount': '/srv/ssd', 'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_same_ports(self):
        self.refuse(http_port=443, https_port=443)

    def test_storage_dir_outside_mount(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/opt/x/db', 'storage_dir': '/srv/other/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_db_dir_outside_mount(self):
        self.refuse(layout={'mode': 'two-disk',
                            'db_dir': '/opt/x/db', 'storage_dir': '/srv/data/storage',
                            'db_uuid': 'ssd-uuid', 'storage_uuid': 'u',
                            'db_mount': '/srv/ssd', 'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_system_root_requires_db_uuid(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/opt/x/db', 'storage_dir': '/srv/data/storage',
                            'db_uuid': '', 'storage_uuid': 'u',
                            'storage_mount': '/srv/data',
                            'db_serial': 's1', 'storage_serial': 's2'})

    def test_unknown_update_channel(self):
        self.refuse(update_channel='nightly')
        self.refuse(update_channel='')


class InstallerShellRegressionTests(unittest.TestCase):
    """Проверка shell-оркестратора без изменения хоста."""

    def test_default_answers_reach_real_generator(self):
        installer = Path(__file__).resolve().with_name("install.sh")
        script = installer.read_text()

        boundary = (
            'py() { env -i HOME=/root PATH="$clean_path" '
            '/usr/bin/python3 -I -B "$@"; }'
        )

        harness = """
py() {
  case "$1" in
    */probe.py)
      test "$2" = --output || exit 98
      printf '%s\\n' "$HC_TEST_PROBE" > "$3"
      ;;
    */generate.py)
      test "$#" = 5 || exit 98
      test "$2" = --answers || exit 98
      test "$4" = --mode || exit 98
      test "$5" = apply || exit 98
      "$HC_TEST_PYTHON" -I -B "$1" --answers "$3" --mode plan
      exit $?
      ;;
    *)
      "$HC_TEST_PYTHON" -I -B "$@"
      ;;
  esac
}
"""

        self.assertEqual(script.count(boundary), 1)
        script = script.replace(boundary, harness, 1)
        script = 'id() { printf "0\\n"; }\n' + script

        for root in ("/opt/homecloud", "/srv/homecloud"):
            with self.subTest(root=root):
                mount = root + "/data"

                probe = {
                    "warnings": [],
                    "system": {"arch": "x86_64"},
                    "docker": {
                        "present": True,
                        "compose_version": "5.6.0",
                    },
                    "network": {
                        "primary_ip": "192.168.1.10",
                        "listening_tcp_ports": [],
                    },
                    "mounts": [
                        {
                            "target": "/",
                            "uuid": "ssd-uuid",
                            "serial": "SSD123",
                        },
                        {
                            "target": mount,
                            "uuid": "hdd-uuid",
                            "serial": "HDD456",
                        },
                    ],
                }

                env = dict(os.environ)
                env["HC_TEST_PROBE"] = json.dumps(probe)
                env["HC_TEST_PYTHON"] = sys.executable

                images = (
                    "ghcr.io/sv3t0v1k/homecloud/backend@sha256:"
                    + "a" * 64
                    + ",ghcr.io/sv3t0v1k/homecloud/frontend@sha256:"
                    + "b" * 64
                )

                args = [
                    "sh", "-c", script, str(installer),
                    "--defaults", "--images", images,
                ]

                if root != "/opt/homecloud":
                    args += ["--root", root]

                result = subprocess.run(
                    args,
                    env=env,
                    cwd=installer.parents[2],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

                self.assertEqual(
                    result.returncode, 0,
                    result.stdout + result.stderr,
                )

                start = result.stdout.find("{")
                self.assertGreaterEqual(start, 0)
                plan = json.loads(result.stdout[start:])

                files = plan["files"]
                runtime = files[
                    "/etc/homecloud/runtime.env"
                ]["content"]

                inventory = json.loads(files[
                    "/etc/homecloud/host-disks.json"
                ]["content"])

                self.assertIn(
                    "COMPOSE_PROJECT_NAME=homecloud-user\n",
                    runtime,
                )
                self.assertIn(
                    "UPDATE_CHANNEL=release\n",
                    runtime,
                )
                self.assertEqual(
                    inventory["ssd"]["serial"], "SSD123"
                )
                self.assertEqual(
                    inventory["hdd"]["serial"], "HDD456"
                )
                self.assertEqual(
                    inventory["hdd"]["uuid"], "hdd-uuid"
                )
                self.assertEqual(
                    inventory["hdd"]["mount"], mount
                )
                self.assertEqual(
                    inventory["hdd"]["data"],
                    root + "/data/storage",
                )
                self.assertIn(
                    "DB_PASSWORD=<generated>\n",
                    runtime,
                )


class BootstrapChannelRegressionTests(unittest.TestCase):
    """Проверка аргументов и каналов реального shell-bootstrap."""

    def run_bootstrap(self, *args):
        path = Path(__file__).resolve().with_name("bootstrap.sh")
        script = path.read_text()

        boundary = (
            'py() { env -i HOME=/root PATH="$clean_path" '
            '/usr/bin/python3 -I -B "$@"; }'
        )

        harness = """
py() {
  case "${2-}" in
    latest-tag)
      printf '%s\\n' v1.2.0
      ;;
    fetch)
      "$HC_TEST_PYTHON" -c 'import sys,json; print("FETCH "+json.dumps(sys.argv[1:]))' "$@" >&2
      printf '%s\\n' "$HC_TEST_INFO"
      ;;
    *)
      "$HC_TEST_PYTHON" -I -B "$@"
      ;;
  esac
}
"""

        self.assertEqual(script.count(boundary), 1)
        script = script.replace(boundary, harness, 1)

        launch = 'exec sh "$REPO_DIR/deploy/user/install.sh" "$@"'

        capture = (
            'exec "$HC_TEST_PYTHON" -c '
            "'import sys,json; print(json.dumps(sys.argv[1:]))' "
            '"$REPO_DIR/deploy/user/install.sh" "$@"'
        )

        self.assertEqual(script.count(launch), 1)
        script = script.replace(launch, capture, 1)
        script = 'id() { printf "0\\n"; }\n' + script

        env = dict(os.environ)
        env["HC_TEST_PYTHON"] = sys.executable
        env["HC_TEST_INFO"] = json.dumps({
            "images": {
                "backend": "ghcr.io/example/backend@sha256:" + "a" * 64,
                "frontend": "ghcr.io/example/frontend@sha256:" + "b" * 64,
            }
        })

        return subprocess.run(
            ["sh", "-c", script, str(path), *args],
            cwd=path.parents[2],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def successful_args(self, result):
        self.assertEqual(
            result.returncode, 0,
            result.stdout + result.stderr,
        )
        return json.loads(result.stdout.splitlines()[-1])

    def fetch_args(self, result):
        lines = [
            line for line in result.stderr.splitlines()
            if line.startswith("FETCH ")
        ]
        self.assertEqual(len(lines), 1)
        return json.loads(lines[0][6:])[1:]

    def test_default_is_signed_release(self):
        result = self.run_bootstrap("--defaults")
        args = self.successful_args(result)
        self.assertEqual(
            self.fetch_args(result),
            ["fetch", "--tag", "v1.2.0",
             "--dest", "/opt/homecloud/repo"],
        )
        self.assertIn("--channel", args)
        self.assertEqual(args[args.index("--channel") + 1], "release")
        self.assertIn("--images", args)
        self.assertIn("--defaults", args)

    def test_explicit_tag(self):
        result = self.run_bootstrap("--tag", "v2.0.0")
        self.successful_args(result)
        self.assertEqual(
            self.fetch_args(result)[1:3],
            ["--tag", "v2.0.0"],
        )

    def test_explicit_test_ref(self):
        result = self.run_bootstrap(
            "--ref", "test",
            "--channel", "test",
            "--defaults",
        )
        args = self.successful_args(result)
        self.assertEqual(
            self.fetch_args(result)[1:3],
            ["--ref", "test"],
        )
        self.assertEqual(args[args.index("--channel") + 1], "test")
        self.assertNotIn("--images", args)

    def test_unsafe_channel_combinations_refused_before_fetch(self):
        cases = [
            ["--ref", "test"],
            ["--ref", "test", "--channel", "release"],
            ["--channel", "test"],
            ["--tag", "v1.2.0", "--channel", "test"],
            ["--tag", "v1.2.0", "--ref", "test"],
            ["--channel", "nightly"],
            ["--channel", "release", "--channel", "test"],
        ]
        for args in cases:
            with self.subTest(args=args):
                result = self.run_bootstrap(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("FETCH ", result.stderr)

    def test_argument_boundaries_preserved(self):
        answers_path = "/srv/config/My answers 'draft' *.json"

        result = self.run_bootstrap(
            "--root", "/srv/homecloud",
            "--repo-dir", "/srv/homecloud/repo",
            "--answers", answers_path,
            "--name", "custom-cloud",
            "--no-start",
        )

        args = self.successful_args(result)
        self.assertEqual(args[0], "/srv/homecloud/repo/deploy/user/install.sh")
        self.assertEqual(args[args.index("--root") + 1], "/srv/homecloud")
        self.assertEqual(args[args.index("--answers") + 1], answers_path)
        self.assertEqual(args[args.index("--name") + 1], "custom-cloud")
        self.assertIn("--no-start", args)
        self.assertNotIn("--repo-dir", args)

    def test_missing_value_refused_before_fetch(self):
        for option in ("--tag", "--ref", "--root", "--answers", "--channel"):
            with self.subTest(option=option):
                result = self.run_bootstrap(option)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("FETCH ", result.stderr)

    def test_unknown_argument_refused_before_fetch(self):
        result = self.run_bootstrap("--unknown")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("FETCH ", result.stderr)


class InstallerAnswersChannelTests(unittest.TestCase):
    """Проверка канала answers до изменения хоста."""

    def run_installer(self, answers, *args):
        path = Path(__file__).resolve().with_name("install.sh")
        script = path.read_text()

        boundary = (
            'py() { env -i HOME=/root PATH="$clean_path" '
            '/usr/bin/python3 -I -B "$@"; }'
        )

        harness = """
py() {
  case "$1" in
    */probe.py)
      printf '%s\\n' "$HC_TEST_PROBE" > "$3"
      ;;
    *)
      "$HC_TEST_PYTHON" -I -B "$@"
      ;;
  esac
}
"""

        self.assertEqual(script.count(boundary), 1)
        script = script.replace(boundary, harness, 1)

        # Останавливаем тест до фазы generate/apply.
        marker = "# --- Фаза 3:"
        self.assertEqual(script.count(marker), 1)
        script = script.split(marker, 1)[0]
        script += '\nprintf "SELECTED_CHANNEL=%s\\n" "$CHANNEL"\n'
        script = 'id() { printf "0\\n"; }\n' + script

        env = dict(os.environ)
        env["HC_TEST_PYTHON"] = sys.executable
        env["HC_TEST_PROBE"] = json.dumps({
            "warnings": [],
            "system": {"arch": "x86_64"},
            "docker": {
                "present": True,
                "compose_version": "5.6.0",
            },
            "network": {
                "primary_ip": "192.168.1.10",
                "listening_tcp_ports": [],
            },
            "mounts": [
                {
                    "target": "/",
                    "uuid": "ssd-uuid",
                    "serial": "SSD123",
                },
            ],
        })

        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "test answers.json"
            file.write_text(json.dumps(answers))

            return subprocess.run(
                ["sh", "-c", script, str(path),
                 "--answers", str(file), *args],
                cwd=path.parents[2],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )

    def test_channel_inferred_from_answers(self):
        for channel in ("release", "test"):
            with self.subTest(channel=channel):
                result = self.run_installer({
                    "update_channel": channel
                })
                self.assertEqual(
                    result.returncode, 0,
                    result.stdout + result.stderr,
                )
                self.assertIn(
                    "SELECTED_CHANNEL=" + channel,
                    result.stdout,
                )

    def test_explicit_matching_channel(self):
        result = self.run_installer(
            {"update_channel": "test"},
            "--channel", "test",
        )
        self.assertEqual(
            result.returncode, 0,
            result.stdout + result.stderr,
        )
        self.assertIn("SELECTED_CHANNEL=test", result.stdout)

    def test_conflicting_channel_rejected(self):
        for explicit, saved in (
            ("release", "test"),
            ("test", "release"),
        ):
            with self.subTest(explicit=explicit, saved=saved):
                result = self.run_installer(
                    {"update_channel": saved},
                    "--channel", explicit,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("SELECTED_CHANNEL=", result.stdout)

    def test_missing_or_invalid_channel_rejected(self):
        for answers in ({}, {"update_channel": "nightly"}):
            with self.subTest(answers=answers):
                result = self.run_installer(answers)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("SELECTED_CHANNEL=", result.stdout)


class FreshInstallationTests(unittest.TestCase):
    """Проверка сохранности существующих файлов и каталогов."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)

        self.root = Path(directory.name).resolve()
        self.etc = self.root / "etc-homecloud"
        self.data = self.root / "storage"
        self.db = self.root / "postgres"
        self.tls = self.root / "tls"
        self.marker = self.root / ".homecloud-backend"
        self.runtime = self.etc / "runtime.env"

        self.owner = (os.getuid(), os.getgid())

        self.plan = {
            "dirs": {
                str(self.etc): (0o700, self.owner),
                str(self.data): (0o700, self.owner),
                str(self.db): (0o700, self.owner),
                str(self.tls): (0o700, self.owner),
            },
            "files": {
                str(self.runtime): {
                    "content": "DB_PASSWORD=original-secret\n",
                    "mode": 0o600,
                    "owner": self.owner,
                },
                str(self.marker): {
                    "content": "homecloud-v1 backend test-uuid\n",
                    "mode": 0o400,
                    "owner": self.owner,
                },
            },
            "tls": {
                "cert": str(self.tls / "fullchain.pem"),
                "key": str(self.tls / "privkey.pem"),
            },
        }

        patcher = mock.patch.object(
            generate, "ETC", str(self.etc)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_fresh_apply_and_second_apply_refused(self):
        generate.apply_plan(self.plan)

        self.assertEqual(
            self.runtime.read_text(),
            "DB_PASSWORD=original-secret\n",
        )

        self.plan["files"][str(self.runtime)]["content"] = (
            "DB_PASSWORD=replacement-secret\n"
        )

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertEqual(
            self.runtime.read_text(),
            "DB_PASSWORD=original-secret\n",
        )

    def test_existing_config_preserved(self):
        self.etc.mkdir(mode=0o700)
        self.runtime.write_text("existing-secret\n")
        original = self.runtime.stat()

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertEqual(
            self.runtime.read_text(), "existing-secret\n"
        )
        self.assertEqual(
            self.runtime.stat().st_ino, original.st_ino
        )
        self.assertEqual(
            self.runtime.stat().st_mode, original.st_mode
        )
        self.assertFalse(self.data.exists())
        self.assertFalse(self.marker.exists())

    def test_existing_data_refused_before_config_write(self):
        for directory in (self.data, self.db):
            with self.subTest(directory=directory):
                directory.mkdir(mode=0o755)

                existing = directory / "important-data"
                existing.write_bytes(b"user-data")

                original = directory.stat()

                with self.assertRaises(generate.Refusal):
                    generate.apply_plan(self.plan)

                self.assertFalse(self.etc.exists())
                self.assertFalse(self.marker.exists())
                self.assertEqual(
                    existing.read_bytes(), b"user-data"
                )
                self.assertEqual(
                    directory.stat().st_mode, original.st_mode
                )

                existing.unlink()
                directory.rmdir()

    def test_existing_empty_managed_directory_refused(self):
        self.data.mkdir()

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertFalse(self.etc.exists())

    def test_existing_marker_refused(self):
        self.marker.write_text("old-volume-marker\n")

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertEqual(
            self.marker.read_text(), "old-volume-marker\n"
        )
        self.assertFalse(self.etc.exists())

    def test_existing_tls_artifact_refused(self):
        self.tls.mkdir()
        key = self.tls / "privkey.pem"
        key.write_bytes(b"existing-private-key")

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertEqual(
            key.read_bytes(), b"existing-private-key"
        )
        self.assertFalse(self.etc.exists())

        # Проверяем непосредственно TLS boundary:
        # openssl не должен быть запущен.
        with mock.patch.object(
            generate.subprocess, "run"
        ) as run:
            with self.assertRaises(generate.Refusal):
                generate.create_tls(self.plan["tls"])
            run.assert_not_called()

    def test_symlink_parent_refused(self):
        real = self.root / "real"
        real.mkdir()

        link = self.root / "linked"
        link.symlink_to(real, target_is_directory=True)

        self.plan["dirs"][str(link / "data")] = (
            0o700, self.owner
        )

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertFalse(self.etc.exists())
        self.assertFalse((real / "data").exists())

    def test_dangling_symlink_target_refused(self):
        self.data.symlink_to(self.root / "missing")

        with self.assertRaises(generate.Refusal):
            generate.apply_plan(self.plan)

        self.assertTrue(self.data.is_symlink())
        self.assertFalse(self.etc.exists())

    def test_existing_file_never_truncated(self):
        self.marker.write_text("original\n")

        with self.assertRaises(FileExistsError):
            generate.write_file(
                str(self.marker),
                "replacement\n",
                0o600,
                self.owner,
            )

        self.assertEqual(
            self.marker.read_text(), "original\n"
        )

    def test_concurrent_reservation_refused(self):
        # Имитируем появление ETC сразу после read-only admission.
        original_check = generate.assert_fresh_install

        def competing_installer(plan):
            original_check(plan)
            self.etc.mkdir(mode=0o700)
            self.runtime.write_text("other-installer\n")

        with mock.patch.object(
            generate,
            "assert_fresh_install",
            side_effect=competing_installer,
        ):
            with self.assertRaises(generate.Refusal):
                generate.apply_plan(self.plan)

        self.assertEqual(
            self.runtime.read_text(), "other-installer\n"
        )
        self.assertFalse(self.data.exists())
        self.assertFalse(self.marker.exists())


if __name__ == '__main__':
    unittest.main()
