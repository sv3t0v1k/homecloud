#!/usr/bin/env python3
"""Fail-closed checks for exact-binary Go advisory triage evidence."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    'gosu_applicability', Path(__file__).with_name('gosu-applicability.py'))
applicability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(applicability)


class GosuApplicabilityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.binary = self.root / 'gosu'
        self.binary.write_bytes(b'\x7fELFfixture')
        self.digest = hashlib.sha256(self.binary.read_bytes()).hexdigest()
        self.symbols = self.root / 'symbols.json'
        self.symbols.write_text('\n'.join(json.dumps(x) for x in [
            {'name': 'govulncheck-extract', 'version': '0.1.0'},
            {'goos': 'linux', 'goarch': 'amd64', 'path': 'github.com/tianon/gosu',
             'goVersion': 'go1.24.6', 'pkgSymbols': [
                 {'pkg': 'main', 'name': 'main'},
                 {'pkg': 'main', 'name': 'SetupUser'},
                 {'pkg': 'os', 'name': 'Open'},
             ]},
        ]))
        self.govuln = self.root / 'govuln.json'
        self.govuln.write_text('\n'.join(json.dumps(x) for x in [
            {'config': {'scan_mode': 'binary', 'scan_level': 'symbol'}},
            {'osv': {'id': 'GO-1', 'aliases': ['CVE-1'], 'affected': [
                {'ecosystem_specific': {'imports': [
                    {'path': 'crypto/tls', 'symbols': ['Client']},
                ]}},
            ]}},
            {'osv': {'id': 'GO-2', 'aliases': ['CVE-2'], 'affected': [
                {'ecosystem_specific': {'imports': [
                    {'path': 'os', 'symbols': ['Open']},
                ]}},
            ]}},
        ]))
        self.report = self.root / 'report.json'
        self.report.write_text(json.dumps({'Results': [
            {'Vulnerabilities': [
                {'PkgName': 'stdlib', 'Severity': 'HIGH',
                 'VulnerabilityID': 'CVE-1', 'InstalledVersion': 'v1.24.6'},
                {'PkgName': 'stdlib', 'Severity': 'CRITICAL',
                 'VulnerabilityID': 'CVE-2', 'InstalledVersion': 'v1.24.6'},
            ]},
        ]}))

    def assess(self):
        return applicability.assess(self.report, self.govuln,
                                    self.symbols, self.binary, self.digest)

    def test_absence_is_candidate_and_present_symbol_is_reachable(self):
        result = self.assess()
        self.assertEqual([x['conclusion'] for x in result['findings']], [
            'AFFECTED_PACKAGE_ABSENT_CANDIDATE', 'POTENTIALLY_REACHABLE',
        ])
        self.assertEqual(result['release_disposition'], 'NONE')
        self.assertTrue(all(x['status'] == 'REVIEW_REQUIRED' for x in result['findings']))

    def test_changed_binary_and_missing_advisory_fail_closed(self):
        self.binary.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
            self.assess()
        self.binary.write_bytes(b'\x7fELFfixture')
        self.govuln.write_text(json.dumps({'config': {
            'scan_mode': 'binary', 'scan_level': 'symbol',
        }}))
        with self.assertRaisesRegex(ValueError, 'No exact GO advisory'):
            self.assess()


if __name__ == '__main__':
    unittest.main()
