import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone

from live_domain import action_score, save_rule, load_rules, duration_references, reward
from live_select import select


class LiveDomainTest(unittest.TestCase):
    def test_navigation_timing_only_compares_identical_command_arguments(self):
        baseline = {'command': '!searchForBlock', 'args': ['lava', 64], 'duration_ms': 1000, 'outcome': 'You have reached the goal.'}
        references = duration_references([baseline, baseline])
        self.assertGreater(reward({**baseline, 'duration_ms': 500}, references), reward(baseline, references))
        self.assertEqual(reward({**baseline, 'args': ['lava', 128], 'duration_ms': 100}, references), 0.9)
        self.assertEqual(action_score({'outcome': '潜水未达到目标深度；未能上浮。'}), 0)

    def test_parallel_smelting_compares_time_per_actual_produced_item(self):
        baseline = {"command": "!smeltItem", "args": ["raw_iron", 5], "outcome": "Successfully smelted 5 raw_iron.",
                    "duration_ms": 50000, "before": {"inventory": {}}, "after": {"inventory": {"iron_ingot": 5}}}
        candidate = {**baseline, "command": "!newAction", "args": ["smelt iron with parallel furnaces"], "duration_ms": 25000}
        references = duration_references([baseline, baseline])
        self.assertGreater(reward(candidate, references), reward(baseline, references))
        self.assertLessEqual(reward({**candidate, "duration_ms": None}, references), reward(baseline, references))

    def test_failed_placement_and_missing_materials_do_not_score_as_success(self):
        for text in ("Failed to place furnace at (-1, 32, -2).",
                     "You do not have the resources to craft a crafting_table.",
                     "You have no fuel to smelt raw_iron."):
            self.assertEqual(action_score({"outcome": text, "failed": False}), 0)

    def test_success_after_path_warning_and_partial_collection(self):
        self.assertEqual(action_score({"outcome": "Path not found. You have reached at 1, 2, 3."}), 1)
        self.assertEqual(action_score({"outcome": "Failed to collect. Collected 2 iron_ore."}), 0.5)

    def test_player_feedback_overrides_parser(self):
        self.assertEqual(action_score({"outcome": "Failed to place.", "feedback_reward": 1}), 1)

    def test_rules_accumulate_and_same_topic_is_revised(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "rules.json"
            save_rule(target, {"topic": "mining", "guidance": "Old mining strategy"})
            save_rule(target, {"topic": "smelting", "guidance": "Smelting strategy"})
            save_rule(target, {"topic": "mining", "guidance": "Revised mining strategy"})
            self.assertEqual(len(load_rules(target)), 2)
            self.assertEqual(load_rules(target)[-1]["guidance"], "Revised mining strategy")

    def test_unrelated_actions_do_not_complete_a_crafting_trial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            started = datetime.now(timezone.utc) - timedelta(minutes=9)
            row = {"command": "!craftRecipe", "action": True, "tokens": 100,
                   "outcome": "Successfully crafted stick.", "failed": False}
            (root / "trial.json").write_text(json.dumps({"round": 0, "scope": "crafting",
                "component": "prompt", "guidance": "Check crafting ingredients.",
                "started": started.isoformat(), "baseline": [row] * 4}))
            other = {**row, "command": "!smeltItem", "time": datetime.now(timezone.utc).isoformat()}
            (root / "events.jsonl").write_text((json.dumps(other) + "\n") * 4)
            result = select(root / "events.jsonl", root / "trial.json", root / "active.json", root / "decisions.jsonl")
            self.assertEqual(result["status"], "expired")
            self.assertFalse((root / "active.json").exists())


if __name__ == "__main__":
    unittest.main()
