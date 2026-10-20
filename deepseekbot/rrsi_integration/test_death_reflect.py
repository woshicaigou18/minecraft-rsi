import json
import tempfile
import unittest
from pathlib import Path
from death_reflect import reflect
from live_domain import action_score


class DeathReflectionTest(unittest.TestCase):
    def model(self, system, user, **kwargs):
        self.assertIn('Distinguish facts from inference', system)
        self.assertIn('Do not change gamerules', system)
        self.assertIn('death.attack.drown', user)
        return {'cause': '服务器报告溺水，行动时未及时上浮。', 'confidence': 'high',
                'evidence': ['death.attack.drown', '头部在水中且氧气接近零'],
                'decision_error': '继续水下寻路而没有先换气。',
                'next_plan': '复活后检查装备，先找安全上岸路线，再决定是否返回。',
                'lesson': '水下行动时持续留意氧气与上浮通道，氧气不足时先换气再继续任务。',
                'topic': 'underwater_air_before_progress', 'scope': 'navigation'}

    def test_death_lessons_persist_without_claiming_rrsi_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            death = {'id': 'drown-1', 'translation': 'death.attack.drown'}
            result = reflect(death, root, self.model)
            self.assertFalse(result['verified'])
            self.assertFalse((root / 'active_guidance.json').exists())
            reflect({**death, 'id': 'drown-2'}, root, self.model)
            self.assertEqual(len(json.loads((root / 'death_guidance.json').read_text(encoding='utf-8'))['lessons']), 1)
            self.assertEqual(len((root / 'death_reflections.jsonl').read_text(encoding='utf-8').splitlines()), 2)
            self.assertEqual(json.loads((root / 'events.jsonl').read_text(encoding='utf-8').splitlines()[-1])['type'], 'death_reflection')

    def test_invalid_review_does_not_write_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                reflect({'id': 'unknown'}, Path(directory), lambda *args, **kwargs: {'cause': 'unknown'})
            self.assertFalse((Path(directory) / 'death_guidance.json').exists())

    def test_action_that_killed_bot_is_failure_even_after_partial_success(self):
        self.assertEqual(action_score({'death_id': 'fall-1', 'outcome': 'Successfully smelted raw_iron.'}), 0)


if __name__ == '__main__':
    unittest.main()
