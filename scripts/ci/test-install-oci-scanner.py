#!/usr/bin/env python3
"""Негативные тесты OCI-установщика без доступа к Docker."""

import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).with_name(
    "install-oci-scanner.sh"
)

FAKE_DOCKER = r'''#!/bin/sh
set -eu
[ "${MOCK_FAIL:-}" != "$1" ] || exit 77
case "$1" in
  pull)
    test "$2" = '--platform'
    test "$3" = 'linux/amd64'
    case "$4" in
      ghcr.io/aquasecurity/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb|ghcr.io/sv3t0v1k/homecloud-sec02-gitleaks@sha256:e86133002f108ce5e58225e0bda5613b42fb58ad7e0f136161a8fa67e3ab6257|ghcr.io/sv3t0v1k/homecloud-sec02-compose@sha256:90572c9597798a70d6d96ccdcebd68a90ed58050730d4f27d63379fb53a3ed28)
        ;;
      *) exit 77 ;;
    esac
    ;;
  image)
    printf '%s\n' "${MOCK_PLATFORM:-linux/amd64}"
    ;;
  create)
    printf '%s\n' 'scanner-test-container'
    ;;
  cp)
    case "$2" in
      scanner-test-container:/usr/local/bin/trivy|scanner-test-container:/usr/bin/gitleaks|scanner-test-container:/docker-compose)
        ;;
      *) exit 2 ;;
    esac
    cp "$MOCK_SCANNER" "$3"
    ;;
  rm)
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
'''


class InstallerTests(unittest.TestCase):
    def invoke(self, tool="trivy", version="Version: 0.76.2",
               exit_code=0, platform="linux/amd64",
               missing=False, existing=False, symlink=False,
               wrong_digest=False, wrong_binary=False,
                fail_operation=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindir = root / "bin"
            bindir.mkdir()

            docker = bindir / "docker"
            docker.write_text(FAKE_DOCKER)
            docker.chmod(0o755)

            scanner = root / "scanner"
            scanner.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' " + shlex.quote(version) + "\n"
                "exit " + str(exit_code) + "\n"
            )
            scanner.chmod(0o755)

            if missing:
                scanner.unlink()

            target = root / "installed"
            if existing:
                target.write_text("existing")
            if symlink:
                target.symlink_to(root / "outside")

            # Меняем SHA только в изолированной тестовой копии:
            # проверка реального содержимого остаётся активной.
            script = root / "test-installer.sh"
            source = INSTALLER.read_text()

            image_digests = {
                "trivy": "8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb",
                "gitleaks": "e86133002f108ce5e58225e0bda5613b42fb58ad7e0f136161a8fa67e3ab6257",
                "compose": "90572c9597798a70d6d96ccdcebd68a90ed58050730d4f27d63379fb53a3ed28",
            }

            binary_digests = {
                "gitleaks": "b37d4b1499ebfa3281183e357c21dd8e1f678d9760ff1508a6cab9e1585668ea",
                "compose": "a9e710eba0ded73a609b47c9c9383711686778acf8aed71407850c14a627287d",
            }

            if tool in binary_digests and not missing and not wrong_binary:
                expected = hashlib.sha256(scanner.read_bytes()).hexdigest()
                source = source.replace(binary_digests[tool], expected)

            if wrong_digest:
                source = source.replace(image_digests[tool], "0" * 64)

            script.write_text(source)

            env = dict(os.environ)
            env["PATH"] = str(bindir) + os.pathsep + env["PATH"]
            env["MOCK_SCANNER"] = str(scanner)
            env["MOCK_PLATFORM"] = platform
            env["MOCK_FAIL"] = fail_operation

            return subprocess.run(
                ["sh", str(script), tool, str(target)],
                env=env,
                capture_output=True,
                text=True,
            )

    def test_valid_trivy(self):
        self.assertEqual(self.invoke().returncode, 0)

    def test_previous_scanner_version_blocks(self):
        self.assertNotEqual(self.invoke(version="Version: 0.76.0").returncode, 0)

    def test_valid_gitleaks(self):
        self.assertEqual(
            self.invoke("gitleaks", "v8.30.1").returncode,
            0,
        )

    def test_valid_compose(self):
        self.assertEqual(self.invoke("compose", "5.8.1").returncode, 0)

    def test_old_compose_version_blocks(self):
        self.assertNotEqual(self.invoke("compose", "5.6.0").returncode, 0)

    def test_wrong_compose_image_digest_blocks(self):
        result = self.invoke("compose", "5.8.1", wrong_digest=True)
        self.assertNotEqual(result.returncode, 0)

    def test_wrong_gitleaks_image_digest_blocks(self):
        result = self.invoke("gitleaks", "8.30.1", wrong_digest=True)
        self.assertNotEqual(result.returncode, 0)

    def test_wrong_compose_binary_blocks(self):
        result = self.invoke("compose", "5.8.1", wrong_binary=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OCI tool binary SHA256 mismatch", result.stderr)

    def test_wrong_gitleaks_binary_blocks(self):
        result = self.invoke("gitleaks", "8.30.1", wrong_binary=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OCI tool binary SHA256 mismatch", result.stderr)

    def test_compose_pull_failure_blocks(self):
        result = self.invoke("compose", "5.8.1", fail_operation="pull")
        self.assertNotEqual(result.returncode, 0)

    def test_gitleaks_copy_failure_blocks(self):
        result = self.invoke("gitleaks", "8.30.1", fail_operation="cp")
        self.assertNotEqual(result.returncode, 0)

    def test_trivy_stdout_with_error_exit_blocks(self):
        result = self.invoke(exit_code=7)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("PASS: verified", result.stdout)

    def test_wrong_version_blocks(self):
        self.assertNotEqual(
            self.invoke(version="Version: 0.1.0").returncode,
            0,
        )

    def test_wrong_platform_blocks(self):
        self.assertNotEqual(
            self.invoke(platform="linux/arm64").returncode,
            0,
        )

    def test_wrong_digest_blocks(self):
        self.assertNotEqual(
            self.invoke(wrong_digest=True).returncode,
            0,
        )

    def test_missing_binary_blocks(self):
        self.assertNotEqual(
            self.invoke(missing=True).returncode,
            0,
        )

    def test_existing_destination_blocks(self):
        self.assertNotEqual(
            self.invoke(existing=True).returncode,
            0,
        )

    def test_symlink_destination_blocks(self):
        self.assertNotEqual(
            self.invoke(symlink=True).returncode,
            0,
        )


if __name__ == "__main__":
    unittest.main()
