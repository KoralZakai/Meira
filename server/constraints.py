"""constraints — the days she is not available, as data (29.10).

"Monday I'm at Midburn" was read as "move the Zumba", and Zumba then landed
at 16:15 on her vacation day: nothing anywhere said a day was CLOSED. Now a
context statement ("I'm on vacation next Monday", "don't schedule anything
tomorrow") is stored here, and every new booking is checked against it — and
against vacation / flight tasks already on her calendar (past_log.away_task).

Stored in her profile (`availability`), which is encrypted at rest
(user_profile._save → LUMI_DATA_KEY); no new store. Past entries are dropped
on every write.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Optional

import past_log
import user_profile

MAX_ENTRIES = 60


def _entries(profile_key: str) -> list:
    raw = (user_profile.get_profile(profile_key) or {}).get("availability")
    return [e for e in raw if isinstance(e, dict)] if isinstance(raw, list) else []


def add(profile_key: str, kind: str, days: list, reason: str, today: date) -> list:
    """Close these days ('unavailable' or 'no_new'). -> the days stored."""
    keep = [e for e in _entries(profile_key) if str(e.get("day")) >= today.isoformat()]
    have = {(e.get("day"), e.get("kind")) for e in keep}
    new = [d for d in days if d >= today.isoformat() and (d, kind) not in have]
    keep += [{"day": d, "kind": kind, "reason": str(reason or "")[:80]} for d in new]
    user_profile.update_profile(profile_key, availability=sorted(keep, key=lambda e: e["day"])[-MAX_ENTRIES:])
    return sorted(set(new) | {d for d in days if (d, kind) in have})


def remove(profile_key: str, days: list) -> int:
    before = _entries(profile_key)
    keep = [e for e in before if e.get("day") not in set(days)]
    if len(keep) != len(before):
        user_profile.update_profile(profile_key, availability=keep)
    return len(before) - len(keep)


def upcoming(profile_key: str, today: date) -> list:
    return [e for e in _entries(profile_key) if str(e.get("day")) >= today.isoformat()]


def blocked(profile_key: str, iso: str, day_tasks: Optional[list] = None) -> Optional[dict]:
    """Why she is not available that day, or None.
    -> {"why": "vacation at Midburn" | her own words, "source": "said" | "calendar", "kind": …}"""
    for e in _entries(profile_key):
        if e.get("day") == iso:
            return {"why": e.get("reason") or "", "source": "said", "kind": e.get("kind") or "unavailable"}
    away = past_log.away_task(day_tasks or [], iso)
    if away:
        return {"why": str(away.get("text") or ""), "source": "calendar", "kind": "unavailable"}
    return None


def say_away(why: dict, he: bool) -> str:
    """'בחופשה' / 'on vacation' — how she is away, as a phrase that follows
    "את" / "You're". From her words when she said it, from the event's title
    when the calendar holds it."""
    w = str(why.get("why") or "").strip()
    if why.get("kind") == "no_new":
        return "ביום שביקשת להשאיר פנוי" if he else "keeping that day clear"
    if why.get("source") == "calendar":
        return f"ב{w}" if he else f"away ({w})"
    if he:
        return w if w.startswith("ב") or w in ("חולה",) else "לא זמינה"
    return w if re.match(r"^(on |away|abroad|sick|out of|unavailable|not available|busy)", w, re.I) else "unavailable"
