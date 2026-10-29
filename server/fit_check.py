"""fit_check — does a task with an hour fit its day, travel included?

Koral, 28.10: "a user with many meetings, and another one comes in — check
whether it can be combined into the schedule". If not: warn that it is not
possible, and ask her — save it anyway, or find a new time.

clash_note already said "X clashes with Y" for a plain overlap. What it could
not see is the commonest impossibility on a busy day: two meetings that do not
touch on the clock but sit 80 minutes apart by road with 15 minutes between
them. This module judges a saved task against its neighbours the way the app's
"does it fit?" does (utils/dayFeasibility): the trip in from the last place
she is physically at before it, the trip on to the next one, plain overlap.
A video call does not move her. A trip that could not be measured is said,
never counted as zero (silent-state rule 1).

The core (`judge`, `find_alternative`) is pure and takes the travel function
as an argument, so the tests run it without Google.
"""
from __future__ import annotations

import logging
import re
from typing import Awaitable, Callable, Optional

import clashes
import daychain

logger = logging.getLogger(__name__)

Travel = Callable[[str, str, str], Awaitable[Optional[int]]]   # (from, to, arrive_by HH:MM) → minutes | None

_DONE = {"complete", "completed", "done", "moved", "cancelled"}
_STEP_MIN = 15
_MAX_TRIES = 24


def _m(hhmm: str) -> int:
    h, mm = str(hhmm)[:5].split(":")
    return int(h) * 60 + int(mm)


def _hhmm(total: int) -> str:
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def _place(task: dict) -> Optional[str]:
    if clashes.is_remote_task(task):
        return None
    return daychain.address_of(task)


def _blocks(rows: list, skip_id: Optional[str]) -> list:
    out = []
    for r in rows or []:
        if skip_id is not None and str(r.get("id")) == str(skip_id):
            continue
        if str(r.get("status") or "pending") in _DONE:
            continue
        start = clashes.start_of(r)
        if not start:
            continue
        out.append({"task": r, "start": _m(start), "end": _m(clashes.end_of(r)), "place": _place(r)})
    return sorted(out, key=lambda b: b["start"])


async def judge(new: dict, start: str, rows: list, travel: Travel) -> dict:
    """{fits, kind, reason_he, reason_en, unchecked} for `new` placed at `start`.

    kind: "ok" | "overlap" | "travel_in" | "travel_out"."""
    minutes = int(new.get("duration_minutes") or new.get("durationMinutes") or 60)
    s, e = _m(start), _m(start) + minutes
    blocks = _blocks(rows, new.get("id"))
    where = _place(new)
    for b in blocks:
        if b["start"] < e and b["end"] > s:
            other = b["task"].get("text")
            return {"fits": False, "kind": "overlap", "unchecked": False,
                    "reason_he": f"זה מתנגש עם '{other}' ב-{_hhmm(b['start'])}",
                    "reason_en": f"it clashes with '{other}' at {_hhmm(b['start'])}"}
    unchecked = False
    if where:
        prev = next((b for b in reversed(blocks) if b["end"] <= s and b["place"]), None)
        nxt = next((b for b in blocks if b["start"] >= e and b["place"]), None)
        if prev:
            mins = await travel(prev["place"], where, _hhmm(s))
            if mins is None:
                unchecked = True
            elif prev["end"] + mins > s:
                return {"fits": False, "kind": "travel_in", "unchecked": False,
                        "reason_he": f"'{prev['task'].get('text')}' נגמר ב-{_hhmm(prev['end'])} והנסיעה {mins} דק׳",
                        "reason_en": f"'{prev['task'].get('text')}' ends at {_hhmm(prev['end'])} and the trip takes {mins} min"}
        if nxt:
            mins = await travel(where, nxt["place"], _hhmm(nxt["start"]))
            if mins is None:
                unchecked = True
            elif e + mins > nxt["start"]:
                return {"fits": False, "kind": "travel_out", "unchecked": False,
                        "reason_he": f"לא תגיעי משם ל'{nxt['task'].get('text')}' ב-{_hhmm(nxt['start'])} ({mins} דק׳ נסיעה)",
                        "reason_en": f"you wouldn't get from there to '{nxt['task'].get('text')}' at {_hhmm(nxt['start'])} ({mins} min away)"}
    return {"fits": True, "kind": "ok", "unchecked": unchecked, "reason_he": "", "reason_en": ""}


