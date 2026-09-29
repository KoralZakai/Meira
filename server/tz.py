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
import logging
import re
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

IL = ZoneInfo("Asia/Jerusalem")


def now_il() -> datetime:
    return datetime.now(IL)


def today_il() -> date:
    return now_il().date()


# Relative-date vocabulary, Hebrew + English. Longest form FIRST in the regex
# ('מחרתיים' before 'מחר') — alternation is leftmost-first at each position.
_DAYS_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_DAYS_HE = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]  # Monday-based

# Month names, because "ב 8 באוקטובר" is how a date is SAID. Only "8.10" and
# "8/10" were understood, so "מילואים ב 8 באוקטובר" had no date at all — and its
# "ב 8" was read as eight o'clock instead (task_extract._BARE_TIME).
MONTHS_HE = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט",
             "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]
MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august",
             "september", "october", "november", "december"]
_MONTH_HE_ALT = "|".join(MONTHS_HE + ["מרס"])
_MONTH_EN_ALT = ("january|february|march|april|may|june|july|august|september|october"
                 "|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec")
# "8 באוקטובר" / "8 לאוקטובר" / "8 October" / "October 8th" / "8th of October".
# Written once with {d}/{m} slots: filled with capturing groups for
# resolve_date, and with non-capturing ones for REL_DATE_RE — callers run
# re.findall on that, which returns GROUPS when a pattern has any.
_DAY_MONTH_HE_T = r"{d}\s*(?:ב|ל)?-?\s*{mh}(?![֐-׿])"
_DAY_MONTH_EN_T = r"\b{d}(?:st|nd|rd|th)?\s+(?:of\s+)?{me}\b"
_MONTH_DAY_EN_T = r"\b{me}\s+{d}(?:st|nd|rd|th)?\b"


def _fill(template: str, capture: bool) -> str:
    wrap = "({})" if capture else "(?:{})"
    return template.format(d=wrap.format(r"\d{1,2}"), mh=wrap.format(_MONTH_HE_ALT),
                           me=wrap.format(_MONTH_EN_ALT))


_DAY_MONTH_HE = _fill(_DAY_MONTH_HE_T, True)
_DAY_MONTH_EN = _fill(_DAY_MONTH_EN_T, True)
_MONTH_DAY_EN = _fill(_MONTH_DAY_EN_T, True)
# What follows a number that makes it a DAY, not an hour ("8 באוקטובר").
MONTH_WORD_AFTER = (rf"\s*(?:ב|ל)?-?\s*(?:{_MONTH_HE_ALT})(?![֐-׿])"
                    rf"|(?:st|nd|rd|th)?\s+(?:of\s+)?(?:{_MONTH_EN_ALT})\b")

REL_DATE_RE = re.compile(
    r"מחרתיים|מחר|היום|שבוע הבא|בעוד שבוע|בעוד יומיים|בעוד \d+ ימים"
    r"|day after tomorrow|next week|in a week|in \d+ days?|\btoday\b|\btomorrow\b"
    r"|יום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)"
    r"|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b"
    # (?<!\d), not \b: ב is a word letter, so "ב8/10" had no boundary before
    # the 8 and the date she typed was invisible.
    r"|(?<![\d./])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\d])"
    + "|" + "|".join(_fill(t, False) for t in (_DAY_MONTH_HE_T, _DAY_MONTH_EN_T, _MONTH_DAY_EN_T)),
    re.IGNORECASE)
assert REL_DATE_RE.groups == 0, "REL_DATE_RE must stay group-free for re.findall callers"


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
    m = re.search(r"(?<![\d./])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)", expr)
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

    # "8 באוקטובר" / "October 8" — next occurrence of that day.
    day_n = month_n = None
    m = re.search(_DAY_MONTH_HE, expr)
    if m:
        name = "מרץ" if m.group(2) == "מרס" else m.group(2)
        day_n, month_n = int(m.group(1)), MONTHS_HE.index(name) + 1
    else:
        m = re.search(_DAY_MONTH_EN, expr) or re.search(_MONTH_DAY_EN, expr)
        if m:
            day_s, name = (m.group(1), m.group(2)) if m.group(1).isdigit() else (m.group(2), m.group(1))
            month_n = next(i + 1 for i, full in enumerate(MONTHS_EN) if full.startswith(name[:3]))
            day_n = int(day_s)
    if day_n and month_n:
        if day_n > 31 and day_n % 10 == 0:
            # "ב-80 באוקטובר": Whisper glued a zero onto "8" (28.9, reserve
            # duty lost). There is no 80th; the day she said is the 8th.
            logger.warning("day %s of month %s read as %s", day_n, month_n, day_n // 10)
            day_n //= 10
        try:
            target = today.replace(month=month_n, day=day_n)
        except ValueError:
            return None
        return target if target >= today else target.replace(year=today.year + 1)

    # Weekday name → next occurrence (never today).
    for names in (_DAYS_EN, _DAYS_HE):
        for i, name in enumerate(names):
            if name in expr:
                return today + timedelta(days=((i - today.weekday()) % 7) or 7)
    return None


def weekday_label(target: date) -> str:
    """'Monday / יום שני' — the bilingual confirmation label."""
    return f"{_DAYS_EN[target.weekday()].capitalize()} / יום {_DAYS_HE[target.weekday()]}"


def epoch_il(date_iso: str, hhmm: str) -> Optional[int]:
    """A local date + HH:MM → a Unix timestamp, in Israel time.

    Google's `arrival_time` is an absolute instant. Building it from a naive
    datetime uses the SERVER's zone, and the server is in whatever region Fly
    scheduled it — so a 14:30 interview in Ra'anana became 14:30 UTC, three
    hours out, and the route came back for the wrong part of the timetable.
    Israel also moves its clocks, which a fixed +2/+3 offset gets wrong twice a
    year. ZoneInfo knows; arithmetic does not.

    None when either part does not parse — the caller must say so rather than
    silently routing for "now".
    """
    try:
        y, m, d = (int(p) for p in str(date_iso)[:10].split("-"))
        hh, mm = (int(p) for p in str(hhmm).strip()[:5].split(":"))
        return int(datetime(y, m, d, hh, mm, tzinfo=IL).timestamp())
    except (ValueError, TypeError):
        return None
