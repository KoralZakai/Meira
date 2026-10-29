"""routine_text — "יש לי יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי".

21.10, Koral said that sentence into Tell Meira several times, pressed save, and nothing
took: routine_match._when only knew "20:30" and "20:30-21:30", so a routine said the way
people say it had NO hour and nothing to draw on a day; and a second day with its own
hours has no home in one {what, days, time} routine. The model's reading of "8 בערב" was
08:00-09:30 and it borrowed another line's days.

This reads the words, in code:

    read_hours(clause)        "ב 8 בערב שעה וחצי" → 20:00-21:30; "11 עד 12 וחצי" → 11:00-12:30
    routines_from_text(text)  one routine per day-clause, each with its own days and hours
    canonical_lines(text)     'יוגה · יום שלישי · 20:00-21:30'  (what routine_match and the
                              phone's parser already read)

Pure; tests/test_routine_text.py.
"""
from __future__ import annotations

import re
from typing import Optional

_PM = re.compile(r"בערב|בלילה|אחה[\"״']?צ|אחר הצהריים|אחרי הצהריים|בצהריים|(?<![a-z])pm\b|evening|night", re.I)
_AM = re.compile(r"בבוקר|(?<![a-z])am\b|morning", re.I)

_HALF = r"(?:\s*ו?(?P<{p}half>חצי)|\s*ו?(?P<{p}quarter>רבע))?"
_NUM = r"(\d{1,2})(?:[:.](\d{2}))?"
# "11 עד 12 וחצי", "משעה 11 עד 12:30", "11-12:30"
_RANGE = re.compile(
    r"(?:משעה|מ-?|מהשעה|from)?\s*" + _NUM + r"\s*(?:עד|עד השעה|-|–|to|until|till)\s*" + _NUM
    + r"(?:\s*ו?(חצי)|\s*ו?(רבע))?", re.I)
# "ב 8", "ב-8:30", "בשעה 20", "at 8"; the number must follow an hour marker, never a date
_SINGLE = re.compile(r"(?:\bב-?\s*|בשעה\s*|\bat\s+)" + _NUM + r"(?:\s*ו?(חצי)|\s*ו?(רבע))?", re.I)
_DURATION = re.compile(
    r"שעה וחצי|שעתיים|שעה ורבע|(?<![֐-׿\d])שעה(?![֐-׿])|"
    r"hour and a half|two hours|an hour|(\d{1,3})\s*דקות", re.I)
_DUR_MIN = {"שעה וחצי": 90, "שעתיים": 120, "שעה ורבע": 75, "שעה": 60,
            "hour and a half": 90, "two hours": 120, "an hour": 60}


def _hhmm(h: int, m: int) -> str:
    return f"{h % 24:02d}:{m:02d}"


def _clock(h: str, m: Optional[str], half: Optional[str], quarter: Optional[str]) -> tuple:
    hh = int(h)
    mm = int(m) if m else 0
    if half:
        mm = 30
    elif quarter:
        mm = 15
    return hh, mm


