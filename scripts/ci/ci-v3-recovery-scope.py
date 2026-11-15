#!/usr/bin/env python3
"""Conservative Native Recovery routing for HomeCloud.

Only regular frontend presentation sources may use the UI route.
All other changes require the complete recovery qualification.
"""
import os
import re
import subprocess
import sys


SHA = re.compile(r'[a-f0-9]{40}\Z')

ROOT_UI = re.compile(
    r'frontend/src/(?:App(?:\.test)?\.tsx|'
    r'[A-Za-z0-9_-]+\.css)\Z'
)

FILE_UI = re.compile(
    r'frontend/src/files/(?:[A-Za-z0-9_-]+/)*'
    r'[A-Za-z0-9_][A-Za-z0-9_.-]*'
    r'\.(?:tsx|css|test\.ts)\Z'
)

SHARED_UI = re.compile(
    r'frontend/src/(?:ui|accessibility)/'
    r'(?:[A-Za-z0-9_-]+/)*'
    r'[A-Za-z0-9_][A-Za-z0-9_.-]*'
    r'\.(?:ts|tsx|css)\Z'
)

RAW_HEADER = re.compile(
    rb':([0-7]{6}) ([0-7]{6}) '
    rb'([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])\Z'
)


def allowed_path(path):
    return bool(
        ROOT_UI.fullmatch(path)
        or FILE_UI.fullmatch(path)
        or SHARED_UI.fullmatch(path)
    )


def classify(raw):
    """Read Git's NUL-delimited raw tree diff, not filenames alone."""
    if not isinstance(raw, bytes) or not raw or not raw.endswith(b'\0'):
        return 'full'

    records = raw[:-1].split(b'\0')

    if len(records) % 2:
        return 'full'

    seen = set()

    for i in range(0, len(records), 2):
        header, raw_path = records[i:i + 2]
        match = RAW_HEADER.fullmatch(header)

        if not match:
            return 'full'

        old_mode, new_mode, old_oid, new_oid, status = match.groups()

        # Only ordinary non-executable regular files are permitted.
        if new_mode != b'100644':
            return 'full'

        if new_oid == b'0' * 40:
            return 'full'

        if status == b'A':
            if old_mode != b'000000' or old_oid != b'0' * 40:
                return 'full'
        elif old_mode != b'100644' or old_oid == b'0' * 40:
            return 'full'

        try:
            path = raw_path.decode('ascii')
        except UnicodeDecodeError:
            return 'full'

        if path in seen or not allowed_path(path):
            return 'full'

        seen.add(path)

    return 'ui' if seen else 'full'


def git_route(base, head, cwd=None):
    """Bind the decision to complete, exact, ancestor-based Git trees."""
    if not all(isinstance(s, str) and SHA.fullmatch(s)
               for s in (base, head)):
        return 'full'

    if base == head:
        return 'full'

    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS='1')

    def git(*args):
        return subprocess.check_output(
            ['git', *args],
            cwd=cwd,
            env=env,
            stderr=subprocess.DEVNULL,
        )

    try:
        for commit in (base, head):
            if git('cat-file', '-t', commit).strip() != b'commit':
                return 'full'

        subprocess.run(
            ['git', 'merge-base', '--is-ancestor', base, head],
            cwd=cwd, env=env, check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        raw = git(
            'diff', '--raw', '-z', '--no-abbrev',
            '--no-renames', '--no-ext-diff', '--no-textconv',
            '--ignore-submodules=none',
            base, head, '--',
        )

        return classify(raw)

    except (OSError, subprocess.SubprocessError):
        return 'full'


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Expected exact base and HEAD SHA')

    print(git_route(sys.argv[1], sys.argv[2]))
