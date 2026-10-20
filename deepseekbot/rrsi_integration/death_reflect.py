"""Reflect on a captured death; retain conditional lessons as unverified evidence."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from live_propose import SECRET, SPECIFIC, append_jsonl, chat
from live_domain import SCOPES
from rrsi.critic import precheck


def reflect(death: dict, directory: Path, model=chat) -> dict:
    system = (
        "Analyze ONE Minecraft bot death from recorded evidence. Treat server death translation/message "
        "as the strongest evidence of the immediate cause, then explain the preceding decisions and "
        "environmental risks. Distinguish facts from inference; if evidence is incomplete, say unknown "
        "instead of inventing a killer, cause or missing item. Consider health, oxygen, water/lava, "
        "falls, nearby entities, active action and recent traces. Give a concrete safer next plan after "
        "respawn; don't blindly repeat the fatal route or retrieve items before checking safety. "
        "Do not change gamerules, gamemode or player goals unless the player asked. Do not execute "
        "commands. Derive ONE conditional generalizable lesson; avoid world coordinates, player names, "
        "secrets and claims that it has been proven effective. It is an unverified heuristic for later "
        "RRSI experiments, not an adopted RRSI rule. Respond in concise Chinese, only JSON: "
        "{cause: string, confidence: high|medium|low, evidence: [string], decision_error: string, "
        "next_plan: string, lesson: string, topic: English snake_case, scope: "
        "one of " + ', '.join(SCOPES) + "}. Keep strings under 240 characters, evidence at most 5 items."
    )
    payload = SECRET.sub('[REDACTED]', json.dumps(death, ensure_ascii=False))
    result = model(system, payload, max_tokens=700)
    for key in ('cause', 'decision_error', 'next_plan', 'lesson', 'topic', 'scope', 'confidence'):
        if not isinstance(result.get(key), str) or not result[key].strip() or len(result[key]) > 240:
            raise ValueError(f'invalid reflection field: {key}')
    if result['confidence'] not in ('high', 'medium', 'low') or result['scope'] not in SCOPES:
        raise ValueError('invalid confidence or scope')
    if not re.fullmatch(r'[a-z][a-z0-9_]{2,40}', result['topic']):
        raise ValueError('invalid topic')
    if not isinstance(result.get('evidence'), list) or not 1 <= len(result['evidence']) <= 5:
        raise ValueError('missing evidence')
    if any(not isinstance(item, str) or len(item) > 240 for item in result['evidence']):
        raise ValueError('invalid evidence')
    if SECRET.search(json.dumps(result)) or precheck(result['lesson'], SPECIFIC):
        raise ValueError('lesson contains private or world-specific data')
    row = {**result, 'death_id': death['id'], 'time': datetime.now(timezone.utc).isoformat(),
           'status': 'reflected', 'verified': False}
    # Memory is separate from RRSI's measured active_guidance.json.
    target = directory / 'death_guidance.json'
    try:
        prior = json.loads(target.read_text(encoding='utf-8')).get('lessons', [])
    except (OSError, ValueError):
        prior = []
    lessons = [old for old in prior if old.get('topic') != row['topic']]
    lessons.append({key: row[key] for key in ('death_id', 'time', 'topic', 'scope', 'lesson', 'confidence', 'verified')})
    directory.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps({'latest': row, 'lessons': lessons[-12:]}, ensure_ascii=False) + '\n', encoding='utf-8')
    temporary.replace(target)
    append_jsonl(directory / 'events.jsonl', {**row, 'type': 'death_reflection', 'action': False,
        'failed': True, 'tokens': None, 'outcome': row['cause'] + '; ' + row['lesson']})
    append_jsonl(directory / 'death_reflections.jsonl', row)
    return row


def main():
    payload = json.load(sys.stdin)
    try:
        result = reflect(payload['death'], Path(payload['directory']))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'error', 'reason': str(error)[:200]}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
