#!/usr/bin/env python3
"""Verify the native recovery backend context against an exact Git commit."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(root, *args):
    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1")
    return subprocess.check_output(
        ["git", "-C", str(root), *args],
        env=env,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )


def expected_files(root, commit):
    raw = git(
        root, "ls-tree", "-r", "-z", "--full-tree",
        commit, "--", "backend",
    )

    files = {}

    for entry in raw.split(b"\0"):
        if not entry:
            continue

        header, name = entry.split(b"\t", 1)
        mode, kind, oid = header.decode("ascii").split(" ")

        require(kind == "blob", "Unsupported Git object type")
        require(mode in ("100644", "100755"), "Unsupported Git file mode")
        require(re.fullmatch("[a-f0-9]{40}", oid), "Invalid blob identity")

        path = os.fsdecode(name)

        require(path.startswith("backend/"), "Unexpected Git path")

        relative = path[len("backend/"):]
        parts = relative.split("/")

        require(
            all(part not in ("", ".", "..") for part in parts),
            "Invalid Git context path",
        )
        require(relative not in files, "Duplicate Git context path")

        files[relative] = (mode, oid)

    require(files, "Empty backend Git tree")
    require("Dockerfile" in files, "Dockerfile missing")
    require(".dockerignore" in files, "Docker ignore rules missing")

    return files


def inspect_tree(context):
    require(
        stat.S_ISDIR(context.lstat().st_mode),
        "Unsafe backend context root",
    )

    files = set()
    directories = set()

    def walk_error(error):
        raise error

    for current, names, filenames in os.walk(
        context, followlinks=False, onerror=walk_error,
    ):
        current = Path(current)

        for name in names:
            path = current / name
            info = path.lstat()

            require(
                stat.S_ISDIR(info.st_mode),
                "Unsafe context directory",
            )

            directories.add(path.relative_to(context).as_posix())

        for name in filenames:
            path = current / name
            info = path.lstat()

            require(
                stat.S_ISREG(info.st_mode),
                "Non-regular context file",
            )

            files.add(path.relative_to(context).as_posix())

    return files, directories


def blob_identity(path, expected_mode):
    # Read raw bytes, independently of Git filters and index stat cache.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)

    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())

        require(stat.S_ISREG(before.st_mode), "Unsafe context file")
        require(before.st_nlink == 1, "Unexpected hard-linked context file")
        require(
            not (before.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)),
            "Unexpected special file mode",
        )

        executable = bool(before.st_mode & 0o111)

        require(
            executable == (expected_mode == "100755"),
            "Context executable mode mismatch",
        )

        digest = hashlib.sha1()
        digest.update(
            b"blob " + str(before.st_size).encode("ascii") + b"\0"
        )

        count = 0

        for block in iter(lambda: stream.read(1024 * 1024), b""):
            count += len(block)
            digest.update(block)

        after = os.fstat(stream.fileno())

        require(count == before.st_size, "Context file size changed")
        require(
            (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "Context file changed during verification",
        )

        return digest.hexdigest()


def verify(root, commit):
    root = root.resolve()

    require(
        re.fullmatch("[a-f0-9]{40}", commit),
        "Invalid source commit",
    )
    require(
        git(root, "rev-parse", "HEAD").decode().strip() == commit,
        "Checkout source mismatch",
    )

    context = root / "backend"
    expected = expected_files(root, commit)

    expected_dirs = set()

    for name in expected:
        parts = name.split("/")

        for index in range(1, len(parts)):
            expected_dirs.add("/".join(parts[:index]))

    actual_files, actual_dirs = inspect_tree(context)

    # Reject additional paths before reading any of their contents.
    require(
        actual_files == set(expected),
        "Missing or additional context files",
    )
    require(
        actual_dirs == expected_dirs,
        "Missing or additional context directories",
    )

    for name, (mode, oid) in sorted(expected.items()):
        require(
            blob_identity(context / name, mode) == oid,
            "Context file content mismatch",
        )

    tree = git(
        root, "rev-parse", commit + ":backend"
    ).decode().strip()

    require(
        re.fullmatch("[a-f0-9]{40}", tree),
        "Invalid backend tree identity",
    )

    manifest = [
        [name, mode, oid]
        for name, (mode, oid) in sorted(expected.items())
    ]

    return {
        "format": "homecloud-recovery-context-v1",
        "source_commit": commit,
        "context": "backend",
        "git_tree": tree,
        "files": len(expected),
        "directories": len(expected_dirs),
        "manifest_sha256": hashlib.sha256(
            json.dumps(manifest, separators=(",", ":")).encode()
        ).hexdigest(),
        "status": "EXACT_CONTEXT_VERIFIED",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    root = Path.cwd()
    output = root / args.output

    try:
        require(
            args.output == "backend.context.binding.json",
            "Unexpected context evidence path",
        )

        result = verify(root, args.commit)

        with output.open("x") as stream:
            json.dump(result, stream, indent=2)
            stream.write("\n")

        print(
            "PASS: exact backend build context;",
            result["files"], "files;",
            result["directories"], "directories",
        )

    except (
        OSError, ValueError, subprocess.SubprocessError,
    ):
        # Do not print filenames or untrusted file contents.
        print("BLOCKED: backend context verification failed", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
