"""Her bike or car is somewhere else: what exactly is she asking? (Koral, 19.10)

A word list could not read "אני צריכה לקחת את האופנים שלי מפלורנטין תחשבי לי
מתי ואיך" — it knew "לאסוף", not "לקחת", and "אופניים", not "אופנים" — and the
general understanding step called it a route to a place. Then "כן" (yes,
work it out) meant nothing at all on its own.

So: a cheap cue (a bike or car is mentioned, here or in her last turns) opens
ONE focused model call that reads the conversation and fills slots. The model
reads language; code plans (vehicle_chain). Nothing is invented: a slot it
cannot fill stays null, and the regex reader in understand is the fallback when
the model cannot run.

-> {"what": "vehicle", vehicle, vehicle_at, event_task_id, event_words,
    also: [{what, start, end?, place?}], origin, modes, open_now} or None.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

import llm_usage
import model_router

logger = logging.getLogger(__name__)

# A bike or car is in the conversation at all — the only gate for the call.
CUE_RE = re.compile(r"אופני?ים|אופנ|קורקינט|האוטו|הרכב|האוטו שלי|\b(bike|bicycle|scooter|my car)\b", re.I)

_SYSTEM = (
    "The user's bike or car is (maybe) somewhere other than where she is, and she may "
    "want Meira to plan how and when to get it. Read the conversation; her LAST message "
    "is what matters, earlier turns give context ('כן' / 'yes' after Meira offered to "
    "plan = she wants it planned). Reply with JSON only:\n"
    '{"is_vehicle_plan": true|false,'
    '"vehicle": "bike|car",'
    '"vehicle_at": "where the bike/car is now, as she said it (a street, area or place) — '
    'never a verb, never words like תחשבי/מתי/איך; null if not said anywhere in the conversation",'
    '"event_task_id": "the id from HER DAY of an event she said she must get to, else null",'
    '"event_words": "the words she used for that event, else null",'
    '"also": [{"what": "something else she wants to do today that the plan must fit, e.g. '
    'אימון / gym", "start": "HH:MM 24h or null", "end": "HH:MM or null", '
    '"place": "as she said it or null"}]}\n'
    "is_vehicle_plan is true for: picking up / taking / fetching / bringing / getting her "
    "bike or car back from somewhere, or getting somewhere while it is elsewhere — in any "
    "wording (לאסוף / לקחת / להביא / להחזיר / pick up / grab / get). False when the vehicle "
    "is only how she travels ('I'll go by bike'). Times: 24h, a bare evening hour is PM "
    "('ב-8 להתאמן' with NOW after noon → 20:00). Hebrew and English alike."
)

_TIMEOUT_S = 15


def _client():
    import task_extract
    return task_extract._get_client()


def _day_lines(day: list) -> str:
    rows = []
    for t in (day or [])[:25]:
        when = str(t.get("fixed_time") or t.get("fixedTime") or "—")[:5]
        rows.append(f"- id={t.get('id')} | {when} | {t.get('text')}")
    return "\n".join(rows) or "(nothing)"


def mentions_vehicle(message: str, history: Optional[list] = None) -> bool:
    if CUE_RE.search(message or ""):
        return True
    # "כן" after Meira offered to plan the pickup: the cue is in the turns before.
    for turn in (history or [])[-4:]:
        if CUE_RE.search(str((turn or {}).get("content") or "")):
            return True
    return False


async def extract(message: str, history: Optional[list], day: list, now_hhmm: str) -> Optional[dict]:
    """The slots, or None when it is not a vehicle plan or the model could not run."""
    turns = [{"role": t.get("role"), "content": str(t.get("content") or "")[:600]}
             for t in (history or [])[-6:] if t.get("role") in ("user", "assistant")]
    context = (f"NOW: {now_hhmm} (Israel)\nHER DAY (today):\n{_day_lines(day)}\n\n"
               f"HER LAST MESSAGE:\n{message}")
    model = model_router.pick("vehicle_understand", prompt_chars=len(_SYSTEM) + len(context))
    try:
        r = await _client().chat.completions.create(
            model=model, temperature=0, response_format={"type": "json_object"}, timeout=_TIMEOUT_S,
            messages=[{"role": "system", "content": _SYSTEM}, *turns, {"role": "user", "content": context}])
        if r.usage:
            llm_usage.record("vehicle_understand", r.usage.prompt_tokens or 0,
                             r.usage.completion_tokens or 0, model)
        payload = json.loads(r.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001 — the regex reader is the fallback, and says so
        logger.warning("vehicle_intent: model step failed: %s", exc)
        return None
    return slots_of(payload)


def slots_of(payload) -> Optional[dict]:
    """The model's JSON → a vehicle lookup, or None (not a plan / nowhere to fetch from)."""
    if not isinstance(payload, dict) or payload.get("is_vehicle_plan") is not True:
        return None
    at = str(payload.get("vehicle_at") or "").strip()
    if not at or at.lower() in ("null", "none"):
        logger.warning("vehicle_intent: a vehicle plan with no place for the vehicle")
        return None
    vehicle = str(payload.get("vehicle") or "bike").strip().lower()
    event = str(payload.get("event_task_id") or "").strip()
    words = str(payload.get("event_words") or "").strip()
    also = []
    for a in payload.get("also") or []:
        if isinstance(a, dict) and str(a.get("what") or "").strip():
            also.append({k: (str(a.get(k)).strip() if a.get(k) not in (None, "", "null") else None)
                         for k in ("what", "start", "end", "place")})
    logger.warning("vehicle_intent: plan (event=%s, also=%d)", bool(event or words), len(also))
    return {"what": "vehicle", "vehicle": vehicle if vehicle in ("bike", "car") else "bike",
            "vehicle_at": at[:80],
            "event_task_id": None if event.lower() in ("", "null", "none") else event[:64],
            "event_words": None if words.lower() in ("", "null", "none") else words[:80],
            "also": also[:3], "modes": [], "origin": "auto", "open_now": False}
