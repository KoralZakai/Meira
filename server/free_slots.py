"""Free windows across a RANGE of days, with the weight of what is around them.

"When can I host at home?" / "מתי יש לי זמן להיפגש עם דנה?" is not a question
about one date, and a gap in the calendar is not automatically a good time: the
evening BEFORE a job interview is for preparing and sleeping, and the morning of
one is for the interview. Pure code, no model call — check_availability answers
"does THIS fit"; this answers "WHEN".
"""
from __future__ import annotations

import re
from datetime import date as _date, timedelta
from typing import Optional

_HEAVY_RE = re.compile(r"interview|ראיון|ראיונות|אינטרוויו|exam|מבחן|בחינה|flight|טיסה", re.IGNORECASE)
EVE_FROM = 17 * 60          # the evening before a heavy day is off limits from here
PREP_BEFORE = 90            # and so is the run-up to it on the day itself
MIN_WINDOW = 30


def _mins(hhmm: str) -> int:
    h, m = str(hhmm)[:5].split(":")
    return int(h) * 60 + int(m)


def _hhmm(total: int) -> str:
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def is_heavy(row: dict) -> bool:
    return (str(row.get("category") or "").lower() == "interview"
            or bool(_HEAVY_RE.search(str(row.get("text") or ""))))


def _start_of(row: dict) -> str:
    s = (row.get("fixed_time") or row.get("scheduled_time") or "")[:5]
    return s if ":" in s else ""


_DAYS_HE = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]   # date.weekday() order
_OFF_WORDS = {
    4: re.compile(r"שישי|friday|\bfri\b", re.IGNORECASE),
    5: re.compile(r"שבת|saturday|\bsat\b", re.IGNORECASE),
    6: re.compile(r"ראשון|sunday|\bsun\b", re.IGNORECASE),
    0: re.compile(r"שני|monday|\bmon\b", re.IGNORECASE),
    1: re.compile(r"שלישי|tuesday|\btue\b", re.IGNORECASE),
    2: re.compile(r"רביעי|wednesday|\bwed\b", re.IGNORECASE),
    3: re.compile(r"חמישי|thursday|\bthu\b", re.IGNORECASE),
}
_OFF_LINE = re.compile(r"חופש|days? off|day off|off\b", re.IGNORECASE)


def days_off(notes: Optional[str]) -> set:
    """Weekdays (date.weekday(): Mon=0 … Sun=6) she named as days off, from her routine lines."""
    out: set = set()
    for line in str(notes or "").splitlines():
        if _OFF_LINE.search(line):
            out |= {wd for wd, rx in _OFF_WORDS.items() if rx.search(line)}
    return out


def find(rows: list, date_from: str, date_to: str, minutes: int, *,
         day_start: str = "08:00", day_end: str = "22:00",
         now_date: Optional[str] = None, now_hhmm: Optional[str] = None,
         buffer: int = 15, limit: int = 8, off_days: Optional[set] = None) -> dict:
    """{slots, ruled_out, heavy, days}. `days` has ONE entry per day of the range — weekday
    name, windows (empty list = nothing long enough, with why), day_off, day_empty — days
    off first, so an answer built from it cannot leave a day out."""
    rows = [r for r in rows if r.get("status") not in ("complete", "moved")]
    by_day: dict[str, list] = {}
    for r in rows:
        by_day.setdefault(str(r.get("date") or ""), []).append(r)

    d0, d1 = _date.fromisoformat(date_from), _date.fromisoformat(date_to)
    heavy_days = {d for d, rs in by_day.items() if any(is_heavy(r) and _start_of(r) for r in rs)}
    heavy = [{"date": d, "text": r.get("text"), "start": _start_of(r)}
             for d in sorted(heavy_days) for r in by_day[d] if is_heavy(r) and _start_of(r)]

    slots, ruled_out = [], []
    d = d0
    while d <= d1:
        iso = d.isoformat()
        if now_date and iso < now_date:
            d += timedelta(days=1)
            continue
        busy = []                      # (start, end) in minutes
        for r in by_day.get(iso, []):
            s = _start_of(r)
            if s:
                st = _mins(s)
                busy.append((st - buffer, st + int(r.get("duration_minutes") or 30) + buffer))
                if is_heavy(r):
                    busy.append((st - PREP_BEFORE, st))
        lo, hi = _mins(day_start), _mins(day_end)
        notes = []
        eve = (d + timedelta(days=1)).isoformat() in heavy_days
        if eve:
            hi = min(hi, EVE_FROM)
            nxt = next(h for h in heavy if h["date"] == (d + timedelta(days=1)).isoformat())
            notes.append(f"evening kept clear: {nxt['text']} tomorrow {nxt['start']}")
            ruled_out.append({"date": iso, "after": _hhmm(EVE_FROM),
                              "reason": f"evening before {nxt['text']} ({nxt['start']})"})
        if now_date == iso and now_hhmm:
            lo = max(lo, -(-_mins(now_hhmm) // 5) * 5)
        cursor = lo
        for st, en in sorted(busy):
            if st - cursor >= max(minutes, MIN_WINDOW):
                slots.append({"date": iso, "start": _hhmm(cursor), "end": _hhmm(min(st, hi)),
                              **({"note": "; ".join(notes)} if notes else {})})
            cursor = max(cursor, en)
        if hi - cursor >= max(minutes, MIN_WINDOW):
            slots.append({"date": iso, "start": _hhmm(cursor), "end": _hhmm(hi),
                          **({"note": "; ".join(notes)} if notes else {})})
        d += timedelta(days=1)
    for sl in slots:
        # A day with nothing in it is the strongest answer to "when am I free".
        if not [r for r in by_day.get(sl["date"], []) if _start_of(r)]:
            sl["day_empty"] = True
    slots = [s for s in slots if _mins(s["end"]) - _mins(s["start"]) >= minutes]
    days, d = [], d0
    while d <= d1:
        iso = d.isoformat()
        if not (now_date and iso < now_date):
            wins = [f'{s["start"]}-{s["end"]}' for s in slots if s["date"] == iso]
            timed = [r for r in by_day.get(iso, []) if _start_of(r)]
            entry = {"date": iso, "weekday": "יום " + _DAYS_HE[d.weekday()], "windows": wins,
                     "day_off": d.weekday() in (off_days or ()), "day_empty": not timed}
            if not wins:
                why = [r.get("text") for r in timed][:3]
                ro = next((r["reason"] for r in ruled_out if r["date"] == iso), None)
                entry["why_not"] = ro or (f"busy: {', '.join(map(str, why))}" if why
                                          else f"no {minutes}-minute window left")
            days.append(entry)
        d += timedelta(days=1)
    days.sort(key=lambda e: (not e["day_off"], e["date"]))
    return {"slots": slots[:limit], "ruled_out": ruled_out, "heavy": heavy, "days": days}
