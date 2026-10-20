import json
import tempfile
import unittest
from pathlib import Path

from live_select import select


def action(time, failed, tokens=100, command="!newAction"):
    return {"time": time, "command": command, "action": True,
            "outcome": "done", "failed": failed, "tokens": tokens}


class LiveSelectionTest(unittest.TestCase):
    def run_trial(self, before, after, feedback=None, command="!newAction", scope="general", existing_rules=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events, trial, active, decisions = [root / name for name in
                                                 ("events.jsonl", "trial.json", "active.json", "decisions.jsonl")]
            trial.write_text(json.dumps({"round": 0, "guidance": "Check the build area first.",
                                         "component": "prompt", "scope": scope, "started": "2026-01-01T00:00:00Z",
                                         "baseline": [action(f"2025-01-01T00:00:0{i + 1}Z", failure, command=command)
                                                      for i, failure in enumerate(before)]}))
            events.write_text("".join(json.dumps(action(f"2026-01-01T00:00:0{i + 1}Z", failure, command=command)) + "\n"
                                      for i, failure in enumerate(after)))
            if feedback:
                (root / "feedback.jsonl").write_text(json.dumps(feedback) + "\n")
            if existing_rules:
                active.write_text(json.dumps({"version": 2, "rules": existing_rules}))
            result = select(events, trial, active, decisions)
            return result, active.exists(), trial.exists()

    def test_promotes_measured_gain(self):
        result, active, trial = self.run_trial([True, True, False, False],
                                               [False, False, False, False])
        self.assertEqual(result["status"], "selected")
        self.assertTrue(active)
        self.assertFalse(trial)

    def test_reverts_when_no_gain(self):
        result, active, trial = self.run_trial([False] * 4, [False] * 4)
        self.assertEqual(result["status"], "reverted")
        self.assertFalse(active)
        self.assertFalse(trial)

    def test_regular_crafting_actions_can_promote_and_accumulate(self):
        result, active, _ = self.run_trial([True, True, False, False], [False] * 4,
            command="!craftRecipe", scope="crafting", existing_rules=[{
                "topic": "mine_safely", "guidance": "Check the mining area.", "scope": "mining"}])
        self.assertEqual(result["status"], "selected")
        self.assertEqual(result["rule_count"], 2)
        self.assertTrue(active)

    def test_player_feedback_corrects_baseline_reward(self):
        result, active, _ = self.run_trial([False] * 4, [False] * 4,
                                           {"action_time": "2025-01-01T00:00:01Z", "failed": True})
        self.assertEqual(result["status"], "selected")
        self.assertTrue(active)


if __name__ == "__main__":
    unittest.main()
