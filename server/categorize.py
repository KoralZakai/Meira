"""categorize — category, priority and duration from the words themselves.

This was a keyword lookup table wrapped in a full LLM round-trip. Deciding that
"ראיון עבודה" is an interview does not need a 235B-parameter model; it needs a
list. The model still extracts tasks out of free text — that part is genuinely
language work — but the moment we have the task's words, the label is a lookup,
and a lookup that costs nothing can run on EVERY task instead of only the ones
we were willing to pay for.

Two rules govern the port:

1. **Hebrew is not a fallback.** Every English keyword here has its Hebrew
   counterpart in the same rule, because the app's history is a long line of
   English-only regexes that silently returned nothing for the language the
   user actually types in. Word boundaries (`\\b`) are deliberately NOT used —
   they do not work against Hebrew letters, which is how one earlier
   number-parsing path became dead code without anyone noticing.

2. **The model may only fill in what the table left blank.** `merge` takes the
   deterministic answer and the model's answer and prefers the table for
   category/priority/duration whenever the table actually matched, so a
   confident wrong label from the model cannot overwrite a correct one. What
   the model is still trusted for is anything the table has no opinion about.

Defaults for duration come from CLAUDE.md; `learned` lets LearningService's
per-category rolling average win over the static default once it has data.

Pure, stdlib only. Consumed by lumi_agent.infer_task_details and by the task
extraction path in main.py.
"""
from __future__ import annotations

import re
from typing import Optional

# CLAUDE.md's default durations, in minutes.
DEFAULT_DURATIONS = {
    "interview": 90, "course": 60, "conference": 120, "class": 90, "work": 60,
    "meeting": 45, "call": 15, "doctor": 60, "gym": 60, "aspiration": 30,
    "leisure": 60, "general": 30, "zoom": 45, "hobby_class": 90,
}

# Order matters: the FIRST rule that matches wins, so the specific ones
# ('interview') sit above the general ones ('meeting', 'work').
_RULES: list[tuple[str, list[str], str, int]] = [
    # category,      keywords (en + he),                                        priority,  duration
    ("interview",   ["interview", "ראיון", "ראיונות"],                            "must",       90),
    ("doctor",      ["doctor", "dentist", "clinic", "medical", "pharmacy",
                     "רופא", "רופאה", "שיניים", "מרפאה", "תור לרופא", "בדיקה"],   "must",       60),
    ("zoom",        ["zoom", "teams", "google meet", "video call", "webinar",
                     "זום", "מיטס", "וידאו"],                                    "have_to",    45),
    ("conference",  ["conference", "summit", "convention", "כנס", "כנסים"],       "have_to",   120),
    ("gym",         ["gym", "workout", "training", "fitness", "run", "running",
                     "yoga", "pilates", "swim", "אימון", "חדר כושר", "כושר",
                     "ריצה", "יוגה", "שחייה", "פילאטיס", "קיקבוקס"],              "need_to",    60),
    ("course",      ["course", "study", "studying", "lecture", "homework",
                     "exam", "assignment", "קורס", "ללמוד", "לימודים",
                     "הרצאה", "שיעורי בית", "מבחן", "תרגיל", "הגשה"],             "have_to",    60),
    ("class",       ["class", "lesson", "seminar", "שיעור", "סדנה"],              "have_to",    90),
    ("hobby_class", ["hobby", "workshop", "חוג", "חוגים"],                        "nice_to_do", 90),
    ("meeting",     ["meeting", "appointment", "1:1", "standup", "sync",
                     "פגישה", "פגישות", "מפגש", "תור"],                           "have_to",    45),
    ("call",        ["call", "phone", "ring", "voicemail",
                     "להתקשר", "שיחה", "טלפון", "לחזור אליו", "לחזור אליה"],      "need_to",    15),
    ("work",        ["work", "office", "project", "deploy", "shift", "client",
                     "עבודה", "משרד", "פרויקט", "משמרת", "לקוח"],                 "have_to",    60),
    ("leisure",     ["movie", "cinema", "relax", "party", "dinner out", "beach",
                     "סרט", "קולנוע", "מסיבה", "לנוח", "חוף", "בילוי"],           "nice_to_do", 60),
    ("aspiration",  ["goal", "dream", "someday", "שאיפה", "חלום", "מתישהו"],      "nice_to_do", 30),
]

