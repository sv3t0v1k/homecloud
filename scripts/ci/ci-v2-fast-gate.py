#!/usr/bin/env python3
"""Require the complete CI route selected for the exact candidate."""
import argparse
import json
import sys

REQUIRED = {
    'recovery-scope',
    'pr-fast-backend',
    'backend',
    'frontend',
    'configuration',
    'secrets',
    'recovery-qualification',
}


def validate(results, event_name='pull_request'):
    if event_name not in ('pull_request', 'push'):
        raise ValueError('Unsupported Fast/Integration event')

    if not isinstance(results, dict) or set(results) != REQUIRED:
        raise ValueError('Missing or unexpected Fast/Integration result')

    route = results['recovery-scope']

    if not isinstance(route, dict) or route.get('result') != 'success':
        raise ValueError('Recovery scope job failed or skipped')

    outputs = route.get('outputs')

    if not isinstance(outputs, dict):
        raise ValueError('Missing recovery scope evidence')

    mode = outputs.get('mode')

    permitted = (
        ('full', 'ui') if event_name == 'pull_request'
        else ('push',)
    )

    if mode not in permitted:
        raise ValueError('Invalid recovery scope for event')

    for name, job in results.items():
        expected = 'success'

        if name == 'recovery-qualification':
            if mode in ('ui', 'push'):
                expected = 'skipped'

        status = job.get('result') if isinstance(job, dict) else None

        if status != expected:
            raise ValueError(
                f'Fast/Integration job failed or skipped unexpectedly: '
                f'{name}={status}; expected={expected}'
            )

    return mode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', required=True)
    parser.add_argument(
        '--event-name',
        choices=('pull_request', 'push'),
        required=True,
    )
    args = parser.parse_args()

    try:
        mode = validate(json.loads(args.results), args.event_name)
    except (ValueError, json.JSONDecodeError) as error:
        print(f'BLOCKED: {error}', file=sys.stderr)
        return 1

    print(f'PASS: complete CI route: {mode}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
