"""Record Mindcraft trials and compare them with the official RRSI selection rule."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RRSI_ROOT = Path(__file__).resolve().parents[2] / "rrsi"
if not (RRSI_ROOT / "rrsi" / "selection.py").is_file():
    raise SystemExit(f"Clone google-research/rrsi at {RRSI_ROOT}")
sys.path.insert(0, str(RRSI_ROOT))

from rrsi.config import RRSIConfig  # noqa: E402
from rrsi.evaluate import TaskResult, aggregate  # noqa: E402
from rrsi.selection import Candidate, select_round  # noqa: E402

SCORE = re.compile(r"Task ended with score\s*:\s*([0-9]+(?:\.[0-9]+)?)")


def task_ids(task_file: Path) -> list[str]:
    data = json.loads(task_file.read_text(encoding="utf-8"))
    return sorted(k for k, v in data.items() if isinstance(v, dict) and "goal" in v)


def record(args: argparse.Namespace) -> None:
    source = args.task_file.resolve()
    if args.task_id not in task_ids(source):
        raise SystemExit(f"Unknown task ID {args.task_id} in {source}")
    history = json.loads(args.history.read_text(encoding="utf-8"))
    turns = history.get("turns", history) if isinstance(history, dict) else history
    scores = [float(match.group(1)) for turn in turns
              if isinstance(turn, dict) and turn.get("role") == "system"
              for match in SCORE.finditer(str(turn.get("content", "")))]
    if not scores or not 0 <= scores[-1] <= 1:
        raise SystemExit("The history has no valid final task score")
    usage = [json.loads(line) for line in args.usage.read_text(encoding="utf-8").splitlines()
             if line.strip()]
    tokens = sum(int(row.get("total_tokens", 0)) for row in usage)
    if tokens <= 0:
        raise SystemExit("The DeepSeek usage log has no positive token count")
    report = args.report
    data = json.loads(report.read_text(encoding="utf-8")) if report.exists() else {
        "task_file": str(source), "trials": {}
    }
    if Path(data["task_file"]).resolve() != source:
        raise SystemExit("The report belongs to a different task file")
    data["trials"].setdefault(args.task_id, []).append({"reward": scores[-1], "tokens": tokens})
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Recorded {args.task_id}: reward={scores[-1]}, tokens={tokens}")


def evaluate(report_path: Path, ids: list[str], k: int):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    per_task = {}
    for task_id in ids:
        trials = report["trials"].get(task_id, [])
        if len(trials) > k:
            raise SystemExit(f"Too many trials for {task_id} in {report_path}")
        rewards = [float(t["reward"]) for t in trials]
        tokens = [int(t["tokens"]) for t in trials]
        if any(not 0 <= reward <= 1 for reward in rewards):
            raise SystemExit(f"Invalid reward for {task_id} in {report_path}")
        missing = k - len(trials)
        per_task[task_id] = TaskResult(rewards + [0.0] * missing,
                                       tokens=tokens + [None] * missing, missing=missing)
    result = aggregate(report_path.stem, k, per_task)
    if result.C is None:
        raise SystemExit(f"No token cost measurements in {report_path}")
    return result


def compare(args: argparse.Namespace) -> None:
    base = json.loads(args.incumbent.read_text(encoding="utf-8"))
    challenger = json.loads(args.candidate.read_text(encoding="utf-8"))
    if Path(base["task_file"]).resolve() != Path(challenger["task_file"]).resolve():
        raise SystemExit("Incumbent and candidate must use the same task file")
    ids = task_ids(Path(base["task_file"]))
    incumbent = evaluate(args.incumbent, ids, args.k)
    candidate = evaluate(args.candidate, ids, args.k)
    cfg = RRSIConfig(delta=args.delta, beta0=args.beta0, beta1=args.beta1,
                     w_s=0.0, w_c=15.0, w_n=0.5)
    item = Candidate("candidate", [{"component": name} for name in args.component], ev=candidate)
    winner, decisions = select_round([item], incumbent, incumbent.S, cfg.delta, cfg, {})
    print(json.dumps({"incumbent": {"score": incumbent.S, "tokens": incumbent.C,
                                     "missing": incumbent.missing},
                      "candidate": {"score": candidate.S, "tokens": candidate.C,
                                    "missing": candidate.missing},
                      "selected": winner.variant if winner else "incumbent",
                      "decision": decisions[0].to_json()}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("record", help="append a completed Minecraft task trial")
    p.add_argument("--task-file", type=Path, required=True)
    p.add_argument("--task-id", required=True)
    p.add_argument("--history", type=Path, required=True)
    p.add_argument("--usage", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    p = sub.add_parser("compare", help="apply google-research/rrsi selection")
    p.add_argument("--incumbent", type=Path, required=True)
    p.add_argument("--candidate", type=Path, required=True)
    p.add_argument("--k", type=int, required=True)
    p.add_argument("--delta", type=float, required=True, help="measured score noise band")
    p.add_argument("--beta0", type=float, default=0.1)
    p.add_argument("--beta1", type=float, default=40.0)
    p.add_argument("--component", action="append", default=[])
    args = parser.parse_args()
    if args.command == "record":
        record(args)
    else:
        if args.k < 1 or args.delta < 0:
            parser.error("k must be positive and delta must be nonnegative")
        compare(args)


if __name__ == "__main__":
    main()