# Words that override the rule's priority — urgency the user stated out loud.
_MUST = re.compile(r"urgent|asap|critical|must|deadline|due today"
                   r"|דחוף|חייב|חייבת|קריטי|היום חייב|דדליין", re.IGNORECASE)
_NICE = re.compile(r"maybe|if i have time|whenever|sometime|nice to"
                   r"|אולי|אם יהיה זמן|מתישהו|לא דחוף|בכיף", re.IGNORECASE)

VALID_CATEGORIES = set(DEFAULT_DURATIONS)
VALID_PRIORITIES = ("must", "have_to", "need_to", "nice_to_do")


def infer(text: str, learned: Optional[dict] = None) -> dict:
    """Label one task from its words alone. No I/O, no model, no network.

    Returns {category, priority, duration_minutes, matched} — `matched` is False
    when nothing in the table fired, which is the caller's signal that the
    model's own guess is worth keeping.
    """
    lowered = (text or "").lower()
    category, priority, duration, matched = "general", "need_to", 30, False

    for cat, keywords, pri, dur in _RULES:
        if any(kw in lowered for kw in keywords):
            category, priority, duration, matched = cat, pri, dur, True
            break

    if _MUST.search(lowered):
        priority = "must"
    elif _NICE.search(lowered) and priority != "must":
        priority = "nice_to_do"

    if learned:
        # LearningService's rolling average beats a static default once it has
        # real completions behind it (>= 3 data points is enforced by the caller).
        try:
            duration = int(learned.get(category) or duration)
        except (TypeError, ValueError):
            pass

    return {"category": category, "priority": priority,
            "duration_minutes": duration, "matched": matched}


def merge(text: str, model: Optional[dict] = None, learned: Optional[dict] = None) -> dict:
    """Deterministic label, with the model allowed to fill the blanks only.

    The table wins whenever it matched — a confident wrong category from the
    model is the failure this whole consolidation exists to remove. When the
    table did NOT match, the model's guess is used if it is a real category /
    priority, and the static default duration for that category applies.
    """
    model = model or {}
    determined = infer(text, learned)
    if determined["matched"]:
        return {k: determined[k] for k in ("category", "priority", "duration_minutes")}

    category = model.get("category")
    category = category if category in VALID_CATEGORIES else "general"
    priority = model.get("priority")
    priority = priority if priority in VALID_PRIORITIES else determined["priority"]

    duration = model.get("duration_minutes")
    try:
        duration = int(duration)
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        duration = DEFAULT_DURATIONS.get(category, 30)
        if learned and learned.get(category):
            try:
                duration = int(learned[category])
            except (TypeError, ValueError):
                pass

    return {"category": category, "priority": priority, "duration_minutes": duration}


if __name__ == "__main__":   # self-check: python server/categorize.py
    assert infer("ראיון עבודה במר גרופ")["category"] == "interview"
    assert infer("ראיון עבודה במר גרופ")["priority"] == "must"
    assert infer("gym at 18:00")["category"] == "gym"
    assert infer("אימון בחדר כושר")["category"] == "gym"
    assert infer("להתקשר לאמא")["category"] == "call"
    assert infer("להתקשר לאמא")["duration_minutes"] == 15
    assert infer("דחוף לשלוח מייל")["priority"] == "must"
    assert infer("אולי לצאת לסרט")["priority"] == "nice_to_do"
    assert infer("water the plants")["matched"] is False
    # The model may not overwrite a match, but may fill a blank.
    assert merge("ראיון עבודה", {"category": "leisure"})["category"] == "interview"
    assert merge("water the plants", {"category": "leisure"})["category"] == "leisure"
    assert merge("water the plants", {})["duration_minutes"] == 30
    assert merge("שיעור פילאטיס", {}, learned={"gym": 75})["duration_minutes"] == 75
    print("categorize self-check OK")
