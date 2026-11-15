#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'ci_v2_fast_gate',
    Path(__file__).with_name('ci-v2-fast-gate.py'),
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class FastGateTests(unittest.TestCase):
    def results(self, mode='full'):
        r = {name: {'result': 'success'} for name in gate.REQUIRED}
        r['recovery-scope']['outputs'] = {'mode': mode}

        if mode in ('ui', 'push'):
            r['recovery-qualification']['result'] = 'skipped'

        return r

    def test_complete_full_route(self):
        self.assertEqual(gate.validate(self.results()), 'full')

    def test_complete_ui_route(self):
        self.assertEqual(gate.validate(self.results('ui')), 'ui')

    def test_complete_push_route(self):
        self.assertEqual(
            gate.validate(self.results('push'), 'push'), 'push'
        )

    def test_missing_job_blocks(self):
        r = self.results()
        r.pop('backend')
        with self.assertRaises(ValueError):
            gate.validate(r)

    def test_full_route_requires_every_job(self):
        for name in gate.REQUIRED:
            for state in ('skipped', 'failure', 'cancelled', None):
                with self.subTest(name=name, state=state):
                    r = self.results()
                    r[name]['result'] = state
                    with self.assertRaises(ValueError):
                        gate.validate(r)

    def test_ui_cannot_skip_other_jobs(self):
        for name in gate.REQUIRED - {'recovery-qualification'}:
            r = self.results('ui')
            r[name]['result'] = 'skipped'
            with self.assertRaises(ValueError):
                gate.validate(r)

    def test_push_cannot_skip_other_jobs(self):
        for name in gate.REQUIRED - {'recovery-qualification'}:
            r = self.results('push')
            r[name]['result'] = 'skipped'
            with self.assertRaises(ValueError):
                gate.validate(r, 'push')

    def test_failed_recovery_is_never_accepted(self):
        for mode, event in (
            ('full', 'pull_request'),
            ('ui', 'pull_request'),
            ('push', 'push'),
        ):
            for state in ('failure', 'cancelled', None):
                r = self.results(mode)
                r['recovery-qualification']['result'] = state
                with self.assertRaises(ValueError):
                    gate.validate(r, event)

    def test_missing_scope_output_blocks(self):
        r = self.results('ui')
        r['recovery-scope'].pop('outputs')
        with self.assertRaises(ValueError):
            gate.validate(r)

    def test_invalid_scope_output_blocks(self):
        for mode in ('', 'unknown', None, True, 'push'):
            with self.assertRaises(ValueError):
                gate.validate(self.results(mode))

    def test_ui_mode_not_allowed_on_push(self):
        with self.assertRaises(ValueError):
            gate.validate(self.results('ui'), 'push')

    def test_full_mode_not_allowed_on_push(self):
        with self.assertRaises(ValueError):
            gate.validate(self.results(), 'push')

    def test_unknown_event_blocks(self):
        with self.assertRaises(ValueError):
            gate.validate(self.results(), 'workflow_dispatch')


if __name__ == '__main__':
    unittest.main()
