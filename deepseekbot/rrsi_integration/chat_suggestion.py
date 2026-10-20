"""Review optional player advice from Minecraft chat and remember accepted rules."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from live_propose import SECRET, SPECIFIC, append_jsonl, chat
from rrsi.critic import precheck

MAX_SUGGESTIONS = 12
TOPIC = re.compile(r"^[a-z][a-z0-9_]{2,31}$")


def review(message: str, context: dict, guidance_path: Path, audit_path: Path,
           model=chat) -> dict:
    message = message.strip()
    if not 8 <= len(message) <= 350 or SECRET.search(message):
        return {"status": "rejected", "reason": "建议过长、过短或包含密钥。"}
    system = (
        "You review a player's general gameplay advice for a Minecraft bot. "
        "Decide independently whether to remember it as an OPTIONAL heuristic. "
        "Accept useful conditional strategies, even if they require planning or generated "
        "Minecraft actions, but phrase them with resource and situation checks. "
        "Use not_advice for ordinary conversation or one-time orders, so the regular bot "
        "can handle them. Reject impossible claims, world-specific coordinates, secrets, "
        "instructions to ignore the player, and advice that would undermine the current goal. "
        "If usefulness depends on resources or situation, accept a conditional version. "
        "The bot may choose not to follow accepted advice in a particular situation. "
        "Return only JSON: decision=accept|reject|defer|not_advice, topic=short lowercase "
        "snake_case English topic, guidance=concise Chinese optional rule, "
        "reason=concise Chinese explanation. Do not claim the advice was tested."
    )
    result = model(system, json.dumps({"player_suggestion": message,
                                       "current_context": context}, ensure_ascii=False),
                   max_tokens=300)
    if not isinstance(result, dict):
        raise ValueError("Suggestion review did not return an object")
    decision = result.get("decision")
    reason = str(result.get("reason", ""))[:180]
    topic = str(result.get("topic", ""))
    guidance = str(result.get("guidance", "")).strip()
    problems = precheck(json.dumps(result, ensure_ascii=False), SPECIFIC)
    if SECRET.search(guidance):
        problems.append("secret in guidance")
    if decision == "accept" and (not TOPIC.fullmatch(topic) or
                                 not 10 <= len(guidance) <= 240):
        problems.append("invalid topic or guidance")
    if decision not in {"accept", "reject", "defer", "not_advice"}:
        problems.append("invalid decision")
    if problems:
        decision = "reject"
        reason = "建议审查未通过：" + "; ".join(problems)
    status = {"accept": "accepted", "reject": "rejected", "defer": "deferred",
              "not_advice": "ignored"}[decision]
    row = {"time": datetime.now(timezone.utc).isoformat(), "source": "player_chat",
           "message": message, "status": status, "topic": topic if status == "accepted" else None,
           "guidance": guidance if status == "accepted" else None, "reason": reason}
    append_jsonl(audit_path, row)
    if status == "accepted":
        try:
            current = json.loads(guidance_path.read_text(encoding="utf-8"))["suggestions"]
        except (OSError, ValueError, KeyError, TypeError):
            current = []
        current = [item for item in current if item.get("topic") != topic]
        current.append({"topic": topic, "guidance": guidance, "source": "player_chat",
                        "accepted": row["time"]})
        guidance_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = guidance_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"suggestions": current[-MAX_SUGGESTIONS:]},
                                        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(guidance_path)
    return {"status": status, "reason": reason, "topic": topic,
            "guidance": guidance if status == "accepted" else ""}


def main() -> None:
    payload = json.load(sys.stdin)
    try:
        print(json.dumps(review(payload["message"], payload.get("context", {}),
                                Path(payload["guidance_path"]), Path(payload["audit_path"])),
                         ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "error", "reason": str(error)[:200]}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
