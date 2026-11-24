#!/usr/bin/env python3
"""Adversarial tests using only a small synthetic Git repository."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().with_name(
    "verify-recovery-context.py"
)

spec = importlib.util.spec_from_file_location("context_verifier", SCRIPT)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class ContextTests(unittest.TestCase):

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(
            prefix="hc-context-fixture-"
        )

        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

        env = {
            k: value for k, value in os.environ.items()
            if not k.startswith("GIT_")
        }

        env.update(
            GIT_CONFIG_NOSYSTEM="1",
            GIT_CONFIG_GLOBAL=os.devnull,
            GIT_NO_REPLACE_OBJECTS="1",
        )

        environment = patch.dict(os.environ, env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

        self.git("init", "-q", "--object-format=sha1")
        self.git("config", "user.name", "HomeCloud Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.filemode", "true")

        self.write(".gitignore", "backend/ignored.fixture\n")
        self.write("backend/Dockerfile", "FROM scratch\n")
        self.write("backend/.dockerignore", "# fixture\n")
        self.write("backend/src/example.js", "original\n")
        self.write("backend/script.sh", "#!/bin/sh\n")

        (self.root / "backend/script.sh").chmod(0o755)

        self.git("add", ".")
        self.git("commit", "-qm", "synthetic context")

        self.commit = self.git("rev-parse", "HEAD").decode().strip()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args],
            stderr=subprocess.DEVNULL,
            timeout=15,
        )

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def verify(self):
        return v.verify(self.root, self.commit)

    def blocked(self):
        with self.assertRaises((ValueError, OSError)):
            self.verify()

    def cli(self):
        return subprocess.run(
            [
                sys.executable, "-B", str(SCRIPT),
                "--commit", self.commit,
                "--output", "backend.context.binding.json",
            ],
            cwd=self.root,
            capture_output=True,
            timeout=30,
        )

    def test_exact_context_passes(self):
        result = self.verify()

        self.assertEqual(result["status"], "EXACT_CONTEXT_VERIFIED")
        self.assertEqual(result["files"], 4)
        self.assertEqual(result["source_commit"], self.commit)

        process = self.cli()
        self.assertEqual(process.returncode, 0)

        evidence = self.root / "backend.context.binding.json"
        self.assertEqual(json.loads(evidence.read_text()), result)

    def test_ignored_file_blocks_even_with_clean_git_status(self):
        self.write("backend/ignored.fixture", "synthetic extra\n")

        self.assertEqual(self.git("status", "--porcelain"), b"")

        self.blocked()

        process = self.cli()
        self.assertEqual(process.returncode, 1)

        evidence = self.root / "backend.context.binding.json"
        self.assertFalse(evidence.exists())

    def test_untracked_file_blocks(self):
        self.write("backend/untracked.fixture", "extra\n")
        self.blocked()

    def test_assume_unchanged_does_not_hide_modified_bytes(self):
        self.git(
            "update-index", "--assume-unchanged",
            "backend/src/example.js",
        )

        self.write("backend/src/example.js", "modified\n")

        self.assertEqual(self.git("status", "--porcelain"), b"")
        self.blocked()

    def test_missing_tracked_file_blocks(self):
        (self.root / "backend/src/example.js").unlink()
        self.blocked()

    def test_executable_mode_mismatch_blocks(self):
        (self.root / "backend/script.sh").chmod(0o644)
        self.blocked()

    def test_symlink_substitution_blocks(self):
        path = self.root / "backend/src/example.js"
        path.unlink()
        path.symlink_to("../Dockerfile")
        self.blocked()

    def test_additional_empty_directory_blocks(self):
        (self.root / "backend/extra-directory").mkdir()

        self.assertEqual(self.git("status", "--porcelain"), b"")
        self.blocked()


if __name__ == "__main__":
    unittest.main()
