#!/usr/bin/env python3
"""Синтетические тесты generate.py: контракт артефактов без root и записи."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import unittest

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


if __name__ == '__main__':
    unittest.main()
