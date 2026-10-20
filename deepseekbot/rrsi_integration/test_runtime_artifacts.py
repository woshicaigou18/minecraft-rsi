import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import live_propose
from live_select import select
from runtime_artifacts import build, preflight


def skill_proposal():
    return {'component': 'skill', 'scope': 'mining', 'topic': 'clear_inventory_then_collect',
        'hypothesis': 'Conditional inventory preparation avoids full inventory failures.',
        'change': 'Execute a reusable inventory-aware gathering workflow.',
        'expected_effect': 'Fewer failed gathering attempts.', 'evidence': 'Full inventory caused repeated collection failures.',
        'artifact': {'kind': 'skill', 'target': '!collectBlocks', 'name': 'inventory_aware_gather', 'steps': [
            {'command': '!discard', 'args': ['diorite', {'inventory': 'diorite'}],
             'when': {'all': [{'inventory_full': True}, {'has_item': {'name': 'diorite', 'min': 1}}]}},
            {'command': '!collectBlocks', 'args': [{'arg': 0}, {'arg': 1}]}]}}


class RuntimeArtifactTest(unittest.TestCase):
    def test_executable_skill_changes_behavior_in_isolated_fixtures(self):
        report = preflight(build(skill_proposal()))
        self.assertTrue(report['passed'], report)
        full = next(row for row in report['reports'] if row['scenario'] == 'full_inventory')
        self.assertFalse(full['baseline_success'])
        self.assertTrue(full['candidate_success'])

    def test_tool_recovery_and_config_pass_the_executable_gate(self):
        for artifact in [
            {'kind': 'client_tool', 'target': '!placeHere', 'before': [], 'attempts': 2,
             'on_failure': [{'command': '!moveAway', 'args': [3]}]},
            {'kind': 'config', 'target': '!searchForBlock', 'values': {'search_slice_ms': 2}}
        ]:
            report = preflight(artifact)
            self.assertTrue(report['passed'], report)

    def test_invalid_or_no_op_artifacts_are_not_executed(self):
        for artifact in [
            {'kind': 'skill', 'target': '!collectBlocks', 'name': 'no_op', 'steps': [
                {'command': '!collectBlocks', 'args': [{'arg': 0}, {'arg': 1}]}]},
            {'kind': 'client_tool', 'target': '!placeHere', 'attempts': 999},
            {'kind': 'config', 'target': '!dive', 'values': {'dive_air_margin_seconds': 0}},
            {'kind': 'skill', 'target': '!collectBlocks', 'name': 'bad_reference', 'steps': [
                {'command': '!restart', 'args': []}, {'command': '!collectBlocks', 'args': [{'arg': 0}, {'arg': 1}]}]}
        ]:
            self.assertFalse(preflight(artifact)['passed'])

    def test_preflight_feedback_can_repair_one_candidate_before_trial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = {'command': '!collectBlocks', 'action': True, 'tokens': 100,
                'outcome': 'Failed: inventory full', 'trial_round': None}
            (root / 'events.jsonl').write_text((json.dumps(baseline) + '\n') * 4)
            bad = skill_proposal()
            bad['artifact']['steps'][0]['args'][1] = 32
            with patch.object(live_propose, 'propose', return_value=bad), \
                 patch.object(live_propose, 'repair_artifact', return_value=skill_proposal()) as repair, \
                 patch.object(live_propose, 'critic', return_value={'verdict': 'accept', 'reason': 'testable'}):
                result = live_propose.run(root / 'events.jsonl', root / 'proposals.jsonl', root / 'history.jsonl')
            self.assertEqual(result['status'], 'trial_started')
            self.assertEqual(repair.call_count, 1)
            self.assertTrue(any(row['status'] == 'preflight_repair' for row in live_propose.read_jsonl(root / 'proposals.jsonl')))

    def run_trial(self, root):
        baseline = {'command': '!collectBlocks', 'action': True, 'tokens': 100,
                    'outcome': 'Failed: inventory is full.', 'trial_round': None}
        (root / 'events.jsonl').write_text((json.dumps(baseline) + '\n') * 4)
        with patch.object(live_propose, 'propose', return_value=skill_proposal()), \
             patch.object(live_propose, 'critic', return_value={'verdict': 'accept', 'reason': 'testable'}):
            result = live_propose.run(root / 'events.jsonl', root / 'proposals.jsonl', root / 'history.jsonl')
        self.assertEqual(result['status'], 'trial_started')
        trial = json.loads((root / 'trial.json').read_text(encoding='utf-8'))
        self.assertTrue(trial['preflight']['passed'])
        return trial, baseline

    def test_end_to_end_propose_preflight_trial_select_and_promote_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trial, _ = self.run_trial(root)
            candidate = {'time': datetime.now(timezone.utc).isoformat(), 'command': '!collectBlocks',
                'action': True, 'tokens': 90, 'outcome': 'Collected 3 iron_ore.', 'trial_round': trial['round'],
                'artifact_id': trial['artifact']['id'], 'artifact_variant': 'trial'}
            with (root / 'events.jsonl').open('a') as stream:
                stream.write((json.dumps(candidate) + '\n') * 4)
            result = select(root / 'events.jsonl', root / 'trial.json', root / 'active_guidance.json', root / 'decisions.jsonl')
            self.assertEqual(result['status'], 'selected')
            self.assertEqual(result['extension_count'], 1)
            self.assertFalse((root / 'active_guidance.json').exists())
            active = json.loads((root / 'active_extensions.json').read_text(encoding='utf-8'))
            self.assertEqual(active['artifacts'][0]['kind'], 'skill')
            self.assertEqual(active['revision'], 1)

    def test_actions_without_actual_artifact_execution_do_not_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trial, _ = self.run_trial(root)
            candidate = {'time': datetime.now(timezone.utc).isoformat(), 'command': '!collectBlocks',
                'action': True, 'tokens': 90, 'outcome': 'Collected 3 iron_ore.', 'trial_round': trial['round']}
            with (root / 'events.jsonl').open('a') as stream:
                stream.write((json.dumps(candidate) + '\n') * 4)
            result = select(root / 'events.jsonl', root / 'trial.json', root / 'active_guidance.json', root / 'decisions.jsonl')
            self.assertEqual(result['status'], 'collecting')
            self.assertEqual(result['count'], 0)

    def test_quarantined_candidate_is_removed_before_more_measurements(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trial, _ = self.run_trial(root)
            (root / 'extension_quarantine.json').write_text(json.dumps({'ids': [trial['artifact']['id']]}))
            result = select(root / 'events.jsonl', root / 'trial.json', root / 'active_guidance.json', root / 'decisions.jsonl')
            self.assertEqual(result['status'], 'reverted')
            self.assertFalse((root / 'trial.json').exists())


if __name__ == '__main__':
    unittest.main()
