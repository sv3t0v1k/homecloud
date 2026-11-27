#!/usr/bin/env python3
"""Синтетические тесты probe.py: контракт опроса среды без Linux-утилит."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'probe', Path(__file__).with_name('probe.py'))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

LSBLK = json.dumps({'blockdevices': [
    {'path': '/dev/sda', 'type': 'disk', 'size': 256060514304, 'fstype': None,
     'uuid': None, 'serial': 'SSD123', 'ro': False, 'tran': 'sata'},
    {'path': '/dev/sdb', 'type': 'disk', 'size': 3000877195264,
     'fstype': 'ext4', 'uuid': 'hdd-uuid-1', 'serial': 'HDD456',
     'ro': False, 'tran': 'sata'},
    {'path': '/dev/sr0', 'type': 'rom', 'size': 0, 'fstype': None,
     'uuid': None, 'serial': None, 'ro': True, 'tran': None},
]})
SS = '  0.0.0.0:22 0.0.0.0:*\n  [::]:8443 [::]:*\n'
IP_ROUTE = json.dumps([{'prefsrc': '192.168.1.10', 'dev': 'eth0'}])


def canned(mapping):
    def runner(command):
        for prefix in sorted(mapping, key=len, reverse=True):
            if command[:len(prefix)] == list(prefix):
                return mapping[prefix]
        return None
    return runner


INVERSE_SDB1 = json.dumps({'blockdevices': [
    {'path': '/dev/sdb1', 'type': 'part', 'serial': None, 'children': [
        {'path': '/dev/sdb', 'type': 'disk', 'serial': 'HDD456'}]}]})

DOCKER_PREFIX = (
    'docker', '--config', '/etc/homecloud/docker',
    '--host', 'unix:///var/run/docker.sock',
)

BASE = {
    ('uname', '-m'): 'x86_64\n',
    DOCKER_PREFIX + ('version',): '29.0.0\n',
    DOCKER_PREFIX + ('compose', 'version'): 'v5.6.0\n',
    ('lsblk',): LSBLK,
    ('lsblk', '--json', '--inverse'): INVERSE_SDB1,
    ('findmnt',): json.dumps({'filesystems': [
        {'target': '/srv/data', 'source': '/dev/sdb1', 'fstype': 'ext4', 'uuid': 'hdd-uuid-1'}]}),
    ('ss',): SS,
    ('ip',): IP_ROUTE,
}


class ProbeContractTests(unittest.TestCase):
    def test_docker_environment_is_clean(self):
        with mock.patch.dict(probe.os.environ, {
            'DOCKER_HOST': 'ssh://untrusted',
            'DOCKER_CONTEXT': 'untrusted',
            'DOCKER_CONFIG': '/untrusted/docker',
        }):
            with mock.patch.object(
                probe.subprocess, 'run',
                return_value=mock.Mock(
                    returncode=0, stdout=b'29.0.0'),
            ) as run:
                probe.default_runner(
                    list(DOCKER_PREFIX) + ['version'])

        self.assertEqual(
            run.call_args.kwargs['env'],
            {'HOME': '/root', 'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'},
        )

    def collect(self, extra=None):
        mapping = dict(BASE)
        mapping.update(extra or {})
        return probe.collect(runner=canned(mapping))

    def test_full_facts(self):
        facts = self.collect()
        self.assertEqual(facts['format'], 'homecloud-user-probe-v1')
        self.assertEqual(facts['system']['arch'], 'x86_64')
        self.assertEqual(facts['docker']['compose_version'], 'v5.6.0')
        disks = {d['path']: d for d in facts['disks']}
        self.assertEqual(sorted(disks), ['/dev/sda', '/dev/sdb'])
        self.assertEqual(disks['/dev/sdb']['uuid'], 'hdd-uuid-1')
        self.assertEqual(disks['/dev/sdb']['serial'], 'HDD456')
        self.assertEqual(facts['network']['primary_ip'], '192.168.1.10')
        self.assertEqual(facts['network']['listening_tcp_ports'], [22, 8443])
        self.assertEqual(facts['warnings'], [])

    def test_mount_serial_resolved_to_physical_disk(self):
        facts = self.collect()
        row = facts['mounts'][0]
        self.assertEqual(row['source'], '/dev/sdb1')
        self.assertEqual(row['serial'], 'HDD456')

    def test_mount_serial_soft_failure(self):
        mapping = dict(BASE)
        mapping.pop(('lsblk', '--json', '--inverse'))
        facts = probe.collect(runner=canned(mapping))
        self.assertIsNone(facts['mounts'][0]['serial'])
        self.assertEqual(facts['warnings'], [])

    def test_optical_drive_excluded(self):
        facts = self.collect()
        self.assertNotIn('/dev/sr0', [d['path'] for d in facts['disks']])

    def test_missing_docker_warns(self):
        mapping = dict(BASE)
        mapping.pop(DOCKER_PREFIX + ('version',))
        facts = probe.collect(runner=canned(mapping))
        self.assertFalse(facts['docker']['present'])
        self.assertTrue(any('docker' in w for w in facts['warnings']))

    def test_foreign_arch_warns(self):
        facts = self.collect({('uname', '-m'): 'aarch64\n'})
        self.assertTrue(any('x86_64' in w for w in facts['warnings']))

    def test_missing_lsblk_is_fatal(self):
        mapping = dict(BASE)
        mapping.pop(('lsblk',))
        with self.assertRaises(probe.ProbeError):
            probe.collect(runner=canned(mapping))

    def test_no_disks_is_fatal(self):
        mapping = dict(BASE)
        mapping[('lsblk',)] = '{"blockdevices": []}'
        with self.assertRaises(probe.ProbeError):
            probe.collect(runner=canned(mapping))

    def test_partial_network_is_not_fatal(self):
        mapping = dict(BASE)
        mapping.pop(('ip',))
        facts = probe.collect(runner=canned(mapping))
        self.assertIsNone(facts['network']['primary_ip'])
        self.assertEqual(facts['warnings'], [])


if __name__ == '__main__':
    unittest.main()
