"""day_slots — free time in one day, for a task that has a day and no hour.

27.10, Koral: "משימות ליום שלישי בבוקר: …" was saved "to your general tasks"
with no hour, and a second one "not saved" — she could not tell whether it was
saved or when. A day with no hour is half a plan. When she names the day (and
maybe a part of it) Meira places each task in that day's free time and SAYS
the hour; she can move it with one word.

Pure arithmetic over the day's timed tasks — no model, no I/O.
Consumed by agent_turn.act_on_understanding and agent_turn.when_answer.
"""
from __future__ import annotations

from typing import Iterable, Optional

import day_schedule

DEFAULT_WINDOW = ("09:00", "21:00")
GAP_MINUTES = 10      # breathing room between two things (CLAUDE.md: 10 min buffer)
STEP_MINUTES = 15


def _m(hhmm: Optional[str]) -> Optional[int]:
    h = day_schedule.hhmm(hhmm)
    return int(h[:2]) * 60 + int(h[3:]) if h else None


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def busy_of(tasks: Iterable[dict], date_iso: str) -> list:
    """[(start, end)] in minutes for that date's timed, open tasks."""
    out = []
    for t in tasks or []:
        if str(t.get("date") or "")[:10] != date_iso:
            continue
        if str(t.get("status") or "pending") in ("complete", "done", "cancelled", "missed"):
            continue
        start = _m(t.get("fixed_time") or t.get("fixedTime") or t.get("scheduled_time"))
        if start is None:
            continue
        dur = t.get("duration_minutes") or t.get("durationMinutes") or 30
        try:
            dur = max(5, int(dur))
        except (TypeError, ValueError):
            dur = 30
        out.append((start, start + dur))
    return sorted(out)


def first_free(busy: list, minutes: int, window: tuple = DEFAULT_WINDOW,
               not_before: Optional[int] = None) -> Optional[str]:
    """The earliest HH:MM in `window` where `minutes` fit clear of `busy`
    (with GAP_MINUTES either side), or None when the window is full."""
    lo, hi = _m(window[0]) or 0, _m(window[1]) or 24 * 60
    if not_before is not None:
        lo = max(lo, -(-not_before // STEP_MINUTES) * STEP_MINUTES)
    start = lo
    while start + minutes <= hi:
        end = start + minutes
        clash = next((b for b in busy if start < b[1] + GAP_MINUTES and b[0] < end + GAP_MINUTES), None)
        if not clash:
            return _hhmm(start)
        start = max(start + STEP_MINUTES,
                    -(-(clash[1] + GAP_MINUTES) // STEP_MINUTES) * STEP_MINUTES)
    return None


def place(tasks: list, day: list, windows: dict, now_minutes: Optional[int] = None,
          today_iso: Optional[str] = None) -> list:
    """Give each dated, hour-less task an hour in its day's free time.

    `windows` maps a part_of_day to (start, end). A task whose window is full
    keeps no hour — the reply then says so, it is never squeezed on top of
    something. Tasks placed here count as busy for the next one, so a list of
    three lands as three consecutive slots, not three on the same minute."""
    placed = []
    busy_by_date: dict = {}
    for task in tasks:
        date_iso = str(task.get("date") or "")[:10]
        if not date_iso or task.get("fixed_time"):
            placed.append(task)
            continue
        busy = busy_by_date.setdefault(date_iso, busy_of(day, date_iso))
        window = windows.get(task.get("part_of_day")) or DEFAULT_WINDOW
        minutes = int(task.get("duration_minutes") or 30)
        not_before = now_minutes + 15 if (now_minutes is not None and date_iso == today_iso) else None
        hour = first_free(busy, minutes, window, not_before)
        if hour is None and task.get("part_of_day"):
            # Her morning is full: the day still has room, and saying "11:30
            # instead" beats an hour-less task.
            hour = first_free(busy, minutes, DEFAULT_WINDOW, not_before)
        if hour is None:
            placed.append(task)
            continue
        start = _m(hour)
        busy.append((start, start + minutes))
        busy.sort()
        placed.append({**task, "fixed_time": hour, "placed_by": "meira"})
    return placed
