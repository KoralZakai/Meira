"""day_schedule — lay a day's tasks on a timeline, in plain Python.

This is the port of the app's `src/utils/buildDaySchedule.ts`, and it exists to
end a specific waste: the local code already computed a correct schedule in
about zero milliseconds, and then the server paid for an LLM call to redo the
same sort — slower, occasionally wrong, and clamped by the deterministic result
anyway. Sorting a list is not a language problem. It is a sort.

The rules are the app's rules, kept identical on purpose so that a day built by
the server and a day built on the phone are the SAME day (the divergence
between the two brains is exactly what this consolidation is removing):

- The cursor NEVER starts in the past: it begins at max(wake_time, `now`
  rounded up to the next quarter hour). Building at 12:56 schedules from 13:00.
- `important_only`: only tasks that matter get a slot — a fixed clock time,
  must/have_to priority, a deadline today or tomorrow, or interview/exam/study
  wording. The rest come back untouched, still in the list, just unscheduled.
- Sort by priority tier, then by leave-home time / fixed time / scheduled time.
- Fixed tasks own their clock time; flexible tasks take the running cursor.
- A flexible task's stale slot (already passed) is reassigned; a user-pinned
  time is kept, so blocks stay resizable and survive a rebuild.
- Study/learning/coding tasks get a MINIMUM 3h block.

Task dicts arrive from three places with two naming conventions — the Supabase
rows and the agent tools are snake_case, the app is camelCase — so every field
is read through `_get`, which accepts both. Returning the same dict shape it was
given (plus `scheduled_time`/`scheduledTime`) keeps this usable from either
side without a translation layer nobody would keep in step.

Pure: nothing here does I/O, and the caller persists the result.

Dependencies: stdlib only, plus tz for "today"/"tomorrow". Consumed by
lumi_agent's build_day_schedule tool and by main.py's schedule endpoints.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

import tz as _tz
from datetime import date as _date, timedelta as _timedelta

# Study/learning work is the one category where the honest estimate is always
# wrong in the same direction, so it gets a floor rather than a guess.
STUDY_KEYWORDS = re.compile(
    r"study|learn|code|coding|course|lecture|homework|קורס|ללמוד|שיעור|תרגיל",
    re.IGNORECASE)
STUDY_CATEGORIES = {"course", "class", "aspiration"}
IMPORTANT_KEYWORDS = re.compile(
    r"interview|exam|test|deadline|ראיון|מבחן|בחינה|דדליין|הגשה",
    re.IGNORECASE)

MIN_STUDY_BLOCK_MINUTES = 180
DEFAULT_DURATION_MINUTES = 30

PRIORITY_ORDER = {"must": 0, "have_to": 1, "need_to": 2, "nice_to_do": 3}


def _get(task: dict, *names: str, default: Any = None) -> Any:
    """First present, non-empty value among `names` — snake_case or camelCase."""
    for name in names:
        value = task.get(name)
        if value not in (None, ""):
            return value
    return default


def _hhmm(value: Any) -> Optional[str]:
    """'09:00:00', datetime.time, '9:00' -> '09:00'. None for anything unusable."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    match = re.match(r"^(\d{1,2}):(\d{2})", text)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


#: Public alias — other modules normalise clock strings through this.
hhmm = _hhmm


def time_to_minutes(hhmm: str) -> int:
    hour, minute = hhmm.split(":")[:2]
    return int(hour) * 60 + int(minute)


def minutes_to_time(minutes: int) -> str:
    """Wraps in both directions, like the app's minutesToTime: a 00:40 flight
    needing 105 minutes of runway wants 22:55 the night before, not '-2:-45'."""
    wrapped = (round(minutes) % 1440 + 1440) % 1440
    return f"{wrapped // 60:02d}:{wrapped % 60:02d}"


def add_minutes(hhmm: str, minutes: int) -> str:
    return minutes_to_time(time_to_minutes(hhmm) + minutes)