def read_hours(clause: str) -> dict:
    """{time, end, minutes} from how the hours were SAID, or {}."""
    text = str(clause or "")
    pm, am = bool(_PM.search(text)), bool(_AM.search(text))

    def to24(h: int) -> int:
        if pm and h < 12:
            return h + 12
        if am and h == 12:
            return h          # "12 בבוקר" is noon-ish for a class; leave it
        return h

    m = _RANGE.search(text)
    if m and not re.search(r"\d{1,2}[./]\d{1,2}[./]\d", text[max(0, m.start() - 1):m.end() + 3]):
        sh, sm = _clock(m.group(1), m.group(2), None, None)
        eh, em = _clock(m.group(3), m.group(4), m.group(5), m.group(6))
        if 0 <= sh <= 24 and 0 <= eh <= 24 and sh != eh:
            sh, eh = to24(sh), to24(eh)
            if eh <= sh and eh < 12:
                eh += 12
            minutes = (eh * 60 + em) - (sh * 60 + sm)
            if 15 <= minutes <= 12 * 60:
                return {"time": _hhmm(sh, sm), "end": _hhmm(eh, em), "minutes": minutes}
    s = _SINGLE.search(text)
    # "21.10" after ב is a DATE (day.month), not 21:10, unless an hour marker says otherwise.
    if s and re.search(r"\d{1,2}\.\d{2}", s.group(0)) and int(s.group(2) or 99) <= 12 \
            and not re.search(r"בשעה|\bat\b", s.group(0), re.I):
        s = None
    if s:
        d = _DURATION.search(text[s.end():])
        # "8 בערב שעה וחצי" — the half belongs to the DURATION, not to the 8
        half, quarter = (None, None) if d else (s.group(3), s.group(4))
        sh, sm = _clock(s.group(1), s.group(2), half, quarter)
        if 0 <= sh <= 23:
            sh = to24(sh)
            out = {"time": _hhmm(sh, sm)}
            if d:
                minutes = _DUR_MIN.get(d.group(0).lower()) or (int(d.group(1)) if d.group(1) else None)
                if minutes:
                    end = sh * 60 + sm + minutes
                    out.update({"end": _hhmm(end // 60, end % 60), "minutes": minutes})
            return out
    return {}


# ── clauses: each day with its own hours ─────────────────────────────────────

def _day_hits(text: str) -> list:
    """[(start, day_index)] for each day word — 0=Sunday … 6=Saturday, routine_match's convention."""
    import routine_match
    hits = []
    for i, rx in enumerate(routine_match._HE_DAY_RES):
        for m in rx.finditer(text):
            hits.append((m.start(), i))
    for i, rx in enumerate(routine_match._EN_DAY_RES):
        for m in rx.finditer(text):
            hits.append((m.start(), i))
    return sorted(set(hits))


_LEAD = re.compile(r"^\s*(?:יש לי|אני (?:עושה|הולכת|מתאמנת|הולך|מתאמן)|i have|i do)\s+", re.I)


def _activity(text: str) -> Optional[str]:
    import routine_match
    for kind, rx in routine_match._NAMED_FITNESS:
        m = rx.search(text)
        if m:
            return m.group(0)
    m = re.search(r"(חוג|שיעור)\s+([֐-׿A-Za-z]+)", text)
    if m:
        return m.group(2) if m.group(2) not in ("ב", "ביום") else m.group(1)
    if re.search(r"אימון|workout|training", text, re.I):
        return "אימון"
    return None


def routines_from_text(text: str) -> list:
    """[{what, days, time, end, minutes}] — one per day-clause that carries its own hours.
    A clause with days and no hours is returned without hours (partial, never guessed)."""
    import routine_match
    body = _LEAD.sub("", str(text or ""))
    what = _activity(body)
    if not what:
        return []
    hits = _day_hits(body)
    if not hits:
        return []
    # A clause runs from its day word to the next DIFFERENT clause's day word; days joined by
    # "ו" with no hours between them ("בשלישי ובחמישי ב-8") share the hours that follow.
    cuts = [h[0] for h in hits]
    segments, groups = [], []
    for idx, (pos, day) in enumerate(hits):
        end = cuts[idx + 1] if idx + 1 < len(hits) else len(body)
        seg = body[pos:end]
        groups.append((day, seg))
    out, pending = [], []
    for day, seg in groups:
        hours = read_hours(seg)
        pending.append(day)
        if hours:
            out.append({"what": what, "days": sorted(set(pending)), **hours})
            pending = []
    if pending and not out:
        out.append({"what": what, "days": sorted(set(pending))})
    elif pending:
        out.append({"what": what, "days": sorted(set(pending))})
    return out


_DAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]


def _days_he(days: list) -> str:
    if len(days) == 1:
        return f"יום {_DAY_HE[days[0]]}"
    return "ימי " + " ו".join(_DAY_HE[d] for d in days) if len(days) > 1 else ""


def canonical_line(r: dict) -> str:
    when = f"{r['time']}-{r['end']}" if r.get("end") else r.get("time")
    return " · ".join(str(p) for p in (r.get("what"), _days_he(r.get("days") or []), when) if p)


def canonical_lines(text: str) -> list:
    return [canonical_line(r) for r in routines_from_text(text)]
