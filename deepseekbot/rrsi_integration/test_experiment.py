import json
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from experiment import compare, evaluate, record


class ExperimentTest(unittest.TestCase):
    def test_record_and_missing_trial_score(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = root / "tasks.json"
            tasks.write_text(json.dumps({"logs": {"goal": "Collect logs"}}))
            history = root / "memory.json"
            history.write_text(json.dumps({"turns": [
                {"role": "system", "content": "Task ended with score : 1"}
            ]}))
            usage = root / "usage.jsonl"
            usage.write_text(json.dumps({"total_tokens": 120}) + "\n")
            report = root / "report.json"
            with redirect_stdout(StringIO()):
                record(Namespace(task_file=tasks, task_id="logs", history=history,
                                 usage=usage, report=report))
            result = evaluate(report, ["logs"], 2)
            self.assertEqual(result.S, 0.5)
            self.assertEqual(result.C, 120)
            self.assertEqual(result.missing, 1)

    def test_rrsi_selection_accepts_measured_gain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = root / "tasks.json"
            tasks.write_text(json.dumps({"logs": {"goal": "Collect logs"}}))
            base = root / "base.json"
            candidate = root / "candidate.json"
            base.write_text(json.dumps({"task_file": str(tasks), "trials": {
                "logs": [{"reward": 0, "tokens": 100}]
            }}))
            candidate.write_text(json.dumps({"task_file": str(tasks), "trials": {
                "logs": [{"reward": 1, "tokens": 110}]
            }}))
            output = StringIO()
            with redirect_stdout(output):
                compare(Namespace(incumbent=base, candidate=candidate, k=1,
                                  delta=0.05, beta0=0.1, beta1=40.0,
                                  component=["prompt"]))
            self.assertEqual(json.loads(output.getvalue())["selected"], "candidate")


if __name__ == "__main__":
    unittest.main()
