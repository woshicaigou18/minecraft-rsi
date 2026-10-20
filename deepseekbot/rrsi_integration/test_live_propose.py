import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import live_propose


class LiveProposalTest(unittest.TestCase):
    def test_prompt_proposal_starts_bounded_live_trial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = root / "events.jsonl"
            proposals = root / "proposals.jsonl"
            history = root / "history.jsonl"
            sample = {"command": "!newAction", "action": True, "tokens": 120,
                      "request": "build a house", "outcome": "Agent wrote this code:", "failed": False}
            events.write_text("".join(json.dumps(sample) + "\n" for _ in range(4)))
            proposal = {"component": "prompt", "hypothesis": "Check the footprint first",
                        "change": "Check placement before building", "expected_effect": "Fewer errors",
                        "evidence": "A block was misplaced",
                        "guidance": "Before construction, check the intended footprint."}
            with patch.object(live_propose, "propose", return_value=proposal), \
                 patch.object(live_propose, "critic", return_value={"verdict": "accept", "reason": "general"}):
                result = live_propose.run(events, proposals, history)
            self.assertEqual(result["status"], "trial_started")
            self.assertEqual(json.loads((root / "trial.json").read_text())["guidance"], proposal["guidance"])

    def test_valid_proposal_is_recorded_without_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = root / "events.jsonl"
            proposals = root / "proposals.jsonl"
            history = root / "history.jsonl"
            events.write_text(json.dumps({"command": "!newAction", "failed": True,
                                          "request": "build a house", "outcome": "placement failed"}) + "\n")
            proposal = {"component": "prompt", "hypothesis": "Planning before placement reduces failed blocks",
                        "change": "Check build space and materials before starting each structure.",
                        "expected_effect": "Fewer placement failures", "evidence": "A placement failed",
                        "guidance": "Before building, check the intended footprint and needed blocks."}
            with patch.object(live_propose, "propose", return_value=proposal), \
                 patch.object(live_propose, "critic", return_value={"verdict": "accept", "reason": "general"}):
                result = live_propose.run(events, proposals, history)
            self.assertEqual(result["status"], "proposed")
            self.assertIsNone(live_propose.read_jsonl(proposals)[0]["measurement"])
            self.assertFalse(live_propose.read_jsonl(history)[0]["accepted"])

    def test_specific_coordinates_are_rejected_before_model_critic(self):
        proposal = {"component": "prompt", "hypothesis": "Remember location",
                    "change": "Always build at 120, 64, -350", "expected_effect": "Works here",
                    "evidence": "One task"}
        self.assertIn("world-specific coordinates", live_propose.validate(proposal))


if __name__ == "__main__":
    unittest.main()
