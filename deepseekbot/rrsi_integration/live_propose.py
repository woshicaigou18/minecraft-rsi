"""Propose and screen one Minecraft harness improvement from live action traces."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from live_domain import SCOPES, action_score, in_scope, load_rules, measurable, scope_of
from runtime_artifacts import CONTRACT, EXECUTABLE, atomic, build, preflight, read, stage_native

ROOT = Path(__file__).resolve().parents[1]
RRSI_ROOT = ROOT.parent / "rrsi"
sys.path.insert(0, str(RRSI_ROOT))

from rrsi.components import K  # noqa: E402
from rrsi.critic import precheck  # noqa: E402
from rrsi.history import History  # noqa: E402
from rrsi.schedule import edit_budget  # noqa: E402

SECRET = re.compile(r"sk-[A-Za-z0-9]{20,}")
SPECIFIC = [
    (r"(?i)\b(?:task[_ -]?id|test[_ -]?set|grader|verifier)\b", "task or grader specialization"),
    (r"-?\d{2,}\s*,\s*-?\d{1,}\s*,\s*-?\d{2,}", "world-specific coordinates"),
]


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    rows = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            if index != len(lines) - 1:
                raise
    return rows


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def api_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        key = json.loads((ROOT / "keys.json").read_text(encoding="utf-8-sig")).get("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError("DeepSeek API key is missing")
    return key


def chat(system: str, user: str, *, max_tokens: int = 450) -> dict:
    payload = json.dumps({
        "model": "deepseek-chat",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }).encode("utf-8")
    req = Request("https://api.deepseek.com/chat/completions", data=payload, headers={
        "Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"
    })
    try:
        with urlopen(req, timeout=35) as response:
            result = json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"DeepSeek API HTTP {error.code}") from None
    except URLError as error:
        raise RuntimeError(f"DeepSeek API network error: {error.reason}") from None
    content = result["choices"][0]["message"]["content"].strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content).strip()
    return json.loads(content)


def validate(proposal: dict) -> list[str]:
    if not isinstance(proposal, dict):
        return ["proposal is not an object"]
    required = ("component", "hypothesis", "change", "expected_effect", "evidence")
    problems = [f"missing {key}" for key in required if not isinstance(proposal.get(key), str) or not proposal[key].strip()]
    if proposal.get("component") not in K:
        problems.append("unknown RRSI component")
    if proposal.get("scope", "general") not in SCOPES:
        problems.append("unknown gameplay scope")
    if "topic" in proposal and not re.fullmatch(r"[a-z][a-z0-9_]{2,40}", str(proposal["topic"])):
        problems.append("invalid strategy topic")
    for key in required[1:]:
        if len(str(proposal.get(key, ""))) > 400:
            problems.append(f"{key} is too long")
    if proposal.get("component") == "prompt":
        guidance = proposal.get("guidance")
        if not isinstance(guidance, str) or not 10 <= len(guidance) <= 300:
            problems.append("prompt guidance must be 10-300 characters")
    elif proposal.get('component') in EXECUTABLE:
        try:
            artifact = build(proposal)
            if artifact.get('implementation') != 'javascript' and not in_scope({'command': artifact['target']}, proposal.get('scope', 'general')):
                problems.append('artifact target does not match gameplay scope')
        except ValueError as error:
            problems.append(str(error))
    else:
        problems.append('component has no executable live evaluator yet')
    diff = json.dumps(proposal, ensure_ascii=False)
    if SECRET.search(diff):
        problems.append("proposal contains an API secret")
    screened = proposal
    if proposal.get('artifact', {}).get('implementation') == 'javascript':
        screened = {**proposal, 'artifact': {key: value for key, value in proposal['artifact'].items() if key != 'tests'}}
    problems.extend(precheck(json.dumps(screened, ensure_ascii=False), SPECIFIC))
    return problems


def propose(events: list[dict], history: History, t: int, budget: int, skill_request=None) -> dict:
    feedback = {row["action_time"]: row for row in
                read_jsonl(history.path.parent / "feedback.jsonl")}
    actions = [event for event in events if measurable(event)][-60:]
    stats = {}
    for scope in SCOPES:
        if scope == "general":
            continue
        rows = [event for event in actions if in_scope(event, scope)]
        if rows:
            stats[scope] = {"count": len(rows), "completion": sum(map(action_score, rows)) / len(rows),
                            "mean_tokens": sum(row["tokens"] for row in rows) / len(rows),
                            "baseline_ready": sum(row.get("trial_round") is None for row in rows) >= 4}
    failures = [event for event in actions[:-12] if action_score(event) < 1][-6:]
    digest = [{"command": e.get("command"), "scope": scope_of(e), "request": e.get("request"),
               "outcome": e.get("outcome"),
               "failed": feedback.get(e.get("time"), {}).get("failed", e.get("failed")),
               "player_feedback": feedback.get(e.get("time"), {}).get("message"),
               "duration_ms": e.get("duration_ms"), "before": e.get("before"), "after": e.get("after")}
              for e in failures + actions[-12:]]
    if not digest:
        digest = events[-6:]
    safe_digest = SECRET.sub("[REDACTED]", json.dumps(digest, ensure_ascii=False))
    system = (
        "You improve a Minecraft Mineflayer agent harness. Propose ONE generalizable "
        "change based on exploration and action results, resource changes, time and failures. "
        "Recent death_reflections are high-priority evidence: consider a concrete prevention strategy "
        "for the supported cause and decision error, respecting uncertainty and player goals. "
        "Prefer a scoped, conditional strategy with a ready baseline. Improve mining, navigation, "
        "crafting, smelting, building or combat decisions. Successful exploration can also reveal "
        "wasted effort or repeated work. Use prior accepted/rejected experiments to pick a NEW "
        "hypothesis; do not repeat a rejected generic reminder. Refine an existing topic only "
        "when evidence supports a concrete change. Choose component=prompt, skill, client_tool or config. "
        "For skill rounds, prefer inventing a NEW reusable JavaScript skill with implementation=javascript, "
        "rather than merely combining a fixed list of commands. Identify a missing capability from the traces. "
        "New skill manifest: kind:skill, implementation:javascript, name:snake_case, target:!skill_<name>, "
        "description, parameters:[{name,type:string|number|boolean,description}], postcondition per native API "
        "contract, timeout_ms:1000..120000. Provide the manifest; a separate coder writes source and tests. "
        "The target MUST literally concatenate !skill_ and the exact snake_case name, never camelCase. "
        "For state_report, fields may ONLY be health,food,oxygen,position,inventory,in_water,submerged,empty_slots. "
        "Computed recommendations belong in returned data and expected_data tests, never postcondition.fields. "
        "For a player skill_request, always design such a new JavaScript skill that addresses the request. "
        "Prefer an executable change when the cause lies in action sequencing, tool recovery or runtime "
        "parameters rather than missing instructions. Follow RRSI: give a falsifiable "
        "hypothesis, concrete change, expected effect and evidence. Do not hard-code this world's "
        "coordinates, names, task IDs or answers. Do not include secrets. Prompt guidance may be "
        "trialed. Legacy workflow artifacts are declarative; native JavaScript skills contain executable source. "
        "Write the explanatory fields in concise Chinese for the player. "
        "For component=prompt, also provide guidance: one concise general gameplay instruction "
        "that can be appended to the agent's prompt. It must be useful in both creative and "
        "survival, never override the player's current instructions, and contain no world details. "
        "Return JSON keys component, scope, topic, hypothesis, change, expected_effect, evidence, "
        "and guidance for prompt OR artifact for other components. topic is English snake_case; "
        "scope is one of " + ", ".join(SCOPES) + ". "
        "For legacy workflow/adapter artifacts: {kind: component, target: existing command}. For workflow skill add "
        "name: snake_case and steps:[{command,args,when?}]. The last step MUST call target with "
        "args [{arg:0},{arg:1},...] exactly, without a condition. For client_tool add before:steps, "
        "on_failure:steps, attempts:1..3; original target arguments are preserved. Step arguments can "
        "be literal strings/numbers, {arg:index}, or {inventory:item_name} for the current item count. "
        "Optional when is one of {inventory_full:bool}, {has_item:{name:item,min:number}}, "
        "{health_below:number}, {in_water:bool}, {last_failed:bool}, or {all:[conditions]}. "
        "Each step list has at most 8 steps, finite calls only. For config add values:{setting:value} "
        "using the provided contract, with its required target. "
        "last_failed starts FALSE for each invocation, so do not use it as a skill's initial "
        "precondition. For inventory preparation, check inventory_full AND has_item, and use "
        "{inventory:item_name} rather than a hardcoded observed stack count. For example, a skill "
        "can conditionally discard available low-value diorite before calling collectBlocks with "
        "the original args. Vanilla item names are reusable identifiers, not world-specific coordinates. "
        "Each artifact gets isolated regression "
        "fixtures and a measured live trial. Do not discard valuable gear or fabricate completion. "
        "Follow preferred_component for this scheduled round when the evidence supports it; if it "
        "cannot address the observed failure, choose another supported component and explain why."
    )
    user = json.dumps({"round": t, "edit_budget": budget,
                       'preferred_component': 'skill' if skill_request else ['skill', 'client_tool', 'config', 'prompt'][t % 4],
                       'skill_request': skill_request,
                       'existing_new_skills': read(history.path.parent / 'probation_skills.json', {'artifacts': []}),
                       "prior_proposals": history.render(10), "scope_statistics": stats,
                       "accepted_strategies": load_rules(history.path.parent / "active_guidance.json"),
                       "runtime_contract": CONTRACT,
                       "runtime_versions": read(history.path.parent / 'active_extensions.json', {'artifacts': []}),
                       "terrain_recoveries": [event for event in events
                                              if event.get("type") == "terrain_recovery"][-4:],
                       "death_reflections": [event for event in events
                                             if event.get('type') == 'death_reflection'][-4:],
                       "recent_actions": safe_digest}, ensure_ascii=False)
    return chat(system, user, max_tokens=1400)


def write_native_skill(proposal: dict, feedback=None) -> dict:
    result = chat(
        'Write a NEW reusable Minecraft JavaScript skill implementing this manifest. Return ONLY JSON '
        '{"source":"async function run(api, args) {...}","tests":[...]}. The source is actual JavaScript '
        'with your own algorithm, loops and data structures, not declarative command steps. No imports '
        'or host process/files/network globals; use the asynchronous native API provided. Every API call '
        'must be awaited. Use await api.now() for bounded loops and await api.wait(ms) for polling. '
        'Oxygen 20 is full and corresponds to about 15 seconds without breathing enchantments; '
        'reserve ascent time and a margin. Unknown oxygen must not be assumed full when submerged. '
        'Always return {success:boolean,message:string,data?:object}, without inventing success. '
        'Implement the postcondition; the host checks it independently. Include 2..4 varied tests, with '
        'at least one successful case. The fixture API models listed native methods; unsupported operations '
        'must not be hidden with success:true. Prefer compact code. For state_report return the listed '
        'real state fields in data, and optionally useful computed fields verified with expected_data. '
        'Never alter the manifest or weaken its postcondition to pass tests. Fix failed cases using feedback.',
        json.dumps({'proposal': proposal, 'native_api': CONTRACT['native_skill_api'], 'feedback': feedback}, ensure_ascii=False),
        max_tokens=2800)
    return {**proposal, 'artifact': {**proposal['artifact'], 'source': result.get('source'), 'tests': result.get('tests')}}


def critic(proposal: dict) -> dict:
    system = (
        "Review a proposed change to a Minecraft bot harness. Reject if it memorizes world/task "
        "details, claims unsupported success, disables error handling or safety, is a no-op, "
        "or bundles independent changes. Accept a general, testable proposal. "
        "Vanilla item names such as diorite are portable identifiers, not world-specific details. "
        "A coherent skill's preparation plus its original operation is ONE component change. "
        "Conditional cleanup of low-value inventory followed by collection can be valid. "
        "Reject dead conditions, discarding valuable equipment, or steps that contradict the player goal. "
        "Return only JSON: {\"verdict\":\"accept\" or \"reject\",\"reason\":\"short reason\"}."
    )
    return chat(system, json.dumps(proposal, ensure_ascii=False), max_tokens=150)


def repair_artifact(proposal: dict, report: dict) -> dict:
    if proposal.get('artifact', {}).get('implementation') == 'javascript':
        return write_native_skill(proposal, report)
    result = chat(
        'Repair this ONE executable artifact using failed isolated semantic fixtures. Keep kind and target. '
        'Do not change the hypothesis, weaken tests, or invent success. Return only JSON {"artifact": ...}. '
        'Use only the provided contract. A skill ends with target and args [{"arg":0},...]. '
        'last_failed initially equals false. For clearing low-value filler, combine inventory_full '
        'with has_item min:1 and use {"inventory":"item_name"} as the discard quantity so it works '
        'for varying stack sizes. Do not discard essential equipment. No code strings.',
        json.dumps({'proposal': proposal, 'failed_preflight': report, 'contract': CONTRACT}, ensure_ascii=False),
        max_tokens=1000)
    return {**proposal, 'artifact': result.get('artifact')}


def run(events_path: Path, proposals_path: Path, history_path: Path, skill_request=None) -> dict:
    trial_path = proposals_path.parent / "trial.json"
    if trial_path.exists() and not skill_request:
        return {"status": "busy", "reason": "A candidate is already being evaluated"}
    events = read_jsonl(events_path)
    if not events and skill_request:
        events = [{'type': 'skill_request', 'request': skill_request, 'action': False}]
    if not events:
        raise RuntimeError("No live action events")
    history = History(history_path)
    t = max((record.get("t", -1) for record in history.records()), default=-1) + 1
    budget = edit_budget(t, 20, 1, 2)
    proposal = propose(events, history, t, budget, skill_request) if skill_request else propose(events, history, t, budget)
    if proposal.get('artifact', {}).get('implementation') == 'javascript':
        proposal = write_native_skill(proposal)
    problems = validate(proposal)
    if problems and proposal.get('artifact', {}).get('implementation') == 'javascript':
        corrected = chat(
            'Repair the schema of this JavaScript skill manifest using the validation errors. '
            'Preserve its purpose and actual behavior; do not weaken checks or claim success. '
            'Return ONLY JSON {"artifact": corrected_manifest}, without source or tests. '
            'target must be !skill_ plus the exact snake_case name. state_report fields must be real host '
            'state fields; computed recommendations are returned data tested with expected_data instead.',
            json.dumps({'proposal': proposal, 'errors': problems,
                        'native_api': CONTRACT['native_skill_api']}, ensure_ascii=False), max_tokens=1000)
        proposal = {**proposal, 'artifact': corrected.get('artifact')}
        if isinstance(proposal['artifact'], dict):
            proposal = write_native_skill(proposal)
        problems = validate(proposal)
    artifact = None
    report = None
    for attempt in range(2):
        if problems or proposal.get('component') not in EXECUTABLE:
            break
        artifact = build(proposal)
        current_versions = read(proposals_path.parent / 'active_extensions.json', {'artifacts': []})
        if any(row.get('id') == artifact['id'] for row in current_versions['artifacts']):
            problems.append('duplicate active executable artifact')
        if artifact['kind'] == 'config':
            current = read(proposals_path.parent / 'active_extensions.json', {'artifacts': []})
            old = next((row for row in current['artifacts'] if row['target'] == artifact['target']), {})
            if all(value == old.get('values', {}).get(key, CONTRACT['settings'].get(key, {}).get('default'))
                   for key, value in artifact.get('values', {}).items()):
                problems.append('no-op runtime config')
        report = preflight(artifact)
        stage_native(artifact, proposals_path.parent, report)
        artifact_path = proposals_path.parent / 'artifacts' / (artifact['id'] + '.json')
        atomic(artifact_path, {'artifact': artifact, 'preflight': report})
        if not report.get('passed'):
            if attempt == 0:
                append_jsonl(proposals_path, {'time': datetime.now(timezone.utc).isoformat(), 'round': t,
                    'status': 'preflight_repair', 'artifact': artifact, 'preflight': report})
                proposal = repair_artifact(proposal, report)
                problems = validate(proposal)
                continue
            problems.append('isolated executable regression fixtures failed: ' + json.dumps(report, ensure_ascii=False)[:500])
        break
    if any(rule.get("guidance") == proposal.get("guidance")
           for rule in load_rules(proposals_path.parent / "active_guidance.json")):
        problems.append("duplicate active strategy")
    review = {"verdict": "reject", "reason": "; ".join(problems)} if problems else critic(proposal)
    accepted = review.get("verdict") == "accept" and not problems
    row = {"time": datetime.now(timezone.utc).isoformat(), "round": t,
           "edit_budget": budget, "status": "proposed" if accepted else "critic_rejected",
           "proposal": proposal, "critic": review, "measurement": None, 'artifact': artifact, 'preflight': report}
    append_jsonl(proposals_path, row)
    edit = {"id": f"live-{t}", "component": proposal.get("component"),
            "hypothesis": proposal.get("hypothesis"), "targets_mode": proposal.get("scope", "general")}
    history.append_candidate(t, "live", [edit], row["status"].upper(), None, None,
                             False, None, None, None, str(review.get("reason", "")))
    scope = proposal.get("scope", "general")
    baseline = [e for e in events if measurable(e) and in_scope(e, scope)
                and e.get("trial_round") is None][-4:]
    native = artifact and artifact.get('implementation') == 'javascript'
    if accepted and native:
        pending_path = proposals_path.parent / 'probation_skills.json'
        pending = read(pending_path, {'artifacts': []})
        rows = [old for old in pending['artifacts'] if old['target'] != artifact['target']]
        rows.append({**artifact, 'round': t, 'created': row['time'], 'preflight': report, 'critic': review})
        atomic(pending_path, {'artifacts': rows[-16:]})
        row['status'] = 'skill_added'
        append_jsonl(proposals_path, row)
    if artifact:
        baseline = [e for e in events if measurable(e) and e.get('command') == artifact['target']
                    and e.get('trial_round') is None][-4:]
    if (accepted and not native and len(baseline) == 4
            and not trial_path.exists()):
        trial = {"round": t, "guidance": proposal.get("guidance"),
                 "summary": proposal["change"], "component": proposal['component'],
                 "scope": scope, "topic": proposal.get("topic", f"strategy_{t}"),
                 "started": datetime.now(timezone.utc).isoformat(), "baseline": baseline}
        if artifact:
            trial.update(artifact=artifact, preflight=report,
                base_extension_revision=read(proposals_path.parent / 'active_extensions.json', {'revision': 0})['revision'])
        atomic(trial_path, trial)
        row["status"] = "trial_started"
        row["measurement"] = {"baseline_count": 4, "candidate_count": 0}
        # Keep the JSONL audit trail append-only; the start is a second event.
        append_jsonl(proposals_path, row)
    return {"status": row["status"], "component": proposal.get("component"),
            'artifact_id': artifact['id'] if artifact else None,
            'skill_name': artifact.get('name') if native else None,
            'skill_command': artifact.get('target') if native else None,
            "summary": str(proposal.get("change", ""))[:120] if accepted else ""}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--proposals", type=Path, required=True)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument('--skill-request')
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.events, args.proposals, args.history, args.skill_request), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "error", "reason": str(error)[:200]}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
