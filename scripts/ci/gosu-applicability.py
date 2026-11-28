#!/usr/bin/env python3
"""Assess Go stdlib CVEs against symbols in one exact gosu binary.

This produces review evidence only. It never removes Trivy findings or grants
a release disposition; the binary, archive and scanner custody remain separate.
"""

import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stream(path):
    decoder = json.JSONDecoder()
    data = path.read_text()
    offset = 0
    while offset < len(data):
        while offset < len(data) and data[offset].isspace():
            offset += 1
        if offset == len(data):
            break
        item, offset = decoder.raw_decode(data, offset)
        yield item


def assess(report_path, vuln_path, symbols_path, binary_path, expected_sha):
    if digest(binary_path) != expected_sha:
        raise ValueError('Exact binary SHA256 mismatch')
    symbols_stream = list(stream(symbols_path))
    if (len(symbols_stream) != 2
            or symbols_stream[0] != {'name': 'govulncheck-extract', 'version': '0.1.0'}):
        raise ValueError('Invalid symbol extraction evidence')
    binary = symbols_stream[1]
    if ((binary.get('goos'), binary.get('goarch'), binary.get('path'))
            != ('linux', 'amd64', 'github.com/tianon/gosu')):
        raise ValueError('Wrong binary platform or main module')
    symbols = binary.get('pkgSymbols')
    if not isinstance(symbols, list) or not symbols:
        raise ValueError('Missing binary symbols')
    present = {(item.get('pkg'), item.get('name')) for item in symbols}
    if not {('main', 'main'), ('main', 'SetupUser'), ('os', 'Open')}.issubset(present):
        raise ValueError('Missing positive extraction controls')
    packages = {package for package, _ in present}

    events = list(stream(vuln_path))
    configs = [item['config'] for item in events if 'config' in item]
    if (len(configs) != 1 or configs[0].get('scan_mode') != 'binary'
            or configs[0].get('scan_level') != 'symbol'):
        raise ValueError('Wrong govulncheck scan mode')
    advisories = {}
    for event in events:
        osv = event.get('osv')
        if not isinstance(osv, dict):
            continue
        for alias in osv.get('aliases', []):
            if alias in advisories and advisories[alias]['id'] != osv['id']:
                raise ValueError('Ambiguous OSV alias: ' + alias)
            advisories[alias] = osv

    report = json.loads(report_path.read_text())
    results = report.get('Results')
    if not isinstance(results, list) or not results:
        raise ValueError('Missing Trivy results')
    rows = []
    for result in results:
        for finding in result.get('Vulnerabilities') or []:
            if finding.get('PkgName') != 'stdlib' or finding.get('Severity') not in ('HIGH', 'CRITICAL'):
                continue
            cve = finding['VulnerabilityID']
            osv = advisories.get(cve)
            if osv is None:
                raise ValueError('No exact GO advisory for ' + cve)
            imports = [item for affected in osv.get('affected', [])
                       for item in affected.get('ecosystem_specific', {}).get('imports', [])]
            affected_packages = {item.get('path') for item in imports if item.get('path')}
            affected_symbols = {(item.get('path'), name) for item in imports
                                for name in item.get('symbols', [])}
            if not affected_packages or not affected_symbols:
                raise ValueError('Missing affected symbols in advisory: ' + cve)
            if not affected_packages & packages:
                conclusion = 'AFFECTED_PACKAGE_ABSENT_CANDIDATE'
            elif not affected_symbols & present:
                conclusion = 'AFFECTED_SYMBOL_ABSENT_CANDIDATE'
            else:
                conclusion = 'POTENTIALLY_REACHABLE'
            rows.append({'cve': cve, 'go_advisory': osv['id'],
                         'severity': finding['Severity'],
                         'installed_go': finding.get('InstalledVersion'),
                         'affected_packages': sorted(affected_packages),
                         'present_affected_packages': sorted(affected_packages & packages),
                         'affected_symbol_count': len(affected_symbols),
                         'present_affected_symbols': [list(item) for item in sorted(affected_symbols & present)],
                         'conclusion': conclusion,
                         'status': 'REVIEW_REQUIRED'})
    if not rows:
        raise ValueError('No blocking Go stdlib findings')
    return {'format': 'homecloud-gosu-applicability-evidence-v1',
            'binary_sha256': expected_sha, 'go_version': binary.get('goVersion'),
            'platform': 'linux/amd64', 'report_sha256': digest(report_path),
            'govulncheck_sha256': digest(vuln_path),
            'symbols_sha256': digest(symbols_path),
            'positive_symbol_controls': ['main.main', 'main.SetupUser', 'os.Open'],
            'findings': rows, 'release_disposition': 'NONE'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--govulncheck', type=Path, required=True)
    parser.add_argument('--symbols', type=Path, required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--binary-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    value = assess(args.report, args.govulncheck, args.symbols,
                   args.binary, args.binary_sha256)
    args.output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print('stdlib findings=%d review_required=%d' %
          (len(value['findings']), sum(x['status'] == 'REVIEW_REQUIRED' for x in value['findings'])))


if __name__ == '__main__':
    main()
