#!/usr/bin/env python3
"""Тесты подписи release-lock (release.py sign-lock / verify-lock-sig).

Проверяет: эталонный вектор RFC 8032 (детерминированная подпись Ed25519 —
любая корректная реализация обязана дать те же байты), roundtrip,
отказ при подмене lock, при чужом приватном ключе, без секрета и при
подписи неправильной длины. Все отказы fail-closed (exit != 0).
"""
import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CI = Path(__file__).resolve().parent
RELEASE = CI / 'release.py'

# RFC 8032, Test 2 (сообщение из одного байта 0x72; пустое сообщение
# openssl pkeyutl не подписывает — отказ выделения 0-байтового буфера).
RFC_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
RFC_PUBLIC = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
RFC_MESSAGE = bytes([0x72])
RFC_SIGNATURE = ('92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da'
                 '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00')
PKCS8_PREFIX = bytes.fromhex('302e020100300506032b657004220420')
SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')

PRIVATE_B64 = base64.b64encode(PKCS8_PREFIX + bytes.fromhex(RFC_SEED)).decode()
PUBLIC_B64 = base64.b64encode(SPKI_PREFIX + bytes.fromhex(RFC_PUBLIC)).decode()


def run_release(*arguments, private='keep'):
    env = dict(os.environ)
    if private == 'keep':
        pass
    elif private is None:
        env.pop('RELEASE_SIGNING_PRIVATE_KEY_B64', None)
    else:
        env['RELEASE_SIGNING_PRIVATE_KEY_B64'] = private
    return subprocess.run([sys.executable, str(RELEASE), *arguments],
                          capture_output=True, text=True, env=env)


class ReleaseSignTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.lock = root / 'release-lock.json'
        self.lock.write_bytes(b'{"format":"homecloud-ci-candidate-v1"}\n')
        self.signature = root / 'release-lock.json.sig'
        self.public = root / 'public.b64'
        self.public.write_text(PUBLIC_B64 + '\n')

    def tearDown(self):
        self.directory.cleanup()

    def sign(self, private=PRIVATE_B64):
        return run_release('sign-lock', '--lock', str(self.lock),
                           '--signature', str(self.signature),
                           '--public-key', str(self.public), private=private)

    def verify(self):
        return run_release('verify-lock-sig', '--lock', str(self.lock),
                           '--signature', str(self.signature),
                           '--public-key', str(self.public), private=None)

    def test_rfc8032_deterministic_vector(self):
        self.lock.write_bytes(RFC_MESSAGE)
        result = self.sign()
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = base64.b64encode(bytes.fromhex(RFC_SIGNATURE)).decode()
        self.assertEqual(self.signature.read_text().strip(), expected)
        self.assertEqual(self.verify().returncode, 0)

    def test_roundtrip(self):
        self.assertEqual(self.sign().returncode, 0)
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tampered_lock_rejected(self):
        self.assertEqual(self.sign().returncode, 0)
        self.lock.write_bytes(self.lock.read_bytes() + b' ')
        self.assertNotEqual(self.verify().returncode, 0)

    def test_foreign_private_key_blocked(self):
        foreign = base64.b64encode(PKCS8_PREFIX + os.urandom(32)).decode()
        self.assertNotEqual(self.sign(private=foreign).returncode, 0)
        self.assertFalse(self.signature.exists())

    def test_missing_private_key_blocked(self):
        result = self.sign(private=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('RELEASE_SIGNING_PRIVATE_KEY_B64', result.stderr)

    def test_short_signature_rejected(self):
        self.signature.write_text(base64.b64encode(os.urandom(32)).decode() + '\n')
        self.assertNotEqual(self.verify().returncode, 0)

    def test_garbage_public_key_rejected(self):
        self.public.write_text('not base64 !!!\n')
        self.assertNotEqual(self.sign().returncode, 0)


if __name__ == '__main__':
    unittest.main()
