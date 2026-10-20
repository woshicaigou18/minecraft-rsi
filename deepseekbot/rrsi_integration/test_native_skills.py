import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import live_propose
from runtime_artifacts import build, preflight, stage_native
from live_select import select_new_skills


def proposal():
    return {'component': 'skill', 'scope': 'navigation', 'topic': 'water_preparation_check',
        'hypothesis': 'A reusable pre-dive calculation fills a missing capability.',
        'change': 'Add a new JavaScript capability that inspects air and computes a recommendation.',
        'expected_effect': 'Water tasks can check current resources before committing.',
        'evidence': 'Previous attempts ran low on oxygen.',
        'artifact': {'kind': 'skill', 'implementation': 'javascript', 'name': 'water_check',
            'target': '!skill_water_check', 'description': 'Inspect air and health before diving.', 'parameters': [],
            'postcondition': {'type': 'state_report', 'fields': ['health', 'oxygen']},
            'source': 'async function run(api,args) { const s=await api.state(); return {success:true,message:"checked",data:{health:s.health,oxygen:s.oxygen,seconds:Math.max(0,s.oxygen*0.75-5)}}; }',
            'tests': [{'name': 'air', 'args': [], 'state': {'oxygen': 20}, 'expect_success': True, 'expected_data': {'seconds': 10}},
                      {'name': 'low air', 'args': [], 'state': {'oxygen': 2}, 'expect_success': True, 'expected_data': {'seconds': 0}}]}}


class NewNativeSkillTest(unittest.TestCase):
    def test_source_file_preserves_hashed_newlines_on_windows(self):
        p = proposal()
        p['artifact']['source'] = p['artifact']['source'].replace('; ', ';\n  ')
        artifact = build(p)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage_native(artifact, root)
            content = (root / 'skills' / artifact['id'] / 'skill.js').read_bytes()
            source = content.removeprefix(b'export default ').strip()
            self.assertEqual(hashlib.sha256(source).hexdigest(), artifact['source_sha256'])

    def test_new_source_executes_and_computed_outputs_are_checked(self):
        report = preflight(build(proposal()))
        self.assertTrue(report['passed'], report)

    def test_new_skill_writes_source_registers_without_borrowed_baseline_and_validates_real_uses(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            p = proposal()
            with patch.object(live_propose, 'propose', return_value=p), \
                 patch.object(live_propose, 'write_native_skill', return_value=p), \
                 patch.object(live_propose, 'critic', return_value={'verdict': 'accept', 'reason': 'new capability'}):
                result = live_propose.run(root / 'events.jsonl', root / 'proposals.jsonl', root / 'history.jsonl', 'create a new water check')
            self.assertEqual(result['status'], 'skill_added')
            artifact = json.loads((root / 'probation_skills.json').read_text(encoding='utf-8'))['artifacts'][0]
            self.assertIn('async function run', (root / 'skills' / artifact['id'] / 'skill.js').read_text())
            self.assertTrue((root / 'skills' / artifact['id'] / 'tests.json').exists())
            self.assertFalse((root / 'trial.json').exists(), 'a new capability must not block existing RRSI trials')
            self.assertFalse((root / 'active_extensions.json').exists(), 'passing simulation is not live validation')
            for i in range(4):
                with (root / 'extension_executions.jsonl').open('a') as stream:
                    stream.write(json.dumps({'artifact_id': artifact['id'], 'artifact_variant': 'probation',
                        'native_verified': True, 'duration_ms': 200, 'interrupted': False}) + '\n')
            decision = select_new_skills(root)
            self.assertEqual(decision['accepted'], 1)
            selected = json.loads((root / 'active_extensions.json').read_text(encoding='utf-8'))['artifacts'][0]
            self.assertEqual(selected['implementation'], 'javascript')
            self.assertIn('no paired incumbent', selected['evidence']['measurement'])


if __name__ == '__main__':
    unittest.main()
