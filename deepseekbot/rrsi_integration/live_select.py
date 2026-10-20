"""Select or roll back a temporary in-game prompt edit using RRSI's selector.

This is an online gameplay proxy, not a repeatable Minecraft task benchmark.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from live_propose import append_jsonl, read_jsonl
from live_domain import duration_references, in_scope, measurable, reward, save_rule
from runtime_artifacts import artifact_ready, promote, read, atomic

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "rrsi"))
from rrsi.config import RRSIConfig  # noqa: E402
from rrsi.evaluate import TaskResult, aggregate  # noqa: E402
from rrsi.history import History  # noqa: E402
from rrsi.selection import Candidate, select_round  # noqa: E402

TRIAL_SIZE = 4


def select_new_skills(directory: Path) -> dict:
    pending_path = directory / 'probation_skills.json'
    pending = read(pending_path, {'artifacts': []})
    quarantined = set(read(directory / 'extension_quarantine.json', {'ids': []})['ids'])
    executions = read_jsonl(directory / 'extension_executions.jsonl')
    retained = []
    decisions = []
    for artifact in pending['artifacts']:
        samples = [row for row in executions if row.get('artifact_id') == artifact['id']
            and row.get('artifact_variant') == 'probation' and isinstance(row.get('native_verified'), bool)
            and (not row.get('interrupted') or row.get('worker_fault') or row.get('death'))]
        if artifact['id'] in quarantined:
            decisions.append({'artifact_id': artifact['id'], 'status': 'rejected', 'reason': 'quarantined'})
            continue
        if len(samples) < 4:
            retained.append(artifact)
            continue
        samples = samples[:4]
        rate = sum(row['native_verified'] for row in samples) / len(samples)
        accepted = rate >= 0.75 and not any(row.get('death') or row.get('worker_fault') for row in samples)
        evidence = {'measurement': 'new capability: host-verified runtime postconditions; no paired incumbent',
            'invocations': len(samples), 'success_rate': rate,
            'mean_duration_ms': sum(row.get('duration_ms', 0) for row in samples) / len(samples)}
        if accepted:
            promote(artifact, directory, evidence)
        decisions.append({'artifact_id': artifact['id'], 'skill': artifact['name'],
            'status': 'accepted' if accepted else 'rejected', 'evidence': evidence})
        History(directory / 'history.jsonl').append_candidate(artifact['round'], 'new-skill',
            [{'id': artifact['id'], 'component': 'skill', 'targets_mode': artifact.get('scope', 'general'),
              'hypothesis': artifact['description']}], 'CAPABILITY_VERIFIED' if accepted else 'CAPABILITY_REJECTED',
            None, None, accepted, rate, None, None, evidence['measurement'])
    if decisions:
        atomic(pending_path, {'artifacts': retained})
        for decision in decisions:
            append_jsonl(directory / 'new_skill_decisions.jsonl', {'time': datetime.now(timezone.utc).isoformat(), **decision})
    return {'status': 'native_skills_evaluated', 'decisions': decisions,
            'accepted': sum(row['status'] == 'accepted' for row in decisions)}


def evaluation(label: str, rows: list[dict], references=None):
    return aggregate(label, 1, {
        str(i): TaskResult([reward(row, references or {})], tokens=[row["tokens"]])
        for i, row in enumerate(rows)
    }, {"measurement": "live completion and per-unit timing proxy"})


def select(events_path: Path, trial_path: Path, active_path: Path,
           decisions_path: Path) -> dict:
    trial = json.loads(trial_path.read_text(encoding="utf-8"))
    artifact = trial.get('artifact')
    if artifact and not artifact_ready(trial, trial_path.parent):
        reason = 'executable artifact quarantined or incumbent version changed'
        append_jsonl(decisions_path, {'time': datetime.now(timezone.utc).isoformat(), 'round': trial['round'],
            'status': 'reverted', 'component': trial['component'], 'reason': reason})
        trial_path.unlink()
        return {'status': 'reverted', 'reason': reason}
    scope = trial.get("scope", "general")
    corrections = {row["action_time"]: row["failed"]
                   for row in read_jsonl(trial_path.parent / "feedback.jsonl")}
    def corrected(row):
        if row.get("time") in corrections:
            return {**row, "feedback_reward": 0.0 if corrections[row["time"]] else 1.0}
        return row

    baseline = [corrected(row) for row in trial["baseline"]]
    fresh = [row for row in read_jsonl(events_path)
             if row.get("time", "") > trial["started"] and measurable(row)]
    candidates = [row for row in fresh if in_scope(row, scope)
                  and ("trial_round" not in row or row["trial_round"] == trial["round"])]
    candidates = [corrected(row) for row in candidates]
    if artifact:
        candidates = [row for row in candidates if row.get('command') == artifact['target']
            and row.get('artifact_id') == artifact['id'] and row.get('artifact_variant') == 'trial']
    (trial_path.parent / "progress.json").write_text(json.dumps({
        "round": trial["round"], "scope": scope, "count": len(candidates), "needed": TRIAL_SIZE
    }) + "\n", encoding="utf-8")
    if len(candidates) < TRIAL_SIZE:
        started = datetime.fromisoformat(trial["started"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - started).total_seconds()
        if age > 8 * 60 or len(fresh) >= 24:
            reason = f"insufficient comparable {scope} actions: {len(candidates)}/{TRIAL_SIZE}"
            append_jsonl(decisions_path, {"time": datetime.now(timezone.utc).isoformat(),
                "round": trial["round"], "status": "expired", "scope": scope, "reason": reason})
            History(trial_path.parent / "history.jsonl").append_candidate(
                trial["round"], "live-trial", [{"id": f"live-{trial['round']}",
                    "component": trial["component"], "targets_mode": scope,
                    "hypothesis": trial.get("summary", "live prompt trial")}],
                "EVAL_INSUFFICIENT", None, None, False, None, None, None, reason)
            trial_path.unlink()
            return {"status": "expired", "reason": reason}
        return {"status": "collecting", "count": len(candidates), "needed": TRIAL_SIZE}
    if len(baseline) != TRIAL_SIZE or not all(map(measurable, baseline)):
        raise ValueError("invalid baseline window")

    references = duration_references(baseline)
    incumbent = evaluation("incumbent", baseline, references)
    challenger = evaluation("candidate", candidates[:TRIAL_SIZE], references)
    config = RRSIConfig(delta=0.20, w_s=100.0, w_c=15.0, w_n=0.0)
    item = Candidate("candidate", [{"component": trial["component"]}], ev=challenger)

    def guards(old, new):
        issues = []
        if new.C is None or old.C is None:
            issues.append("missing token measurements")
        if any(not in_scope(row, scope) for row in baseline):
            issues.append("baseline scope does not match the strategy")
        if artifact:
            if not trial.get('preflight', {}).get('passed'):
                issues.append('executable regression fixtures did not pass')
            if new.S <= 0 or new.S < old.S:
                issues.append('executable change has no successful evidence or regresses completion')
            if any(row.get('death_id') for row in candidates[:TRIAL_SIZE]):
                issues.append('death during executable trial')
        return issues

    winner, decisions = select_round([item], incumbent, incumbent.S,
                                     config.delta, config, {}, guard_fn=guards)
    selected = winner is not None
    row = {"time": datetime.now(timezone.utc).isoformat(), "round": trial["round"],
           "selected": "candidate" if selected else "incumbent",
           "incumbent": {"S": incumbent.S, "C": incumbent.C},
           "candidate": {"S": challenger.S, "C": challenger.C},
           "decision": decisions[0].to_json(), "scope": scope,
           "topic": trial.get("topic"), "component": trial['component'],
           'artifact_id': artifact['id'] if artifact else None,
           "measurement": "live completion and per-unit timing proxy"}
    append_jsonl(decisions_path, row)
    History(trial_path.parent / "history.jsonl").append_candidate(
        trial["round"], "live-trial", [{"id": f"live-{trial['round']}",
                                         "component": trial["component"],
                                         "targets_mode": scope,
                                         "hypothesis": trial.get("summary", "live prompt trial")}],
        "ACCEPTED" if selected else "REJECTED", decisions[0].delta_S,
        decisions[0].delta_C, selected, challenger.S, challenger.C, None,
        decisions[0].reason)
    rule_count = None
    extension_count = None
    if selected and artifact:
        extension_count = promote(artifact, trial_path.parent, row)
    elif selected:
        rule_count = save_rule(active_path, {"id": f"live-{trial['round']}",
            "guidance": trial["guidance"], "scope": scope,
            "topic": trial.get("topic", f"strategy_{trial['round']}"),
            "round": trial["round"], "selected": row["time"],
            "evidence": {"incumbent": row["incumbent"], "candidate": row["candidate"],
                         "measurement": row["measurement"]}})
    trial_path.unlink()
    return {"status": "selected" if selected else "reverted", "decision": row["decision"],
            'extension_count': extension_count, 'component': trial['component'],
            "rule_count": rule_count,
            "incumbent_score": incumbent.S, "candidate_score": challenger.S}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pending-skills', type=Path)
    parser.add_argument("--events", type=Path)
    parser.add_argument("--trial", type=Path)
    parser.add_argument("--active", type=Path)
    parser.add_argument("--decisions", type=Path)
    args = parser.parse_args()
    try:
        result = select_new_skills(args.pending_skills) if args.pending_skills else select(args.events, args.trial, args.active, args.decisions)
        print(json.dumps(result,
                         ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "error", "reason": str(error)[:200]}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
