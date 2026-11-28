#!/usr/bin/env python3
"""No-loss checks for SEC-02 scan inventory and ownership boundaries."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    'security_inventory', Path(__file__).with_name('security-inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class SecurityInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.artifact = self.root / 'environment-backend-1'
        self.artifact.mkdir()
        self.source = 'a' * 40

    def write_report(self):
        report = {'Results': [
            {'Target': 'ci-image (debian 12)', 'Class': 'os-pkgs',
             'Vulnerabilities': [
                 {'VulnerabilityID': 'CVE-2026-0001', 'PkgName': 'curl',
                  'InstalledVersion': '1', 'FixedVersion': '2', 'Severity': 'HIGH'},
                 {'VulnerabilityID': 'CVE-2026-0002', 'PkgName': 'libc',
                  'InstalledVersion': '1', 'Severity': 'MEDIUM'},
             ]},
            {'Target': '__t/CodeQL/tool', 'Class': 'lang-pkgs',
             'Vulnerabilities': [
                 {'VulnerabilityID': 'CVE-2026-0003', 'PkgName': 'stdlib',
                  'InstalledVersion': '1', 'Severity': 'CRITICAL'},
             ]},
        ]}
        path = self.artifact / 'rootfs.json'
        path.write_text(json.dumps(report))
        (self.artifact / 'environment.json').write_text(json.dumps({
            'source_commit': self.source,
            'environment_id': 'backend',
            'report_sha256': {'rootfs': inventory.sha256(path)},
        }))
        return path

    def test_keeps_each_blocking_finding_and_separates_provider_mount(self):
        self.write_report()
        result = inventory.inventory([self.root], '123', self.source)
        self.assertEqual(len(result['high_critical_findings']), 2)
        self.assertEqual(result['unique_cve_count'], 2)
        self.assertEqual(result['high_critical_counts_by_domain'], {
            'ci-container-os': 1, 'github-platform-mount': 1,
        })
        self.assertEqual(result['reports'][0]['findings'], {
            'CRITICAL': 1, 'HIGH': 1, 'MEDIUM': 1,
        })
        self.assertEqual(result['high_critical_findings'][0]['applicability'], 'UNVERIFIED')

    def test_rejects_changed_source_report(self):
        path = self.write_report()
        path.write_text(path.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            inventory.inventory([self.root], '123', self.source)


if __name__ == '__main__':
    unittest.main()