def round_up_quarter(hhmm: str) -> str:
    """HH:MM rounded UP to the next quarter hour."""
    total = -(-time_to_minutes(hhmm) // 15) * 15
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def duration_of(task: dict) -> int:
    raw = _get(task, "duration_minutes", "durationMinutes", default=DEFAULT_DURATION_MINUTES)
    try:
        minutes = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_DURATION_MINUTES
    return minutes if minutes > 0 else DEFAULT_DURATION_MINUTES


def is_study(task: dict) -> bool:
    category = str(_get(task, "category", default="general"))
    text = str(_get(task, "text", "title", default=""))
    return category in STUDY_CATEGORIES or bool(STUDY_KEYWORDS.search(text))


def enforce_min_block(task: dict) -> dict:
    """Bump study/learning/coding tasks to a 3h minimum block."""
    if not is_study(task):
        return task
    minutes = max(duration_of(task), MIN_STUDY_BLOCK_MINUTES)
    if minutes == duration_of(task):
        return task
    bumped = dict(task)
    key = "durationMinutes" if "durationMinutes" in task else "duration_minutes"
    bumped[key] = minutes
    return bumped


def is_important_today(task: dict, today: Optional[str] = None) -> bool:
    """Does this task deserve a slot on today's timeline?"""
    if _hhmm(_get(task, "fixed_time", "fixedTime")):
        return True
    if _get(task, "priority", default="need_to") in ("must", "have_to"):
        return True
    deadline = str(_get(task, "deadline", default=""))[:10]
    if deadline:
        base = _tz.today_il() if today is None else _date.fromisoformat(today)
        tomorrow = (base + _timedelta(days=1)).isoformat()
        if deadline <= tomorrow:
            return True
    text = str(_get(task, "text", "title", default=""))
    return bool(IMPORTANT_KEYWORDS.search(text) or STUDY_KEYWORDS.search(text))


def sort_key(task: dict) -> str:
    """Leave-home time first — the clock that actually governs the day — then
    the fixed time, then whatever slot the task already holds."""
    location = _get(task, "location", default=None)
    if isinstance(location, dict):
        leave = _hhmm(_get(location, "leaveHomeBy", "leave_home_by"))
        if leave:
            return leave
    return (_hhmm(_get(task, "fixed_time", "fixedTime"))
            or _hhmm(_get(task, "scheduled_time", "scheduledTime"))
            or "23:59")


def sort_tasks(tasks: Iterable[dict]) -> list:
    """Priority tier, then the clock. Stable, so equal tasks keep their order."""
    return sorted(tasks, key=lambda t: (PRIORITY_ORDER.get(_get(t, "priority", default=""), 4),
                                        sort_key(t)))


def build_day_schedule(
    tasks: Iterable[dict],
    wake_time: str = "08:00",
    now: Optional[str] = None,
    important_only: bool = False,
    today: Optional[str] = None,
) -> list:
    """Return the tasks with a `scheduled_time` assigned, timeline tasks first
    in timeline order, skipped (unimportant) tasks after them, untouched."""
    tasks = list(tasks)
    start_at = wake_time
    if now:
        rounded = round_up_quarter(_hhmm(now) or wake_time)
        if rounded > wake_time:
            start_at = rounded

    if important_only:
        pool = [t for t in tasks if is_important_today(t, today)]
        skipped = [t for t in tasks if not is_important_today(t, today)]
    else:
        pool, skipped = tasks, []

    cursor = start_at
    scheduled = []
    for task in sort_tasks(enforce_min_block(t) for t in pool):
        fixed = _hhmm(_get(task, "fixed_time", "fixedTime"))
        if fixed:
            keep = fixed
        else:
            existing = _hhmm(_get(task, "scheduled_time", "scheduledTime"))
            keep = existing if existing and existing >= start_at else None
        start = keep or cursor
        end = add_minutes(start, duration_of(task))
        if end > cursor:
            cursor = end
        placed = dict(task)
        placed["scheduled_time"] = start
        if "scheduledTime" in task or "durationMinutes" in task:
            placed["scheduledTime"] = start   # camelCase caller gets its own key
        scheduled.append(placed)

    return scheduled + skipped


if __name__ == "__main__":   # self-check: python server/day_schedule.py
    day = build_day_schedule(
        [
            {"text": "gym", "category": "gym", "duration_minutes": 60, "priority": "must"},
            {"text": "interview", "category": "interview", "fixed_time": "10:00", "priority": "must"},
            {"text": "study PPO", "category": "course", "duration_minutes": 30, "priority": "have_to"},
            {"text": "water the plants", "priority": "nice_to_do"},
        ],
        "08:00", now="12:56", important_only=True)
    by_text = {t["text"]: t for t in day}
    assert by_text["study PPO"]["duration_minutes"] >= 180, "3h study minimum"
    assert by_text["interview"]["scheduled_time"] == "10:00", "fixed task keeps its time"
    assert by_text["gym"]["scheduled_time"] >= "13:00", "cursor starts from now"
    assert "scheduled_time" not in by_text["water the plants"], "unimportant left alone"
    print("day_schedule self-check OK:",
          [f"{t.get('scheduled_time', '—')} {t['text']}" for t in day])
