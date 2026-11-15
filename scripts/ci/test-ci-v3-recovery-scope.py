#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'recovery_scope',
    Path(__file__).with_name('ci-v3-recovery-scope.py'),
)
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'CI fixture')
        self.git('config', 'user.email', 'ci@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.filemode', 'true')

        self.write('frontend/src/files/FileThumbnail.tsx', 'old\n')
        self.write('frontend/src/index.css', 'old\n')
        self.write('backend/src/example.ts', 'old\n')
        self.write('frontend/package.json', '{}\n')

        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(
            ['git', '-C', str(self.root), *args],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()

    def write(self, path, content):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return p

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-qm', 'Synthetic fixture')
        return self.git('rev-parse', 'HEAD')

    def route(self):
        return scope.git_route(
            self.base, self.commit(), cwd=self.root
        )

    def test_thumbnail_component(self):
        self.write(
            'frontend/src/files/FileThumbnail.tsx', 'new\n'
        )
        self.assertEqual(self.route(), 'ui')

    def test_css(self):
        self.write('frontend/src/index.css', 'new\n')
        self.assertEqual(self.route(), 'ui')

    def test_new_animation_component(self):
        self.write(
            'frontend/src/ui/animations/FolderMotion.tsx', 'new\n'
        )
        self.assertEqual(self.route(), 'ui')

    def test_ui_component_test(self):
        self.write(
            'frontend/src/files/FileThumbnail.test.tsx', 'test\n'
        )
        self.assertEqual(self.route(), 'ui')

    def test_backend_change(self):
        self.write('backend/src/example.ts', 'new\n')
        self.assertEqual(self.route(), 'full')

    def test_mixed_frontend_backend(self):
        self.write('frontend/src/index.css', 'new\n')
        self.write('backend/src/example.ts', 'new\n')
        self.assertEqual(self.route(), 'full')

    def test_dependencies(self):
        self.write('frontend/package.json', '{"changed":true}\n')
        self.assertEqual(self.route(), 'full')

    def test_frontend_dockerfile(self):
        self.write('frontend/Dockerfile', 'FROM example\n')
        self.assertEqual(self.route(), 'full')

    def test_workflow_change(self):
        self.write('.github/workflows/ci.yml', 'changed\n')
        self.assertEqual(self.route(), 'full')

    def test_classifier_change(self):
        self.write(
            'scripts/ci/ci-v3-recovery-scope.py', 'changed\n'
        )
        self.assertEqual(self.route(), 'full')

    def test_api_change(self):
        self.write('frontend/src/api/client.ts', 'new\n')
        self.assertEqual(self.route(), 'full')

    def test_upload_transport_change(self):
        self.write('frontend/src/files/upload.ts', 'new\n')
        self.assertEqual(self.route(), 'full')

    def test_delete(self):
        (self.root / 'frontend/src/index.css').unlink()
        self.assertEqual(self.route(), 'full')

    def test_rename(self):
        p = self.root / 'frontend/src/index.css'
        p.rename(p.with_name('renamed.css'))
        self.assertEqual(self.route(), 'full')

    def test_executable(self):
        p = self.root / 'frontend/src/index.css'
        p.chmod(0o755)
        self.assertEqual(self.route(), 'full')

    def test_symlink(self):
        p = self.root / 'frontend/src/index.css'
        p.unlink()
        p.symlink_to('../../backend/src/example.ts')
        self.assertEqual(self.route(), 'full')

    def test_unknown_extension(self):
        self.write('frontend/src/ui/example.js', 'new\n')
        self.assertEqual(self.route(), 'full')

    def test_empty_diff(self):
        self.assertEqual(
            scope.git_route(self.base, self.base, cwd=self.root),
            'full',
        )

    def test_invalid_sha(self):
        self.assertEqual(
            scope.git_route('HEAD', self.base, cwd=self.root),
            'full',
        )

    def test_missing_commit(self):
        self.assertEqual(
            scope.git_route('0' * 40, self.base, cwd=self.root),
            'full',
        )

    def test_nonancestor(self):
        self.write('frontend/src/index.css', 'new\n')
        head = self.commit()
        self.assertEqual(
            scope.git_route(head, self.base, cwd=self.root),
            'full',
        )

    def test_malformed_raw_diff(self):
        for raw in (b'', b'broken', b'broken\0path\0'):
            self.assertEqual(scope.classify(raw), 'full')


if __name__ == '__main__':
    unittest.main()
