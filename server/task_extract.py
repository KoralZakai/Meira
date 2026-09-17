"""task_extract — free text in, structured tasks out, for the app's capture flow.

The phone used to do this: `TaskParser.ts` sent the user's sentence to Nebius
with the API key compiled into the APK, parsed the JSON, and then re-derived
dates, categories and times in TypeScript that had drifted from the server's
version of the same logic. This is that job, moved to the one place that can
hold a secret and the one place the WhatsApp channel already runs.

The division of labour is the point of the whole consolidation:

    the MODEL  reads the sentence and says what the tasks ARE
    the CODE   decides the date, the label, the duration and the clock time

So a model that answers `[]` for a perfectly clear Hebrew sentence — which is
exactly what happened, repeatedly — can no longer make a task disappear: the
fallback keeps the sentence as one task and the deterministic passes still fill
in everything they can. And a model that cheerfully invents "24.7" for the day
after 26.7 can no longer put an appointment in the past, because it is not the
one holding the calendar.

Uses the CHEAP model (config.LLM_MODEL_CHEAP) when one is configured: this is
Tier-1 extraction, not reasoning, and it was previously paying flagship prices.

Dependencies: config, categorize, day_schedule, tz, llm_usage. Consumed by
routes_app.POST /app/tasks/extract.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date as _date
from typing import Optional

from openai import AsyncOpenAI

import categorize
import config
import model_router
import day_schedule
import llm_usage
import tz as _tz

logger = logging.getLogger(__name__)

_client: Optional[AsyncOpenAI] = None

_SYSTEM = (
    "You are Lumi's task extractor. Reply with JSON only, no prose: "
    '{"tasks":[{"text":"short task title","fixed_time":"HH:MM start time if a clock '
    'time is given, else null","duration_minutes":"length in minutes when a RANGE is '
    'given (\'7pm-8pm\', \'משבע עד שמונה\') else null","date_expression":"the user\'s own '
    "words for when — מחר / next Monday / 21.7 — else null\","
    '"location":"place or address as said, else null","is_recurring":false,'
    '"recurrence_type":"daily|weekly|monthly or null","recurrence_days":null}]}\n'
    "\n"
    "ONE REAL-WORLD COMMITMENT = ONE TASK. Never split one commitment into several. "
    "These are NOT tasks and must never appear in the array:\n"
    " - reminders, alerts or alarms about a task ('remind me', 'תזכיר לי', 'התראה')\n"
    " - preparing for, leaving for, or travelling to a task\n"
    " - the end time of a range\n"
    "'Yoga class at the studio 7pm-8pm, remind me before' is exactly ONE task: "
    '{"text":"Yoga class","fixed_time":"19:00","duration_minutes":60}.\n'
    "\n"
    "Keep the user's own wording and language — Hebrew stays Hebrew. Do NOT resolve "
    "dates yourself, copy the expression; the server holds the calendar. Do NOT "
    "invent a category or a priority; the server labels the task. "
    "'every day for 5 days' is ONE recurring task, not five. "
    "Earlier messages are context only — extract tasks ONLY from the LAST user "
    'message. If nothing actionable was said, reply {"tasks":[]}.'
)

# 'ב-9', 'בשעה 14:30', 'at 9', '09:00' — the same shapes main.py's wake parser
# handles. No \b anywhere near the Hebrew: it does not match Hebrew letters, and
# that is how an earlier number parser quietly became dead code.
_EXPLICIT_TIME = re.compile(r"(\d{1,2}):(\d{2})")
_BARE_TIME = re.compile(r"(?:\bat\b|בשעה|ב-|ב(?=\d))\s*(\d{1,2})(?!\d|:)", re.IGNORECASE)
_EVENING = re.compile(r"\bpm\b|tonight|evening|בערב|בלילה", re.IGNORECASE)
_MORNING = re.compile(r"\bam\b|morning|בבוקר", re.IGNORECASE)


def parse_clock_time(text: str) -> Optional[str]:
    """The clock time stated in `text` as HH:MM, or None. Hebrew and English."""
    text = text or ""
    explicit = _EXPLICIT_TIME.search(text)
    bare = _BARE_TIME.search(text)
    if explicit and (not bare or explicit.start() <= bare.start()):
        hour, minute = int(explicit.group(1)), int(explicit.group(2))
        return f"{hour:02d}:{minute:02d}" if hour <= 23 and minute <= 59 else None
    if not bare:
        return None
    hour = int(bare.group(1))
    if hour > 23:
        return None
    if hour < 12 and _EVENING.search(text) and not _MORNING.search(text):
        hour += 12
    return f"{hour:02d}:00"


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _client


def _resolve_date(expression: Optional[str], text: str, today: _date) -> str:
    """The task's real date: the model's own words first, then the sentence
    itself, then today. tz.resolve_date is the single parser — the same one
    main.py uses to overrule a hallucinated date, so the two cannot disagree."""
    for candidate in (expression, text):
        if not candidate:
            continue
        match = _tz.REL_DATE_RE.search(str(candidate))
        source = match.group(0) if match else (candidate if candidate is expression else None)
        if not source:
            continue
        resolved = _tz.resolve_date(source, today)
        if resolved:
            return resolved.isoformat()
    return today.isoformat()



# Hebrew marks place with the prefix ב ("in/at"), and marks the clock with the
# SAME letter — "בנהריה" is a town, "ב10" and "בבוקר" are a time. Extraction
# lived only in the model, so whenever the model step failed (no key, a
# timeout, a refusal) every task came back with location None and the whole
# sentence as its title. "מחר לחתום אבטלה בנהריה ב10 בבוקר" produced a task in
# no place at all.
_TIME_WORDS_HE = (
    "בוקר", "צהריים", "צהריהם", "ערב", "לילה", "שעה", "חצות", "דקות", "שעות",
)
# ב + at least two Hebrew letters, optionally hyphenated, not a time word.
_PLACE_HE = re.compile(r"\bב-?([\u0590-\u05FF]{2,}(?:\s+[\u0590-\u05FF]{2,}){0,2})")
_PLACE_EN = re.compile(r"\b(?:in|at)\s+([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*){0,2})")


def extract_place(text: str) -> Optional[str]:
    """The place named in a sentence, or None. Deterministic; no model."""
    if not text:
        return None
    for match in _PLACE_HE.finditer(text):
        candidate = match.group(1).strip()
        head = candidate.split()[0]
        if head in _TIME_WORDS_HE:
            continue
        # "בבוקר" splits to "בוקר" after the prefix; also skip bare weekdays.
        if head in ("יום", "ימים"):
            continue
        return candidate
    match = _PLACE_EN.search(text)
    return match.group(1).strip() if match else None


def strip_place(text: str, place: Optional[str]) -> str:
    """Remove the place phrase from a title once it has its own field."""
    if not text or not place:
        return text
    cleaned = re.sub(r"\bב-?" + re.escape(place), " ", text)
    cleaned = re.sub(r"\b(?:in|at)\s+" + re.escape(place), " ", cleaned, flags=re.IGNORECASE)
    return re.sub(r"\s{2,}", " ", cleaned).strip(" ,.-") or text


# Words that say WHEN, not what. Removed from a fallback title once the date
# and clock have been read into their own fields.
_WHEN_PHRASES = re.compile(
    r"\b(?:מחר|מחרתיים|היום|הערב|אתמול|בבוקר|בצהריים|בערב|בלילה)\b"
    r"|\bב-?\d{1,2}(?::\d{2})?\b"
    r"\b|\b(?:tomorrow|today|tonight|this morning|this evening)\b"
    r"|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b",
    re.IGNORECASE,
)


def strip_when(text: str) -> str:
    """Drop date/clock words from a title that already has date + time fields."""
    if not text:
        return text
    cleaned = _WHEN_PHRASES.sub(" ", text)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" ,.-")
    return cleaned or text


def finalize(raw: dict, text: str, today: _date, learned: Optional[dict] = None) -> dict:
    """Turn one model-shaped entry into a real task. Deterministic end to end —
    this function never asks anything, it decides."""
    task_text = str(raw.get("text") or text).strip()
    # When the model gave no cleaned title we are holding the raw sentence, so
    # the when and the where are still inside it: "מחר לחתום אבטלה בנהריה ב10
    # בבוקר" became a task literally called that. Those parts now have their own
    # fields, so take them out of the name — but only when we fell back, never
    # over a title the model wrote.
    # Keep the uncleaned sentence: the date still has to be read OUT of it.
    # Stripping first removed "מחר" before _resolve_date ever saw it, and the
    # task landed on today.
    dated_text = task_text
    if not raw.get("text"):
        task_text = strip_when(strip_place(task_text, extract_place(task_text)))
    labelled = categorize.merge(task_text, {}, learned)
    if day_schedule.is_study({"text": task_text, "category": labelled["category"]}):
        labelled["duration_minutes"] = max(labelled["duration_minutes"],
                                           day_schedule.MIN_STUDY_BLOCK_MINUTES)
    # A stated RANGE ("7pm-8pm") is the user's own number and beats both the
    # category default and the study floor — she said how long it is.
    try:
        stated = int(raw.get("duration_minutes") or 0)
    except (TypeError, ValueError):
        stated = 0
    if stated > 0:
        labelled["duration_minutes"] = stated

    fixed = raw.get("fixed_time")
    fixed = day_schedule.hhmm(fixed) or parse_clock_time(task_text) or parse_clock_time(text)
    recurrence = str(raw.get("recurrence_type") or "").lower()
    return {
        "text": task_text,
        "category": labelled["category"],
        "priority": labelled["priority"],
        "duration_minutes": labelled["duration_minutes"],
        "fixed_time": fixed,
        "date": _resolve_date(raw.get("date_expression"), dated_text or text, today),
        "location": raw.get("location") or extract_place(task_text) or extract_place(text),
        # Recurrence stays the model's call — "every day for 5 days" is ONE task,
        # and the client expands it. Anything unrecognised is simply not recurring.
        "is_recurring": bool(raw.get("is_recurring")) and recurrence in ("daily", "weekly", "monthly"),
        "recurrence_type": recurrence if recurrence in ("daily", "weekly", "monthly") else None,
        "recurrence_days": raw.get("recurrence_days") if isinstance(raw.get("recurrence_days"), int) else None,
    }


async def extract(text: str, today: Optional[_date] = None,
                  learned: Optional[dict] = None,
                  history: Optional[list] = None) -> list[dict]:
    """Tasks found in `text`. Never returns [] for a non-empty message: if the
    model finds nothing, the sentence itself becomes the task, because silently
    dropping what the user just said is the worst outcome available."""
    text = (text or "").strip()
    if not text:
        return []
    today = today or _tz.today_il()

    # The last few turns are context ("actually make it tomorrow"); the prompt
    # says tasks come from the newest message only.
    turns = []
    for turn in (history or [])[-6:]:
        if isinstance(turn, dict) and turn.get("text"):
            role = "user" if turn.get("role") in ("user", "human") else "assistant"
            turns.append({"role": role, "content": str(turn["text"])})

    entries: list[dict] = []
    _model = config.LLM_MODEL_CHEAP or model_router.pick(
        "task_extract", prompt_chars=len(_SYSTEM) + len(text) + sum(len(t["content"]) for t in turns))
    try:
        response = await _get_client().chat.completions.create(
            model=_model,
            messages=[{"role": "system", "content": _SYSTEM}, *turns,
                      {"role": "user", "content": text}],
            temperature=0,
            response_format={"type": "json_object"},
            timeout=20,
        )
        usage = response.usage
        if usage:
            llm_usage.record("task_extract", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, _model)
        payload = json.loads(response.choices[0].message.content or "{}")
        entries = [e for e in (payload.get("tasks") or []) if isinstance(e, dict)]
    except Exception as exc:  # noqa: BLE001 — the fallback below is the point
        logger.warning("task_extract model step failed, using the sentence itself: %s", exc)

    if not entries:
        # Deliberately NOT {"text": text}: an empty entry tells finalize the
        # title is the raw sentence, so it strips the when and the where that
        # now have their own fields. Handing the sentence over as a "title"
        # made it indistinguishable from one the model had actually written.
        entries = [{}]
    return [finalize(entry, text, today, learned) for entry in entries]


if __name__ == "__main__":   # self-check: python server/task_extract.py
    from datetime import date
    today = date(2026, 9, 6)          # a Sunday
    one = finalize({"text": "ראיון עבודה במר גרופ", "date_expression": "מחר",
                    "fixed_time": "13:00"}, "", today)
    assert one["category"] == "interview" and one["priority"] == "must"
    assert one["date"] == "2026-09-07" and one["fixed_time"] == "13:00"
    assert parse_clock_time("תעירי אותי ב-7") == "07:00"
    assert parse_clock_time("פגישה בשעה 14:30") == "14:30"
    assert parse_clock_time("dinner at 8 tonight") == "20:00"
    assert finalize({}, "לקנות חלב", today)["date"] == "2026-09-06"
    print("task_extract self-check OK:", one)
