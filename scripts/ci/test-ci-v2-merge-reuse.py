#!/usr/bin/env python3
import copy
import importlib.util
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'ci_v2_merge_reuse', ROOT / 'scripts/ci/ci-v2-merge-reuse.py'
)
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)


class MergeReuseTests(unittest.TestCase):
    def setUp(self):
        self.base = 'b' * 40
        self.head = 'a' * 40
        self.merge = 'c' * 40
        self.tree = 'd' * 40
        pr = {
            'number': 87,
            'state': 'closed',
            'merged_at': '2026-11-24T00:47:16Z',
            'merge_commit_sha': self.merge,
            'base': {'ref': 'test', 'sha': self.base,
                     'repo': {'full_name': 'sv3t0v1k/homecloud'}},
            'head': {'ref': 'feature', 'sha': self.head,
                     'repo': {'full_name': 'sv3t0v1k/homecloud'}},
        }
        checks = {}
        for index, name in enumerate(reuse.REQUIRED_CHECKS, 101):
            checks[name] = {
                'check': {
                    'id': index,
                    'name': name,
                    'head_sha': self.head,
                    'status': 'completed',
                    'conclusion': 'success',
                    'details_url': f'https://github.com/sv3t0v1k/homecloud/actions/runs/{index}/job/{index + 1000}',
                },
                'run': {
                    'id': index,
                    'event': 'pull_request',
                    'status': 'completed',
                    'conclusion': 'success',
                    'head_sha': self.head,
                    'head_branch': 'feature',
                    'repository': {'full_name': 'sv3t0v1k/homecloud'},
                    'head_repository': {'full_name': 'sv3t0v1k/homecloud'},
                },
            }
        self.data = {
            'ref': 'refs/heads/test',
            'after': self.merge,
            'checkout': self.merge,
            'branch': {'protected': True, 'commit': {'sha': self.merge}},
            'pulls': [pr],
            'merge': {
                'sha': self.merge,
                'parents': [{'sha': self.base}, {'sha': self.head}],
                'commit': {'tree': {'sha': self.tree}},
            },
            'ancestor': True,
            'merge_tree': self.tree,
            'head_tree': self.tree,
            'changed_paths': ['backend/src/example.ts', 'frontend/src/example.tsx'],
            'checks': checks,
        }

    def check(self):
        return reuse.evaluate(self.data, 'sv3t0v1k/homecloud')

    def refused(self):
        with self.assertRaises(reuse.ReuseRefused):
            self.check()

    def test_exact_verified_merge_allows_reuse(self):
        evidence = self.check()
        self.assertEqual(evidence['mode'], 'reuse')
        self.assertEqual(evidence['pr'], 87)
        self.assertEqual(evidence['head'], self.head)
        self.assertEqual(set(evidence['checks']), set(reuse.REQUIRED_CHECKS))

    def test_direct_push_and_ambiguous_pr_block(self):
        for pulls in ([], [self.data['pulls'][0], self.data['pulls'][0]]):
            with self.subTest(count=len(pulls)):
                data = copy.deepcopy(self.data)
                data['pulls'] = pulls
                with self.assertRaises(reuse.ReuseRefused):
                    reuse.evaluate(data, 'sv3t0v1k/homecloud')

    def test_push_identity_and_protection_block(self):
        mutations = (
            ('ref', 'refs/heads/main'),
            ('after', 'e' * 40),
            ('checkout', 'e' * 40),
        )
        for key, value in mutations:
            with self.subTest(key=key):
                self.data[key] = value
                self.refused()
                self.setUp()
        self.data['branch']['protected'] = False
        self.refused()

    def test_unmerged_or_wrong_pr_blocks(self):
        for key, value in (
            ('state', 'open'), ('merged_at', None),
            ('merge_commit_sha', 'e' * 40),
        ):
            with self.subTest(key=key):
                self.data['pulls'][0][key] = value
                self.refused()
                self.setUp()
        self.data['pulls'][0]['base']['ref'] = 'main'
        self.refused()

    def test_fork_pr_blocks(self):
        self.data['pulls'][0]['head']['repo']['full_name'] = 'fork/homecloud'
        self.refused()

    def test_merge_shape_and_parent_binding_block(self):
        for parents in (
            [], [{'sha': self.base}],
            [{'sha': self.head}, {'sha': self.base}],
            [{'sha': self.base}, {'sha': 'e' * 40}],
            [{'sha': self.base}, {'sha': self.head}, {'sha': 'e' * 40}],
        ):
            with self.subTest(parents=parents):
                self.data['merge']['parents'] = parents
                self.refused()
                self.setUp()

    def test_base_must_be_ancestor(self):
        self.data['ancestor'] = False
        self.refused()

    def test_tree_mismatch_blocks(self):
        self.data['head_tree'] = 'e' * 40
        self.refused()

    def test_control_changes_require_full_ci(self):
        for path in (
            '.github/workflows/ci-v2-fast.yml',
            'scripts/ci/ci-v2-merge-reuse.py',
            'deploy/linux/test-channel.py',
        ):
            with self.subTest(path=path):
                self.data['changed_paths'] = [path]
                self.refused()
                self.setUp()

    def test_missing_or_unsuccessful_checks_block(self):
        for name in reuse.REQUIRED_CHECKS:
            with self.subTest(name=name, case='missing'):
                del self.data['checks'][name]
                self.refused()
                self.setUp()
            for field, value in (
                ('status', 'in_progress'), ('conclusion', 'failure'),
                ('conclusion', None), ('head_sha', 'e' * 40),
            ):
                with self.subTest(name=name, field=field, value=value):
                    self.data['checks'][name]['check'][field] = value
                    self.refused()
                    self.setUp()

    def test_check_run_url_and_identity_block(self):
        self.data['checks']['qualify']['check']['details_url'] = 'https://example.com/1'
        self.refused()
        self.setUp()
        self.data['checks']['qualify']['run']['id'] += 1
        self.refused()

    def test_wrong_workflow_provenance_blocks(self):
        mutations = (
            ('event', 'push'), ('status', 'in_progress'),
            ('conclusion', 'failure'), ('head_sha', 'e' * 40),
            ('head_branch', 'other'),
        )
        for field, value in mutations:
            with self.subTest(field=field):
                self.data['checks']['qualify']['run'][field] = value
                self.refused()
                self.setUp()
        self.data['checks']['qualify']['run']['head_repository']['full_name'] = 'fork/homecloud'
        self.refused()

    def test_api_failure_falls_back_to_full_and_required_reuse_blocks(self):
        with patch.object(reuse, 'collect', side_effect=reuse.ReuseRefused('API unavailable')):
            status, evidence = reuse.outcome('event', self.base, 'sv3t0v1k/homecloud')
            self.assertEqual(status, 0)
            self.assertEqual(evidence['mode'], 'full')
            status, evidence = reuse.outcome(
                'event', self.base, 'sv3t0v1k/homecloud', require_reuse=True
            )
            self.assertEqual(status, 1)
            self.assertEqual(evidence['mode'], 'full')

    def test_workflow_reuse_is_limited_to_repeated_push_jobs(self):
        workflow = (ROOT / '.github/workflows/ci-v2-fast.yml').read_text()
        for job in ('pr-fast-backend', 'backend', 'frontend', 'configuration', 'secrets'):
            match = re.search(
                rf'^  {job}:\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)',
                workflow, re.MULTILINE | re.DOTALL,
            )
            self.assertIsNotNone(match, job)
            block = match.group(1)
            self.assertIn('needs: merge-reuse', block, job)
            self.assertIn(
                "if: github.event_name == 'pull_request' || needs.merge-reuse.outputs.mode == 'full'",
                block, job,
            )
        self.assertIn('mode: ${{ steps.classify-reuse.outputs.mode }}', workflow)
        self.assertIn('needs: [recovery-scope, merge-reuse, pr-fast-backend, backend, frontend, configuration, secrets, recovery-qualification]', workflow)
        self.assertIn('Повторно доказать reuse перед публикацией', workflow)
        publication = workflow.split('  test-image:\n', 1)[1]
        self.assertNotIn('merge-reuse.outputs.mode', publication)


if __name__ == '__main__':
    unittest.main()
