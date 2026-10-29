"""user_rules — what she taught Meira by answering the same way twice.

Koral (6.10): after each question, "learn conclusions from how I answered and
update the rules". Her pick on how: Meira notices and ASKS before making it a
rule ("Twice you said 'every day'. When you don't write a day — assume every
day?"). A rule nobody confirmed would be a guess that silently changes her
plans, which is the failure this project keeps shipping (CLAUDE.md,
silent-state rule).

A rule, once she says yes:
  - stops the question it answers (the phone: utils/routinePolicy.ts),
  - is told to the agent in its per-user block (prompt_block) — AFTER the
    static rules, never inside them, so the prompt cache holds,
  - is listed in You → "What I learned from you", with ✕.
✕ removes it and keeps it from being proposed again for QUIET_DAYS.

Only answers that generalise become rules: "every day", "changes weekly",
"Sunday–Thursday". Two routines that both happen on Tuesday are a coincidence,
not a rule about the next one.

Store: {brain_key: {"rules": [rule], "declined": {rule_id: until}}}.
Encrypted, deleted with the account (account_deletion._STORE_MODULES).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import config
import identity_keys
import questions_store
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "user_rules.json")
PROPOSE_AFTER = 2
WINDOW_DAYS = 60
QUIET_DAYS = 30

# value key → what the rule says, and the question that proposes it.
_RULES = {
    "routine_days:every_day": {
        "text": {"en": "A routine with no day written is every day",
                 "he": "שגרה בלי יום כתוב היא כל יום"},
        "ask": {"en": "Twice you said “every day”. When you don't write a day, should I assume every day?",
                "he": "פעמיים אמרת „כל יום”. כשאת לא כותבת יום — להניח שזה כל יום?"},
        "prompt": "When she writes a routine with no day, it is every day: save it as such, don't ask.",
        "answer": {"choice": "every_day"},
    },
    "routine_days:varies": {
        "text": {"en": "A routine with no day written changes week to week",
                 "he": "שגרה בלי יום כתוב משתנה משבוע לשבוע"},
        "ask": {"en": "Twice you said the days change every week. Should I assume that whenever you don't write a day?",
                "he": "פעמיים אמרת שהימים משתנים כל שבוע. להניח את זה תמיד כשאת לא כותבת יום?"},
        "prompt": "When she writes a routine with no day, its days change week to week: offer it in free windows, don't ask.",
        "answer": {"choice": "varies"},
    },
    "routine_days:days:0,1,2,3,4": {
        "text": {"en": "A routine with no day written is Sunday–Thursday",
                 "he": "שגרה בלי יום כתוב היא בימי א׳–ה׳"},
        "ask": {"en": "Twice you said Sunday–Thursday. When you don't write a day, should I assume Sunday–Thursday?",
                "he": "פעמיים אמרת ימי א׳–ה׳. כשאת לא כותבת יום — להניח א׳–ה׳?"},
        "prompt": "When she writes a routine with no day, it is Sunday–Thursday: save it as such, don't ask.",
        "answer": {"choice": "days", "days": [0, 1, 2, 3, 4]},
    },
}


def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _value_key(kind: str, answer: dict) -> str:
    choice = answer.get("choice")
    if choice == "days":
        return f"{kind}:days:{','.join(str(d) for d in sorted(answer.get('days') or []))}"
    return f"{kind}:{choice}"


def _mine(data: dict, user_key: str) -> dict:
    brain = identity_keys.canonical(user_key)
    rec = data.get(brain)
    return rec if isinstance(rec, dict) else {"rules": [], "declined": {}}


def rules(user_key: str) -> list:
    """Her confirmed rules, oldest first."""
    return list(_mine(_load(), user_key).get("rules") or [])


def rule_for(user_key: str, kind: str) -> Optional[dict]:
    return next((r for r in rules(user_key) if r.get("kind") == kind), None)


def proposal_after(user_key: str, kind: str, now: Optional[float] = None) -> Optional[dict]:
    """A rule to propose after this answer, or None.

    Proposed when her last PROPOSE_AFTER answers of this kind (within
    WINDOW_DAYS) all say the same generalisable thing and no answer in the
    window says otherwise — and only if she has no rule for this kind yet and
    has not said no to this one in the last QUIET_DAYS."""
    now = now or time.time()
    recent = [a for a in questions_store.answers(user_key, kind)
              if (a.get("at") or 0) >= now - WINDOW_DAYS * 86400]
    if len(recent) < PROPOSE_AFTER:
        return None
    values = {_value_key(kind, a.get("answer") or {}) for a in recent}
    if len(values) != 1:
        return None
    rule_id = values.pop()
    spec = _RULES.get(rule_id)
    if not spec or rule_for(user_key, kind):
        return None
    if (_mine(_load(), user_key).get("declined") or {}).get(rule_id, 0) > now:
        return None
    return {"id": rule_id, "kind": kind, "count": len(recent), "text": spec["text"], "ask": spec["ask"]}


def confirm(user_key: str, rule_id: str, yes: bool) -> Optional[dict]:
    """Her answer to a proposal. Yes → the rule (returned); no → quiet for QUIET_DAYS."""
    spec = _RULES.get(rule_id)
    if not spec:
        raise ValueError("unknown rule")
    data = _load()
    brain = identity_keys.canonical(user_key)
    mine = _mine(data, brain)
    kind = rule_id.split(":", 1)[0]
    if not yes:
        mine.setdefault("declined", {})[rule_id] = time.time() + QUIET_DAYS * 86400
        data[brain] = mine
        _save(data)
        return None
    rule = {"id": rule_id, "kind": kind, "answer": spec["answer"], "text": spec["text"], "at": time.time()}
    mine["rules"] = [r for r in mine.get("rules") or [] if r.get("kind") != kind] + [rule]
    data[brain] = mine
    _save(data)
    return rule


def remove(user_key: str, rule_id: str) -> bool:
    """✕ in You: the rule goes, and is not proposed again for QUIET_DAYS."""
    data = _load()
    brain = identity_keys.canonical(user_key)
    mine = _mine(data, brain)
    before = list(mine.get("rules") or [])
    mine["rules"] = [r for r in before if r.get("id") != rule_id]
    if len(mine["rules"]) == len(before):
        return False
    mine.setdefault("declined", {})[rule_id] = time.time() + QUIET_DAYS * 86400
    data[brain] = mine
    _save(data)
    return True


def prompt_block(user_key: str) -> str:
    """Her rules for the agent's per-user block (after _STATIC_RULES)."""
    lines = [_RULES[r["id"]]["prompt"] for r in rules(user_key) if r.get("id") in _RULES]
    if not lines:
        return ""
    return "RULES SHE TAUGHT YOU (from her answers):\n" + "\n".join(f"- {l}" for l in lines) + "\n"
