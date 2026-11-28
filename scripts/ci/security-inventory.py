#!/usr/bin/env python3
"""Inventory exact CI scan findings without changing scan or release verdicts.

The output is triage evidence, not a CVE disposition. Unknown applicability and
reachability remain explicit until an individual assessment supplies proof.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


SEVERITIES = {'HIGH', 'CRITICAL'}
REPORT_NAMES = {'rootfs.json', 'component.json', 'tools.json', 'global-npm.json'}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def report_paths(directories):
    for directory in directories:
        for path in sorted(directory.rglob('*.json')):
            name = path.name
            if (name in REPORT_NAMES or name.endswith('.scan.json')
                    or name.startswith('image-') and not name.endswith('.evidence.json')):
                yield path


def domain(path, result, finding, environment_id=None):
    name = path.name
    if name.startswith('image-base-'):
        return 'upstream-base-diagnostic', 'third-party'
    if name.startswith(('image-backend.', 'image-frontend.')) or name in ('postgres.scan.json', 'ingress.scan.json'):
        return 'production-runtime', 'third-party' if name in ('postgres.scan.json', 'ingress.scan.json') else 'homecloud'
    if name.endswith('.scan.json'):
        return 'build-environment', 'third-party' if name == 'buildkit.scan.json' else 'homecloud'
    if name == 'component.json':
        return 'application-dependencies', 'homecloud'
    if name in ('tools.json', 'global-npm.json'):
        return 'ci-tools', 'mixed'
    if name == 'rootfs.json':
        if environment_id not in ('backend', 'pr-fast-backend'):
            return 'github-platform', 'github'
        package_path = finding.get('PkgPath') or ''
        target = result.get('Target') or ''
        if package_path.startswith(('__t/', '__e/')) or target.startswith(('__t/', '__e/')):
            return 'github-platform-mount', 'github'
        if result.get('Class') == 'os-pkgs':
            return 'ci-container-os', 'homecloud'
        return 'ci-container-unattributed', 'unknown'
    raise ValueError('Unsupported scan report: ' + str(path))


def inventory(directories, run_id, source_commit):
    findings = []
    reports = []
    seen = set()
    for path in report_paths(directories):
        if path in seen:
            raise ValueError('Duplicate report: ' + str(path))
        seen.add(path)
        report = json.loads(path.read_text())
        results = report.get('Results')
        if not isinstance(results, list) or not results:
            raise ValueError('Missing scan results: ' + str(path))
        digest = sha256(path)
        evidence_path = path.with_name('environment.json')
        environment_id = None
        if path.name in REPORT_NAMES and evidence_path.is_file():
            evidence = json.loads(evidence_path.read_text())
            environment_id = evidence.get('environment_id')
            role = path.stem
            if evidence.get('report_sha256', {}).get(role) != digest:
                raise ValueError('Environment report hash mismatch: ' + str(path))
            if evidence.get('source_commit') != source_commit:
                raise ValueError('Environment source mismatch: ' + str(path))
        count = Counter()
        for result_index, result in enumerate(results):
            vulnerabilities = result.get('Vulnerabilities') or []
            if not isinstance(vulnerabilities, list):
                raise ValueError('Invalid vulnerability list: ' + str(path))
            for finding_index, finding in enumerate(vulnerabilities):
                severity = finding.get('Severity')
                count[severity] += 1
                if severity not in SEVERITIES:
                    continue
                if not finding.get('VulnerabilityID') or not finding.get('PkgName'):
                    raise ValueError('Incomplete blocking finding: ' + str(path))
                category, owner = domain(path, result, finding, environment_id)
                findings.append({
                    'report': str(path), 'report_sha256': digest,
                    'result_index': result_index, 'finding_index': finding_index,
                    'domain': category, 'component_owner': owner,
                    'target': result.get('Target'), 'package_path': finding.get('PkgPath'),
                    'vulnerability_id': finding['VulnerabilityID'],
                    'package': finding['PkgName'],
                    'installed_version': finding.get('InstalledVersion'),
                    'fixed_version': finding.get('FixedVersion') or None,
                    'upstream_fix_reported': bool(finding.get('FixedVersion')),
                    'severity': severity, 'primary_url': finding.get('PrimaryURL'),
                    'applicability': 'UNVERIFIED', 'vulnerable_code_reachability': 'UNVERIFIED',
                    'exploit_risk': 'UNRESOLVED',
                })
        reports.append({'path': str(path), 'sha256': digest,
                        'artifact': path.parent.name, 'findings': dict(sorted(count.items()))})
    if not reports:
        raise ValueError('No scan reports found')
    by_domain = Counter(item['domain'] for item in findings)
    return {'format': 'homecloud-sec02-inventory-v1', 'source_run_id': run_id,
            'source_commit': source_commit, 'reports': reports,
            'high_critical_findings': findings,
            'high_critical_counts_by_domain': dict(sorted(by_domain.items())),
            'unique_cve_count': len({item['vulnerability_id'] for item in findings})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, action='append', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    value = inventory(args.directory, args.run_id, args.source)
    args.output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print('reports=%d high_critical=%d unique_CVE=%d' %
          (len(value['reports']), len(value['high_critical_findings']), value['unique_cve_count']))


if __name__ == '__main__':
    main()
