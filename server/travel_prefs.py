"""How this person actually travels to each place.

The gap this closes, from a real message:

    "ב 11:00 יוגה ביגאל אלון 94"
        -> _has_travel_mode() is False, so Lumi ASKS "how will you get there?"
        -> no route, no leave time, no wake alarm, until she answers

Asking is the right default the FIRST time — guessing a bus for someone who
cycles produces a confidently wrong leave time, which is worse than a question.
But asking the fifth time is not caution, it is forgetting. Once she has said
"by bike" for the gym, using it again is remembering, not assuming.

Two levels, because both are true at different times:
  - the PLACE ("יגאל אלון 94" -> bike) wins when we have it: it is the most
    specific thing we know;
  - the CATEGORY ("gym" -> bike) carries to a gym she has never been to.

A single confirmation is enough to act on, because the reply always SAYS which
assumption it used ("assuming by bike, like last time"). A stated assumption is
correctable in three words; a silent one is a wrong alarm. Wrong guesses cost
one message, and the correction is itself a confirmation that outvotes the old
one over time.

Dependencies: config (DATA_DIR). Written by main._route_for_task when the user
names a mode; read there before falling back to asking.
"""
import json
import logging
import os
import re
from typing import Optional

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)
_PATH = os.path.join(config.DATA_DIR, "travel_prefs.json")

VALID_MODES = {"bus", "train", "bike", "walk", "car"}


def _digits(phone: str) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _key(phone: str) -> str:
    """Last 9 digits — the same rule supabase_tasks uses, so a preference
    learned from '0500000000' is found again under '972500000000'."""
    d = _digits(phone)
    return d[-9:] if len(d) >= 9 else d


def place_key(place: str) -> str:
    """A stable key for an address.

    Normalized hard on purpose: 'יגאל אלון 94', 'יגאל אלון 94, תל אביב' and
    'Yigal Alon 94' should not each start learning from scratch. House number
    is kept — it is what distinguishes two gyms on one street.
    """
    s = (place or "").strip().lower()
    # Everything before the first comma. Google formats as
    # "street number, city, district, country" and a person types just the
    # street — so the head is the part both forms agree on. Stripping city
    # names by pattern instead left debris ("תל אביב-יפו, מחוז תל אביב" turned
    # "יגאל אלון 94" into "יגאל אלון 94 אביב", a third distinct key).
    parts = [p.strip() for p in s.split(",") if p.strip()]
    s = parts[0] if parts else ""
    # Google sometimes leads with the house number ("33, Florentin Street, …").
    # A bare number is not a place — it would collide with every other "33" in
    # the city — so pull in the street that follows it.
    if len(parts) > 1 and re.fullmatch(r"\d+[a-zא-ת]?", s):
        s = f"{s} {parts[1]}"
    s = re.sub(r"[.،]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:60]


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: movement patterns. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def remember(phone: str, mode: str, place: Optional[str] = None,
             category: Optional[str] = None) -> None:
    """Record one confirmed choice against the place AND its category."""
    if mode not in VALID_MODES:
        return
    key = _key(phone)
    if not key:
        return
    data = _load()
    mine = data.setdefault(key, {"places": {}, "categories": {}})
    if place:
        pk = place_key(place)
        if pk:
            counts = mine["places"].setdefault(pk, {})
            counts[mode] = counts.get(mode, 0) + 1
    if category:
        counts = mine["categories"].setdefault(str(category), {})
        counts[mode] = counts.get(mode, 0) + 1
    _save(data)
    # One row per route, so "place:gym" and "category:gym" stay distinct keys —
    # the same split the file keeps, flattened into the table's `route` column.
    for route in (f"place:{place_key(place)}" if place else None,
                  f"category:{category}" if category else None):
        if route:
            database_service.shadow_write(
                database_service.remember_travel_mode(key, route, mode))


def _winner(counts: dict) -> Optional[str]:
    """Most-used mode, ties broken deterministically so the answer is stable."""
    if not counts:
        return None
    best = max(counts.items(), key=lambda kv: (kv[1], kv[0]))
    return best[0] if best[1] > 0 else None


def preferred(phone: str, place: Optional[str] = None,
              category: Optional[str] = None) -> Optional[str]:
    """The mode to use without asking, or None to ask.

    Place beats category: how she gets to THIS address is better evidence than
    how she usually gets to places like it.
    """
    key = _key(phone)
    if not key:
        return None
    mine = _load().get(key) or {}
    if place:
        got = _winner((mine.get("places") or {}).get(place_key(place), {}))
        if got:
            return got
    if category:
        got = _winner((mine.get("categories") or {}).get(str(category), {}))
        if got:
            return got
    return None


# Wording for the assumption line. Said out loud every time a remembered mode
# is used, so a wrong memory costs one correction rather than a missed alarm.
_LABEL = {
    "bus":   ("🚌 באוטובוס",  "🚌 by bus"),
    "train": ("🚆 ברכבת",     "🚆 by train"),
    "bike":  ("🚲 באופניים",  "🚲 by bike"),
    "walk":  ("🚶 ברגל",      "🚶 on foot"),
    "car":   ("🚗 ברכב",      "🚗 by car"),
}


def assumption_line(mode: str, lang: str) -> str:
    he, en = _LABEL.get(mode, (mode, mode))
    return (f"מניחה ש{he} כמו בפעם הקודמת — תגידי אם לא."
            if lang == "he" else
            f"Assuming {en}, like last time — tell me if not.")
