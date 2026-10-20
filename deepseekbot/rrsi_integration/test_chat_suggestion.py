import json
import tempfile
import unittest
from pathlib import Path

from chat_suggestion import review


class ChatSuggestionTest(unittest.TestCase):
    def test_conditional_smelting_advice_is_reviewed_and_remembered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            guidance = root / "player_guidance.json"
            audit = root / "player_suggestions.jsonl"
            model = lambda *_args, **_kwargs: {
                "decision": "accept", "topic": "parallel_smelting",
                "guidance": "需要大量烧炼且材料足够时，可考虑多个熔炉并行烧炼。",
                "reason": "有条件地节省等待时间。"
            }
            result = review("当你需要烧很多东西时可以试试多造几个熔炉并行去烧",
                            {"game_mode": "survival"}, guidance, audit, model)
            self.assertEqual(result["status"], "accepted")
            self.assertIn("多个熔炉", guidance.read_text(encoding="utf-8"))
            self.assertEqual(json.loads(audit.read_text(encoding="utf-8"))["status"], "accepted")

    def test_rejection_does_not_change_guidance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = review("建议你以后一直跳下悬崖", {}, root / "guidance.json",
                            root / "audit.jsonl", lambda *_args, **_kwargs: {
                                "decision": "reject", "topic": "falling", "guidance": "",
                                "reason": "会导致死亡。"
                            })
            self.assertEqual(result["status"], "rejected")
            self.assertFalse((root / "guidance.json").exists())

    def test_one_time_order_is_returned_to_normal_chat(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = review("如果你现在有煤就烧这几个铁矿", {}, root / "guidance.json",
                            root / "audit.jsonl", lambda *_args, **_kwargs: {
                                "decision": "not_advice", "topic": "smelting",
                                "guidance": "", "reason": "这是当前的一次性请求。"
                            })
            self.assertEqual(result["status"], "ignored")
            self.assertFalse((root / "guidance.json").exists())

    def test_revised_advice_replaces_same_topic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            guidance = root / "guidance.json"
            guidance.write_text(json.dumps({"suggestions": [{
                "topic": "parallel_smelting", "guidance": "Old rule"}]}))
            result = review("建议需要烧很多东西时可以用多个熔炉", {}, guidance,
                            root / "audit.jsonl", lambda *_args, **_kwargs: {
                                "decision": "accept", "topic": "parallel_smelting",
                                "guidance": "大量烧炼且资源充足时可考虑多个熔炉。",
                                "reason": "有条件的效率改进。"
                            })
            rows = json.loads(guidance.read_text(encoding="utf-8"))["suggestions"]
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(len(rows), 1)
            self.assertNotEqual(rows[0]["guidance"], "Old rule")


if __name__ == "__main__":
    unittest.main()