async def find_alternative(new: dict, start: str, rows: list, travel: Travel,
                           day_start: str = "08:00", day_end: str = "22:00",
                           not_before: Optional[str] = None) -> Optional[str]:
    """The nearest start that DOES fit that day — later first, then earlier — checked by `judge`."""
    minutes = int(new.get("duration_minutes") or new.get("durationMinutes") or 60)
    lo = max(_m(day_start), _m(not_before) if not_before else 0)
    hi = _m(day_end) - minutes
    base = _m(start)
    seen, tries = set(), 0
    for k in range(1, 4 * 24):
        for cand in (base + k * _STEP_MIN, base - k * _STEP_MIN):
            if cand < lo or cand > hi or cand in seen:
                continue
            seen.add(cand)
            tries += 1
            v = await judge(new, _hhmm(cand), rows, travel)
            if v["fits"]:
                return _hhmm(cand)
            if tries >= _MAX_TRIES:
                return None
    return None


def cached(travel: Travel) -> Travel:
    """One Directions call per (from, to) pair while a turn is judged — the alternative search asks many times."""
    memo: dict = {}

    async def go(a: str, b: str, arrive_by: str) -> Optional[int]:
        key = (a.strip().lower(), b.strip().lower())
        if key[0] == key[1]:
            return 0
        if key not in memo:
            memo[key] = await travel(a, b, arrive_by)
        return memo[key]
    return go


def question(task: dict, verdict: dict, alt: Optional[str], he: bool) -> str:
    """The warning and the question — her words (28.10): not possible; save anyway, or a new time?"""
    when = str(task.get("fixed_time") or "")[:5]
    name = task.get("text")
    if he:
        tail = f" פנוי ב-{alt}." if alt else " אין שעה אחרת שנכנסת באותו יום."
        ask = "לשמור בכל זאת, או לקבוע בשעה החדשה?" if alt else "לשמור בכל זאת, או לחפש יום אחר?"
        return f"⚠️ '{name}' ב-{when} לא נכנס: {verdict['reason_he']}.{tail} {ask}"
    tail = f" {alt} is free." if alt else " No other hour fits that day."
    ask = "Keep it anyway, or move it to the new time?" if alt else "Keep it anyway, or look for another day?"
    return f"⚠️ '{name}' at {when} doesn't fit: {verdict['reason_en']}.{tail} {ask}"


def replies(alt: Optional[str], he: bool) -> list:
    if he:
        return ["לשמור בכל זאת"] + ([f"לקבוע ב-{alt}"] if alt else ["לחפש יום אחר"])
    return ["Keep it anyway"] + ([f"Move to {alt}"] if alt else ["Find another day"])


_KEEP = {"לשמור בכל זאת", "בכל זאת", "תשאירי", "להשאיר", "תשאירי ככה", "keep it anyway", "keep it", "keep anyway"}
_MOVE = {"לקבוע בשעה החדשה", "בשעה החדשה", "תזיזי", "תזיזי לשם", "move it", "the new time"}


def reading(text: str, pending: dict) -> Optional[str]:
    """Her answer to the question: "keep" | "move" | None — anything else goes on as a normal turn.

    Strict on purpose: the buttons' own words, a few short equivalents, or the
    new hour alone. "remind me at 15:30 to call mom" or "move the meeting with
    Danny" must not move THIS task."""
    t = re.sub(r"[\s.!?✓]+$", "", (text or "").strip().lower())
    alt = pending.get("alt")
    if alt and t in {f"לקבוע ב-{alt}", f"לקבוע ב{alt}", f"ב-{alt}", alt, f"move to {alt}", f"at {alt}"}:
        return "move"
    if alt and t in _MOVE:
        return "move"
    if t in _KEEP:
        return "keep"
    return None
