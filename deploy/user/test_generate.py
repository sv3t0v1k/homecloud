#!/usr/bin/env python3
"""Синтетические тесты generate.py: контракт артефактов без root и записи."""
import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'generate', Path(__file__).with_name('generate.py'))
generate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generate)


def answers(**over):
    base = {
        'project_name': 'mycloud',
        'public_host': '192.168.1.10',
        'public_bind_ip': '192.168.1.10',
        'http_port': 80,
        'https_port': 443,
        'layout': {
            'mode': 'two-disk',
            'db_dir': '/opt/mycloud/data/postgres',
            'storage_dir': '/srv/data/mycloud/storage',
            'db_uuid': 'ssd-uuid',
            'storage_uuid': 'hdd-uuid-1',
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
    }
    base.update(over)
    return base


class GenerateContractTests(unittest.TestCase):
    def build(self, **over):
        return generate.build(answers(**over))

    def test_env_has_all_compose_keys(self):
        plan = self.build()
        env = plan['files']['.runtime/runtime.env']['content']
        for key in generate.ENV_KEYS:
            self.assertIn(key + '=', env)
        self.assertNotIn('None', env)
        self.assertIn('PUBLIC_ORIGIN=https://192.168.1.10:443', env)

    def test_secrets_unique_and_hex(self):
        plan = self.build()
        env = plan['files']['.runtime/runtime.env']['content']
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
        db_gate = plan['files']['.runtime/startup-db.gate']
        self.assertEqual(db_gate['mode'], 0o644)
        self.assertEqual(db_gate['owner'], (0, 0))
        line = db_gate['content']
        self.assertEqual(line.count('\n'), 1)
        fields = line.split()
        self.assertEqual(fields[0], 'db')
        self.assertEqual(fields[1], 'ssd-uuid')
        self.assertEqual(fields[2], '/srv/ssd')
        self.assertEqual(fields[3], '/opt/mycloud/data/postgres')
        self.assertEqual(fields[4:6], ['70', '70'])
        self.assertEqual(len(fields), 6)
        backend = plan['files']['.runtime/startup-backend.gate']['content'].split()
        self.assertEqual(backend[0], 'backend')
        self.assertEqual(backend[4:6], ['1001', '65533'])
        self.assertEqual(len(backend), 6)

    def test_system_root_gate_extra_mode(self):
        plan = self.build(layout={
            'mode': 'system-root',
            'db_dir': '/opt/mycloud/data/postgres',
            'storage_dir': '/srv/data/mycloud/storage',
            'storage_uuid': 'hdd-uuid-1',
            'storage_mount': '/srv/data'})
        fields = plan['files']['.runtime/startup-db.gate']['content'].split()
        self.assertEqual(fields[2], '/')
        self.assertEqual(fields[-1], 'system-root-lvm')

    def test_markers_at_data_parents(self):
        plan = self.build()
        marker = plan['files']['/opt/mycloud/data/.homecloud-db']
        self.assertEqual(marker['owner'], (70, 70))
        self.assertEqual(marker['mode'], 0o400)
        self.assertIn('ssd-uuid', marker['content'])
        backend = plan['files']['/srv/data/mycloud/.homecloud-backend']
        self.assertEqual(backend['owner'], (1001, 65533))

    def test_dirs_ownership(self):
        plan = self.build()
        self.assertEqual(plan['dirs']['/opt/mycloud/data/postgres'], (0o700, (70, 70)))
        self.assertEqual(plan['dirs']['/srv/data/mycloud/storage'], (0o700, (1001, 65533)))
        self.assertEqual(plan['dirs']['/opt/mycloud/.runtime'], (0o700, (0, 0)))

    def test_inventory_matches_layout(self):
        plan = self.build()
        inventory = json.loads(plan['files']['.runtime/host-disks.json']['content'])
        self.assertEqual(inventory['ssd']['data'], '/opt/mycloud/data/postgres')
        self.assertEqual(inventory['hdd']['uuid'], 'hdd-uuid-1')
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
        env = plan['files']['.runtime/runtime.env']['content']
        for line in env.splitlines():
            key, _, value = line.partition('=')
            if key in plan['generated_keys']:
                self.assertNotIn(value, redacted)
        self.assertIn('<generated>', redacted)


class GenerateRefusalTests(unittest.TestCase):
    def refuse(self, **over):
        with self.assertRaises(generate.Refusal):
            generate.build(answers(**over))

    def test_reserved_project_name(self):
        self.refuse(project_name='homecloud-preview')

    def test_bad_project_name(self):
        self.refuse(project_name='My Cloud!')

    def test_bad_port(self):
        self.refuse(https_port=70000)

    def test_trailing_slash_dir(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/opt/x/data/postgres/',
                            'storage_dir': '/srv/data/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data'})

    def test_dot_dot_dir(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/opt/x/../postgres',
                            'storage_dir': '/srv/data/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data'})

    def test_same_dirs(self):
        self.refuse(layout={'mode': 'system-root',
                            'db_dir': '/srv/data/storage',
                            'storage_dir': '/srv/data/storage',
                            'storage_uuid': 'u', 'storage_mount': '/srv/data'})

    def test_empty_image(self):
        self.refuse(backend_image='')

    def test_zero_uid(self):
        self.refuse(postgres_uid=0)

    def test_two_disk_requires_uuids(self):
        self.refuse(layout={'mode': 'two-disk',
                            'db_dir': '/opt/x/db', 'storage_dir': '/srv/data/storage',
                            'db_uuid': 'ssd-uuid', 'storage_uuid': '',
                            'db_mount': '/srv/ssd', 'storage_mount': '/srv/data'})


if __name__ == '__main__':
    unittest.main()
