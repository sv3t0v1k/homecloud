#!/usr/bin/env python3
"""Reuse PR checks only for an exact, fully verified protected merge commit."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SHA = re.compile(r'[a-f0-9]{40}\Z')
TREE_SHA = re.compile(r'[a-f0-9]{40}\Z')
RUN_URL = re.compile(
    r'https://github\.com/[^/]+/[^/]+/actions/runs/([1-9][0-9]*)/job/[1-9][0-9]*\Z'
)
REPOSITORY = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z')
CONTROL_ROOTS = ('.github/workflows', 'scripts/ci', 'deploy')
REQUIRED_CHECKS = {
    'ci-v2-fast-terminal': '.github/workflows/ci-v2-fast.yml',
    'qualify': '.github/workflows/frontend-runtime-qualification.yml',
    'phase3-host-drills': '.github/workflows/phase3-host-drills.yml',
}


class ReuseRefused(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise ReuseRefused(reason)


def run_id(details_url):
    require(isinstance(details_url, str), 'missing check run URL')
    match = RUN_URL.fullmatch(details_url)
    require(match is not None, 'unsupported check run URL')
    return int(match.group(1))


def evaluate(data, repository):
    """Evaluate already retrieved evidence; never turn insufficient proof into reuse."""
    require(REPOSITORY.fullmatch(repository), 'invalid repository')
    after = data.get('after')
    checkout = data.get('checkout')
    branch = data.get('branch', {})
    require(data.get('ref') == 'refs/heads/test', 'not a protected test push')
    require(branch.get('protected') is True, 'test branch is not protected')
    require(branch.get('commit', {}).get('sha') == after == checkout,
            'test HEAD changed or checkout mismatch')
    require(all(isinstance(value, str) and SHA.fullmatch(value)
                for value in (after, checkout)), 'invalid merge SHA')

    pulls = data.get('pulls')
    require(isinstance(pulls, list), 'invalid associated PR evidence')
    merged = [pr for pr in pulls
              if isinstance(pr, dict) and pr.get('merge_commit_sha') == after]
    require(len(merged) == 1, 'merge does not have exactly one exact merged PR')
    pr = merged[0]
    require(pr.get('state') == 'closed' and pr.get('merged_at'),
            'associated PR is not merged')
    require(pr.get('base', {}).get('ref') == 'test', 'PR base is not test')
    require(pr.get('base', {}).get('repo', {}).get('full_name', '').lower()
            == repository.lower(), 'PR base repository mismatch')
    require(pr.get('head', {}).get('repo', {}).get('full_name', '').lower()
            == repository.lower(), 'fork PR reuse is forbidden')
    base = pr['base'].get('sha')
    head = pr['head'].get('sha')
    require(all(isinstance(value, str) and SHA.fullmatch(value)
                for value in (base, head)), 'invalid PR SHA')

    merge = data.get('merge', {})
    require(merge.get('sha') == after, 'merge commit lookup mismatch')
    parents = merge.get('parents')
    require(isinstance(parents, list) and len(parents) == 2,
            'not an ordinary two-parent merge')
    require([parent.get('sha') for parent in parents] == [base, head],
            'merge parents do not bind protected base and PR HEAD')
    require(data.get('ancestor') is True, 'protected base is not an ancestor of PR HEAD')

    merge_tree = data.get('merge_tree')
    head_tree = data.get('head_tree')
    require(all(isinstance(value, str) and TREE_SHA.fullmatch(value)
                for value in (merge_tree, head_tree)), 'invalid tree SHA')
    require(merge_tree == head_tree == merge.get('commit', {}).get('tree', {}).get('sha'),
            'merge tree differs from tested PR tree')

    changed = data.get('changed_paths')
    require(isinstance(changed, list)
            and all(isinstance(path, str) for path in changed), 'invalid changed paths')
    require(not any(path == root or path.startswith(root + '/')
                    for path in changed for root in CONTROL_ROOTS),
            'CI or trusted control files changed; full push CI required')

    checks = data.get('checks')
    require(isinstance(checks, dict), 'missing check evidence')
    proof = {}
    for name, workflow_path in REQUIRED_CHECKS.items():
        item = checks.get(name, {})
        check = item.get('check', {})
        run = item.get('run', {})
        require(check.get('name') == name, f'missing required check: {name}')
        require(check.get('head_sha') == head, f'stale check HEAD: {name}')
        require(check.get('status') == 'completed'
                and check.get('conclusion') == 'success',
                f'required check is not green: {name}')
        expected_run = run_id(check.get('details_url'))
        require(run.get('id') == expected_run, f'check/run identity mismatch: {name}')
        require(run.get('path') == workflow_path, f'check workflow mismatch: {name}')
        require(run.get('event') == 'pull_request', f'check is not from PR: {name}')
        require(run.get('status') == 'completed' and run.get('conclusion') == 'success',
                f'workflow run is not green: {name}')
        require(run.get('head_sha') == head, f'workflow run HEAD mismatch: {name}')
        require(run.get('head_branch') == pr['head'].get('ref'),
                f'workflow run branch mismatch: {name}')
        require(run.get('repository', {}).get('full_name', '').lower()
                == repository.lower(), f'workflow repository mismatch: {name}')
        require(run.get('head_repository', {}).get('full_name', '').lower()
                == repository.lower(), f'workflow head repository mismatch: {name}')
        proof[name] = {'check_id': check.get('id'), 'run_id': expected_run}
        require(isinstance(proof[name]['check_id'], int) and proof[name]['check_id'] > 0,
                f'invalid check identity: {name}')

    return {
        'mode': 'reuse',
        'repository': repository,
        'pr': pr.get('number'),
        'merge': after,
        'base': base,
        'head': head,
        'tree': merge_tree,
        'checks': proof,
    }


def git(*args, check=True):
    environment = {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'HOME': os.environ.get('HOME', ''),
        'GIT_NO_REPLACE_OBJECTS': '1',
        'GIT_CONFIG_NOSYSTEM': '1',
    }
    result = subprocess.run(
        ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null',
         '-c', 'core.fsmonitor=false', *args],
        text=True, capture_output=True, timeout=30, check=False, env=environment,
    )
    if check and result.returncode != 0:
        raise ReuseRefused('Git evidence lookup failed')
    return result


def api(path):
    result = subprocess.run(
        ['gh', 'api', path], text=True, capture_output=True, timeout=30, check=False,
        env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
             'HOME': os.environ.get('HOME', ''),
             'GH_TOKEN': os.environ.get('GH_TOKEN', '')},
    )
    require(result.returncode == 0, 'GitHub API evidence lookup failed')
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ReuseRefused('invalid GitHub API evidence') from error


def collect_checks(checks_raw, repository):
    require(isinstance(checks_raw, dict), 'invalid check evidence')
    require(checks_raw.get('total_count') == len(checks_raw.get('check_runs', [])),
            'check evidence pagination required')
    by_name = {}
    for check in checks_raw.get('check_runs', []):
        by_name.setdefault(check.get('name'), []).append(check)

    checks = {}
    for name, workflow_path in REQUIRED_CHECKS.items():
        matches = []
        for check in by_name.get(name, []):
            run = api(f'repos/{repository}/actions/runs/{run_id(check.get("details_url"))}')
            if run.get('path') == workflow_path:
                matches.append({'check': check, 'run': run})
        require(len(matches) == 1,
                f'required check workflow is missing or ambiguous: {name}')
        checks[name] = matches[0]
    return checks


def collect(event_path, expected_base, repository):
    require(REPOSITORY.fullmatch(repository), 'invalid repository')
    event = json.loads(Path(event_path).read_text())
    after = event.get('after')
    checkout = git('rev-parse', 'HEAD').stdout.strip()
    require(after == checkout, 'push checkout mismatch')
    require(isinstance(expected_base, str) and SHA.fullmatch(expected_base),
            'invalid protected base')
    merge = api(f'repos/{repository}/commits/{after}')
    require(merge.get('parents', [{}])[0].get('sha') == expected_base,
            'protected base differs from first parent')
    head = merge['parents'][1]['sha'] if len(merge.get('parents', [])) == 2 else '0' * 40
    checks_raw = api(f'repos/{repository}/commits/{head}/check-runs?filter=latest&per_page=100')
    checks = collect_checks(checks_raw, repository)
    ancestor = git('merge-base', '--is-ancestor', expected_base, head, check=False).returncode == 0
    changed_output = git('diff', '--name-only', '--no-renames', expected_base, head,
                         '--', '.github/workflows', 'scripts/ci', 'deploy').stdout
    data = {
        'ref': event.get('ref'),
        'after': after,
        'checkout': checkout,
        'branch': api(f'repos/{repository}/branches/test'),
        'pulls': api(f'repos/{repository}/commits/{after}/pulls'),
        'merge': merge,
        'ancestor': ancestor,
        'merge_tree': git('rev-parse', f'{after}^{{tree}}').stdout.strip(),
        'head_tree': git('rev-parse', f'{head}^{{tree}}').stdout.strip(),
        'changed_paths': [path for path in changed_output.splitlines() if path],
        'checks': checks,
    }
    return evaluate(data, repository)


def outcome(event_path, expected_base, repository, require_reuse=False):
    try:
        evidence = collect(event_path, expected_base, repository)
    except (ReuseRefused, OSError, KeyError, IndexError, TypeError, AttributeError,
            ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        evidence = {'mode': 'full', 'reason': str(error) or type(error).__name__}
    if require_reuse and evidence['mode'] != 'reuse':
        print('BLOCKED: merge reuse proof failed: ' + evidence.get('reason', 'full route'), file=sys.stderr)
        return 1, evidence
    return 0, evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event', required=True)
    parser.add_argument('--base', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--require-reuse', action='store_true')
    args = parser.parse_args()
    status, evidence = outcome(args.event, args.base, args.repository, args.require_reuse)
    print(json.dumps(evidence, sort_keys=True))
    return status


if __name__ == '__main__':
    sys.exit(main())
