"""Shared live Minecraft observations, scopes, scores and cumulative rules."""
from __future__ import annotations

import json
import re
import statistics
from pathlib import Path

SCOPES = {
    "mining": {"!collectBlocks", "!digDown"},
    "building": {"!placeHere", "!useOn"},
    "crafting": {"!craftRecipe"},
    "smelting": {"!smeltItem", "!clearFurnace"},
    "navigation": {"!goToPlayer", "!followPlayer", "!goToCoordinates", "!moveAway",
                   "!goToRememberedPlace", "!goToSurface", "!dive", "!surface"},
    "exploration": {"!searchForBlock", "!searchForEntity"},
    "combat": {"!attack", "!attackPlayer"},
    "inventory": {"!equip", "!consume", "!givePlayer", "!putInChest", "!takeFromChest",
                  "!discard", "!tradeWithVillager", "!goToBed"},
    "custom": {"!newAction"},
    "general": set(),
}
FAILURE = re.compile(
    r"failed|exception|error:|timed?\s*out|timeout|cannot\b|can't\b|could not|couldn't|"
    r"not enough|don't have|do not have|no fuel|no .*nearby|no .*found|not found|"
    r"not allowed|need (?:more|a |an |\d)|缺少|不足|失败|无法|未达到|未能|没有进展", re.I)
CANCELED = re.compile(r"previous action is still stopping|stop requested|action interrupted|extension interrupted", re.I)


def scope_of(event: dict) -> str:
    if event.get('artifact_scope') in SCOPES:
        return event['artifact_scope']
    command = event.get("command")
    if command == "!newAction" and event.get("args"):
        task = str(event["args"][0])
        patterns = [("smelting", r"smelt|烧炼|熔炼"), ("crafting", r"craft|合成"),
                    ("building", r"build|place|建造|搭建"), ("mining", r"mine|dig|tunnel|挖掘|挖矿"),
                    ("navigation", r"swim|navigate|游泳|脱困"), ("combat", r"attack|fight|攻击")]
        for scope, pattern in patterns:
            if re.search(pattern, task, re.I):
                return scope
    return next((scope for scope, commands in SCOPES.items() if command in commands), "general")


def action_score(event: dict) -> float:
    """Completion proxy with explicit failures and partial collection; not a world-task score."""
    if event.get('death_id'):
        return 0.0
    if event.get("feedback_reward") in (0.0, 1.0):
        return float(event["feedback_reward"])
    output = str(event.get("outcome", ""))
    # Code source may contain error strings; only score the execution output.
    if output.startswith("Agent wrote this code:"):
        output = output.split("Code Output:", 1)[-1]
    failed = bool(event.get("failed")) or bool(FAILURE.search(output))
    # A speculative path not found message followed by arrival is a completed navigation.
    if re.search(r"You have reached|Successfully (?:crafted|smelted)", output, re.I):
        failed = False
    if not failed:
        return 1.0
    if re.search(r"Collected [1-9]\d* |Only smelted [1-9]", output, re.I):
        return 0.5
    return 0.0


def measurable(event: dict) -> bool:
    return (event.get("action") is True and isinstance(event.get("tokens"), int)
            and event["tokens"] > 0 and bool(event.get("outcome"))
            and not CANCELED.search(str(event["outcome"])))


def in_scope(event: dict, scope: str) -> bool:
    return scope == "general" or scope_of(event) == scope


def duration_key(event: dict):
    if event.get('command') in {'!searchForBlock', '!goToCoordinates', '!dive', '!surface', '!moveAway'}:
        return (event['command'], json.dumps(event.get('args') or [], sort_keys=True))
    production = production_change(event)
    if production:
        return (scope_of(event), production[0])
    args = event.get("args") or []
    if event.get("command") in {"!craftRecipe", "!smeltItem", "!collectBlocks"} and args:
        return (event["command"], str(args[0]))
    return None


def unit_duration(event: dict):
    duration = event.get("duration_ms")
    args = event.get("args") or []
    if not isinstance(duration, (int, float)) or duration <= 0:
        return None
    if event.get('command') in {'!searchForBlock', '!goToCoordinates', '!dive', '!surface', '!moveAway'}:
        return duration
    production = production_change(event)
    if production:
        return duration / production[1]
    if len(args) < 2:
        return None
    units = args[1]
    if not isinstance(units, (int, float)) or units <= 0:
        return None
    return duration / units


def production_change(event: dict):
    if scope_of(event) not in {"mining", "smelting", "crafting"}:
        return None
    before = (event.get("before") or {}).get("inventory")
    after = (event.get("after") or {}).get("inventory")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None
    gains = [(item, count - before.get(item, 0)) for item, count in after.items()
             if isinstance(count, (int, float)) and count > before.get(item, 0)]
    return max(gains, key=lambda item: item[1]) if gains else None


def duration_references(events: list[dict]) -> dict:
    grouped = {}
    for event in events:
        key, duration = duration_key(event), unit_duration(event)
        if key and duration and action_score(event) > 0:
            grouped.setdefault(key, []).append(duration)
    # Require repeated measurements before using timing as an efficiency signal.
    return {key: statistics.median(values) for key, values in grouped.items() if len(values) >= 2}


def reward(event: dict, references: dict) -> float:
    score = action_score(event)
    duration = unit_duration(event)
    reference = references.get(duration_key(event))
    if duration and reference:
        return score * (0.8 + 0.2 * reference / (reference + duration))
    return score * 0.9 if references else score


def rules_from(data: dict | None) -> list[dict]:
    if not data:
        return []
    if isinstance(data.get("rules"), list):
        return data["rules"]
    if data.get("guidance"):
        return [{**data, "id": f"legacy-{data.get('round', 0)}", "topic": "legacy_general",
                 "scope": "general"}]
    return []


def load_rules(path: Path) -> list[dict]:
    try:
        return rules_from(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return []


def save_rule(path: Path, rule: dict) -> int:
    rules = [old for old in load_rules(path) if old.get("topic") != rule["topic"]]
    rules.append(rule)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": 2, "rules": rules[-24:]},
                                    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    return min(len(rules), 24)
