"""checkin_parse — the check-in screen's verdict on what the user just said.

NO MODEL CALL. This used to send every transcript to Nebius to be sorted into
one of nine intents and have its tasks pulled out. Two things were wrong with
that: the phone already answers the same question offline in under a
millisecond (`src/services/TaskIntent.ts`, which deleted its own LLM fallback on
exactly this reasoning), and a check-in is the most latency-sensitive screen in
the product — the user has just spoken and is watching a spinner.

So the work is split the way the rest of the server splits it:

    task_intent   which intent, which existing task, what changed   (rules)
    task_extract  the deterministic half of turning a clause into a task
    categorize    category, priority, duration                      (a table)

Nothing here can be unavailable, so `parse` no longer returns None for anything
but empty text, and the client's 502 fallback path is effectively unreachable —
kept on the client because the network can still fail before the request
arrives.

What was lost with the model: free-form `how` / `why` / contact extraction and
`subgroup` labelling. The screen renders those when present and ignores them
when absent; none is worth a round trip on every check-in. If they are wanted
back they belong in the capture endpoint that already makes a call
(task_extract), not in a second one.

Dependencies: categorize, task_extract, task_intent, tz. Consumed by
routes_app.POST /app/checkin/parse.
"""
from __future__ import annotations

import logging
from typing import Optional

import categorize
import task_extract
import task_intent
import tz as _tz

logger = logging.getLogger(__name__)

INTENTS = task_intent.INTENTS

#: Lumi's one line back. SHORT — the schedule is the answer, not the sentence
#: about it (CLAUDE.md: never a speech).
_MESSAGES = {
    "add_tasks": "נוסף ✓",
    "check_in": "יופי, רשמתי 👏",
    "task_update": "עודכן ✓",
    "wake_up": "אעיר אותך ⏰",
    "optimize": "מסדרת לך את היום 👇",
    "profile_update": "רשמתי לי 📝",
    "conflict": "יש כאן התנגשות 👀",
    "empty_list": "אין בעיה 🌤",
    "classify_group": "רשמתי ✓",
}


def _label(task: dict) -> dict:
    """Category, priority and duration from the table — the same table the
    WhatsApp channel uses, so one sentence gets one label everywhere."""
    text = str(task.get("text") or "")
    labelled = categorize.merge(text, {"category": task.get("category"),
                                       "priority": task.get("priority")})
    location = task.get("location") or None
    deadline = task.get("deadline") or None
    return {
        "text": text,
        "priority": labelled["priority"],
        "category": labelled["category"],
        "duration_minutes": labelled["duration_minutes"],
        "subgroup": task.get("subgroup") or None,
        "hasLocation": bool(location),
        "location": location,
        "hasDeadline": bool(deadline),
        "deadline": deadline,
        "how": task.get("how") or None,
        "why": task.get("why") or None,
        "contact_name": task.get("contact_name") or None,
        "contact_phone": task.get("contact_phone") or None,
    }


def _task_from_clause(clause: str) -> dict:
    """One spoken clause → the labelled task shape the screen renders.

    `task_extract.finalize` is the deterministic half of the capture path, so a
    task captured at check-in and the same words typed into Add Task get the
    same category, the same duration and the same clock time.
    """
    built = task_extract.finalize({}, clause, _tz.today_il())
    return _label({
        "text": built["text"],
        "category": built["category"],
        "priority": built["priority"],
        "location": built.get("location"),
        "deadline": built.get("fixed_time"),
    })


async def parse(transcript: str, mode: str = "capture",
                pending_task_texts: Optional[list] = None) -> Optional[dict]:
    """The verdict for one check-in transcript. None only for an empty one.

    Async purely to keep the caller's signature — there is nothing to await.
    """
    transcript = (transcript or "").strip()
    if not transcript:
        return None

    intent = task_intent.classify(transcript, mode)

    tasks: list = []
    updates: list = []
    matched: list = []

    if intent in ("add_tasks", "classify_group"):
        tasks = [t for t in (_task_from_clause(c)
                             for c in task_intent.split_clauses(transcript)) if t["text"]]
        if not tasks:
            # The sentence itself, rather than nothing. Dropping what the user
            # just said is the worst outcome available (same rule as
            # task_extract.extract).
            tasks = [_task_from_clause(transcript)]

    elif intent == "task_update":
        ref = task_intent.reference(transcript)
        patch = task_intent.extract_patch(transcript)
        # Prefer a real pending task over the raw reference: the screen matches
        # on target_text, so "gym" only finds "Gym 18:00" if that is what we
        # send back.
        targets = task_intent.match_existing(ref or transcript, pending_task_texts)
        target = targets[0] if targets else ref
        if target:
            updates = [{"target_text": target, "new_text": None,
                        "new_location": None,
                        "new_deadline": patch.get("new_deadline")}]
            matched = targets[:1]

    elif intent == "check_in":
        matched = task_intent.match_existing(transcript, pending_task_texts)

    return {
        "intent": intent if intent in INTENTS else ("add_tasks" if mode == "capture" else "check_in"),
        "tasks": tasks,
        "task_updates": updates,
        "matched_task_texts": matched,
        "conflicts": [],
        "suggestions": [],
        "permissions_needed": [],
        "lumi_message": _MESSAGES.get(intent, ""),
        "source": "deterministic",
    }


if __name__ == "__main__":   # self-check: python server/checkin_parse.py
    import asyncio

    labelled = _label({"text": "ראיון עבודה", "category": "leisure", "location": "מר גרופ"})
    assert labelled["category"] == "interview", "the table overrules the caller"
    assert labelled["priority"] == "must"
    assert labelled["hasLocation"] is True
    assert _label({"text": "water the plants"})["category"] == "general"

    out = asyncio.run(parse("יוגה ב-11:00", "capture"))
    assert out["intent"] == "add_tasks" and out["tasks"][0]["deadline"] == "11:00"
    assert out["source"] == "deterministic"

    review = asyncio.run(parse("סיימתי עם הרופא", "review", ["תור לרופא", "יוגה"]))
    assert review["intent"] == "check_in" and review["matched_task_texts"] == ["תור לרופא"]
    print("checkin_parse self-check OK")
