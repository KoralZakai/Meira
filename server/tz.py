"""Israel local time — the whole app is Israel-only (geo.py biases geocoding to
region 'il'), but the server container runs UTC (no TZ set in the Dockerfile).
Every plan HH:MM (leaveHomeBy/wakeUpBy/arriveBy) is Israel wall-clock; anything
that schedules or fires against those times must use IL-aware datetimes, not
naive datetime.now()/date.today() (which silently mean UTC and used to fire
reminders ~2-3h late depending on DST).

Dependencies: stdlib zoneinfo + the `tzdata` package (requirements.txt) since
python:3.11-slim doesn't ship the IANA tz database. Consumed by reminders.py,
geo.py, lumi_agent.py, main.py.
"""
import re
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

IL = ZoneInfo("Asia/Jerusalem")


def now_il() -> datetime:
    return datetime.now(IL)


def today_il() -> date:
    return now_il().date()


# Relative-date vocabulary, Hebrew + English. Longest form FIRST in the regex
# ('מחרתיים' before 'מחר') — alternation is leftmost-first at each position.
_DAYS_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_DAYS_HE = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]  # Monday-based

REL_DATE_RE = re.compile(
    r"מחרתיים|מחר|היום|שבוע הבא|בעוד שבוע|בעוד יומיים|בעוד \d+ ימים"
    r"|day after tomorrow|next week|in a week|in \d+ days?|\btoday\b|\btomorrow\b"
    r"|יום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)"
    r"|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b"
    r"|\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b",
    re.IGNORECASE)


def resolve_date(expression: str, today: Optional[date] = None) -> Optional[date]:
    """Relative date expression -> exact calendar date, Israel time. None if
    unparseable.

    Single source of truth for date arithmetic: the LLM's calculate_date tool
    and main.py's task-save override both call this, so a task can never be
    stored on a date the model invented (it wrote '24.7' for the day after
    26.7 and the task landed in the past, invisible to every date>=today path).
    """
    today = today or today_il()
    expr = (expression or "").strip().lower()

    add: Optional[int] = None
    if "מחרתיים" in expr or "day after tomorrow" in expr:
        add = 2
    elif "בעוד יומיים" in expr:
        add = 2
    elif "מחר" in expr or re.search(r"\btomorrow\b", expr):
        add = 1
    elif "היום" in expr or re.search(r"\btoday\b", expr):
        add = 0
    elif "שבוע הבא" in expr or "בעוד שבוע" in expr or "next week" in expr or "in a week" in expr:
        add = 7
    if add is None:
        m = re.search(r"in (\d+) days?", expr) or re.search(r"בעוד (\d+) ימים", expr)
        if m:
            add = int(m.group(1))
    if add is not None:
        return today + timedelta(days=add)

    # Explicit day.month ("21.7", "21/7/26") — next occurrence unless a year is given.
    m = re.search(r"\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b", expr)
    if m:
        day_n, month_n = int(m.group(1)), int(m.group(2))
        year_n = int(m.group(3)) if m.group(3) else today.year
        if year_n < 100:
            year_n += 2000
        try:
            target = today.replace(year=year_n, month=month_n, day=day_n)
        except ValueError:
            return None
        if target < today and not m.group(3):
            target = target.replace(year=year_n + 1)
        return target

    # Weekday name → next occurrence (never today).
    for names in (_DAYS_EN, _DAYS_HE):
        for i, name in enumerate(names):
            if name in expr:
                return today + timedelta(days=((i - today.weekday()) % 7) or 7)
    return None


def weekday_label(target: date) -> str:
    """'Monday / יום שני' — the bilingual confirmation label."""
    return f"{_DAYS_EN[target.weekday()].capitalize()} / יום {_DAYS_HE[target.weekday()]}"
