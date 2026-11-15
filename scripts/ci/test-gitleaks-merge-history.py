#!/usr/bin/env python3
"""Verify merge-only secret detection with the pinned Gitleaks scanner."""
import argparse
import json
import os
from pathlib import Path
import random
import shlex
import string
import subprocess
import tempfile

FORBIDDEN = "scripts/tests/" + "PHASE-5.3.1-TEST-AUDIT.md"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scanner")
    parser.add_argument("--log-opts", required=True)
    args = parser.parse_args()

    opts = shlex.split(args.log_opts)
    require(opts == [
        "--full-history", "--all", "--diff-merges=first-parent",
        "--", ".", ":(exclude)" + FORBIDDEN,
    ], "Unexpected history scan options")

    env = {
        k: v for k, v in os.environ.items()
        if not k.startswith(("GIT_", "GITLEAKS_"))
    }
    env.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_NO_REPLACE_OBJECTS="1",
    )

    scanner = str(Path(args.scanner).resolve()) if args.scanner else None

    with tempfile.TemporaryDirectory(prefix="hc-merge-fixture-") as tmp:
        root = Path(tmp) / "fixture"
        root.mkdir()

        def git(*command, rc=0):
            result = subprocess.run(
                ["git", *command], cwd=root, env=env,
                capture_output=True, text=True, timeout=30,
            )
            require(result.returncode == rc,
                    "Fixture Git command failed: " + command[0])
            return result.stdout.strip()

        def write(path, content):
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content + "\n")

        rng = random.Random(20261115)
        alphabet = string.ascii_letters + string.digits

        def canary():
            return "gh" + "p_" + "".join(
                rng.choice(alphabet) for _ in range(36)
            )

        left_secret, right_secret, merge_secret, excluded = [
            canary() for _ in range(4)
        ]

        def commit(message):
            git("add", ".")
            git("commit", "-qm", message)
            return git("rev-parse", "HEAD")

        git("init", "-q", "-b", "main")
        git("config", "user.name", "HomeCloud Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "commit.gpgsign", "false")

        write("conflict.txt", "base")
        commit("fixture base")
        git("branch", "side")

        write("conflict.txt", "left parent")
        write("left.txt", left_secret)
        left = commit("left fixture")

        git("checkout", "-q", "side")
        write("conflict.txt", "right parent")
        write("right.txt", right_secret)
        right = commit("right fixture")

        git("checkout", "-q", "main")
        git("merge", "--no-ff", "--no-commit", "side", rc=1)

        write("conflict.txt", merge_secret)
        write(FORBIDDEN, excluded)
        merged = commit("merge resolution fixture")

        require(
            len(git("rev-list", "--parents", "-n", "1", merged).split()) == 3,
            "Expected a real merge commit",
        )

        old_opts = [o for o in opts if o != "--diff-merges=first-parent"]
        old_patch = git("log", "-p", "-U0", *old_opts)
        patch = git("log", "-p", "-U0", *opts)

        require(merge_secret not in old_patch, "Old scan unexpectedly detects merge")
        require(all(x in patch for x in (
            left_secret, right_secret, merge_secret,
        )), "Required history patch missing")
        require(excluded not in patch, "Excluded fixture was read")

        print("PASS: previous merge-only blind spot reproduced")
        print("PASS: new Git options include both branches and merge")
        print("PASS: excluded synthetic path absent from patches")

        if not scanner:
            print("Git-only regression PASS; exact scanner test pending CI")
            return

        version = subprocess.check_output(
            [scanner, "version"], env=env, text=True, timeout=15,
        ).strip()
        require(version in ("8.30.1", "v8.30.1"), "Unexpected scanner version")

        report = Path(tmp) / "report.json"

        result = subprocess.run(
            [scanner, "git", "--redact=100", "--exit-code", "42",
             "--report-format", "json", "--report-path", str(report),
             "--log-opts=" + args.log_opts, "."],
            cwd=root, env=env, capture_output=True, timeout=120,
        )

        require(result.returncode == 42 and report.is_file(),
                "Pinned scanner did not detect synthetic findings")

        findings = json.loads(report.read_bytes())
        require(isinstance(findings, list), "Invalid fixture report")

        actual = {
            (f["Commit"], f["File"], f["RuleID"]) for f in findings
        }
        expected = {
            (left, "left.txt", "github-pat"),
            (right, "right.txt", "github-pat"),
            (merged, "conflict.txt", "github-pat"),
        }

        require(expected <= actual, "Required scanner finding missing")
        require(all(f["File"] != FORBIDDEN for f in findings),
                "Excluded fixture appeared in report")
        require(all(f["Secret"] == "REDACTED" for f in findings),
                "Fixture report not redacted")

        print("PASS: Gitleaks detected merge-only secret")
        print("PASS: Gitleaks detected secrets on both branches")
        print("PASS: Gitleaks excluded synthetic audit path")


if __name__ == "__main__":
    main()
