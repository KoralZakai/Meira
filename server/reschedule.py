"""reschedule — "my interview moved to Tuesday" (18.10, Koral).

She said, by voice: "הראיון שלי מחר ב-Workday נדחה ליום שלישי". The speech-to-text
heard "העיון" and "נתחל"; the agent loop got stuck on it and answered "נתקעתי רגע".
What she wanted was never in doubt: find that appointment, move it, look at the
new day, and — because an interview that moved gives her time — offer to put
study time in the diary and say at what hour to wake her.

So this is code, not a model's mood:

  find_move()     message + her open tasks → {task, new_date, new_time, old_date},
                  or None when it is not clearly a move or the task is ambiguous.
                  Tolerates a mis-heard word: the task is found by its NAMES
                  ("Work Day" is "Workday"), the interview by sound, and the new
                  day by the "to <day>" shape (ליום שלישי / ל-22.10), not by one
                  exact verb.
  reply()         what Meira says: what moved, what it gives her, ONE question.
  parse_answer()  her reply to that question — yes / no / an hour.
  study_slot()    where the study block goes.

Pure but for tz (tests/test_reschedule.py).
"""
from __future__ import annotations

import difflib
import re
from datetime import date, timedelta
from typing import Optional

import tz as _tz

_NIQQUD = re.compile(r"[֑-ׇ]")

_DAYS = {"ראשון": 6, "שני": 0, "שלישי": 1, "רביעי": 2, "חמישי": 3, "שישי": 4, "שבת": 5}
_DAY_ABBR = {"א": "ראשון", "ב": "שני", "ג": "שלישי", "ד": "רביעי", "ה": "חמישי", "ו": "שישי"}
_EN_DAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4,
            "saturday": 5, "sunday": 6}

# "…ל<יום> שלישי", "…למחר", "…ל-22.10", "…to tuesday": where it MOVED TO.
_HE_DAY = "|".join(_DAYS) + "|" + "|".join(f"{a}['׳]" for a in _DAY_ABBR)
_TO_DAY = re.compile(
    rf"(?:^|[\s,.])ל-?(?:יום\s+)?(?P<day>{_HE_DAY})(?![֐-׿])"
    r"|(?:^|[\s,.])(?P<rel>למחר|למחרתיים)(?![֐-׿])"
    r"|(?:^|[\s,.])ל-?(?P<dm>\d{1,2}[./]\d{1,2})(?![\d])"
    r"|\bto\s+(?P<en>monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b",
    re.IGNORECASE)

# Words that say "moved" — a mis-heard one still passes if the "to <day>" shape is there.
_MOVE_VERB = re.compile(
    r"נדח|דחו|דוחים|דחיתי|הוזז|הזיז|מזיזים|העבר|הועבר|מועבר|עבר\s+ל|שונה|שינו|"
    r"postpon|moved|moves|pushed|reschedul|changed\s+to|switched",
    re.IGNORECASE)

_QUESTION = re.compile(r"[?？]\s*$|^(?:מתי|איפה|איך|למה|כמה|when|where|how|why)\b")

_STOP = set("""
של שלי שלך מחר מחרתיים היום אצלי יום ראשון שני שלישי רביעי חמישי שישי שבת עם את אל על כי גם אבל
נדחה נדחתה נדחו הוזז הוזזה הועבר שונה אחרי לפני בעוד ליום
the and for with moved postponed tomorrow today monday tuesday wednesday thursday friday saturday sunday
my meeting event to is was has been now
""".split())

_INTERVIEW_WORDS = ("ראיון", "ריאיון", "interview")


def _clean(s: str) -> str:
    return _NIQQUD.sub("", str(s or "")).lower()


def tokens(s: str) -> set:
    """Distinctive words of a text: Hebrew and Latin runs, prefixes peeled, and
    neighbouring Latin words joined ("work day" → "workday", as the invite spells it)."""
    raw = re.findall(r"[a-z]+|[֐-׿]+|\d+", _clean(s))
    out = set()
    for i, w in enumerate(raw):
        out.add(w)
        if len(w) > 3 and w[0] in "בלהושמכ" and re.match(r"[֐-׿]", w):
            out.add(w[1:])
        if i + 1 < len(raw) and re.match(r"[a-z]", w) and re.match(r"[a-z]", raw[i + 1]):
            out.add(w + raw[i + 1])
    return {t for t in out if len(t) >= 3 and t not in _STOP and not t.isdigit()}


# Real words that SOUND like ראיון and are not one: "תזיזי את האימון" (29.10)
# was read as the interview, and she was offered study time for her workout.
_NOT_INTERVIEW = {"אימון", "האימון", "אימונים", "עיון", "ניון", "אמון"}


def _says_interview(words: set) -> bool:
    """By sound: speech-to-text turns "הראיון" into "העיון". Close enough counts —
    except for the real words in _NOT_INTERVIEW."""
    for w in words:
        if w in _NOT_INTERVIEW:
            continue
        for known in _INTERVIEW_WORDS:
            if w == known or difflib.SequenceMatcher(None, w.lstrip("ה"), known).ratio() >= 0.6:
                return True
    return False


def _day_date(name: str, today: date) -> Optional[date]:
    return _tz.resolve_date(f"יום {name}", today)


def _to_date(m: re.Match, today: date) -> Optional[date]:
    if m.group("day"):
        name = m.group("day")
        if name[-1] in "'׳":
            name = _DAY_ABBR.get(name[0], name)
        return _day_date(name, today)
    if m.group("rel"):
        return _tz.resolve_date(m.group("rel")[1:], today)
    if m.group("dm"):
        return _tz.resolve_date(m.group("dm").replace("/", "."), today)
    if m.group("en"):
        en = m.group("en").lower()
        if en == "tomorrow":
            return today + timedelta(days=1)
        return _tz.resolve_date(f"next {en}", today) or _tz.resolve_date(en, today)
    return None


def _old_date(content: str, today: date) -> Optional[date]:
    """The day it was on, when she says so ("מחר", "ביום שני") — to pick the right task."""
    text = _clean(content)
    if re.search(r"(?<![לב֐-׿])מחר(?!תיים)", text):
        return today + timedelta(days=1)
    if "מחרתיים" in text and "למחרתיים" not in text:
        return today + timedelta(days=2)
    m = re.search(rf"(?:^|\s)ב(?:יום\s+)?(?P<day>{'|'.join(_DAYS)})(?![֐-׿])", text)
    if m:
        return _day_date(m.group("day"), today)
    return None


def _time_after(content: str, pos: int) -> Optional[str]:
    m = re.search(r"(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)", content[pos:])
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    return f"{h:02d}:{mi:02d}" if 0 <= h < 24 and 0 <= mi < 60 else None


def find_move(content: str, tasks: list, today: Optional[date] = None) -> Optional[dict]:
    """{task, new_date, new_time, old_date} when the message clearly moves ONE of her tasks."""
    text = str(content or "").strip()
    today = today or _tz.today_il()
    if not text or _QUESTION.search(text):
        return None
    to = _TO_DAY.search(text)
    if not to:
        return None
    new_date = _to_date(to, today)
    if not new_date or new_date < today:
        return None
    mine = tokens(text)
    interview_said = _says_interview(mine)
    old = _old_date(text, today)

    scored = []
    for t in tasks or []:
        d = str(t.get("date") or "")[:10]
        if not d or d < today.isoformat():
            continue
        theirs = tokens(t.get("text", ""))
        shared = len(mine & theirs)
        is_interview = str(t.get("category") or "") == "interview" or _says_interview(theirs)
        score = shared + (1 if interview_said and is_interview else 0)
        if score < 1:
            continue
        if old and d == old.isoformat():
            score += 2
        scored.append((score, -_days_between(today, d), t))
    if not scored:
        return None
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    # Two tasks tie on every count: asking is better than moving the wrong one.
    if len(scored) > 1 and scored[0][0] == scored[1][0] and scored[0][1] == scored[1][1]:
        return None
    # A bare "to <day>" with no verb and no way to tell which task is no move at all.
    if not _MOVE_VERB.search(_clean(text)) and scored[0][0] < 2:
        return None
    task = scored[0][2]
    if str(task.get("date") or "")[:10] == new_date.isoformat() and not _time_after(text, to.end()):
        return None
    return {"task": task, "new_date": new_date.isoformat(),
            "new_time": _time_after(text, to.end()),
            "old_date": str(task.get("date") or "")[:10]}


def _days_between(today: date, iso: str) -> int:
    try:
        return (date.fromisoformat(iso) - today).days
    except ValueError:
        return 999


# ── what Meira says ──────────────────────────────────────────────────────────

_HE_WEEKDAY = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]
_EN_WEEKDAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def day_label(iso: str, he: bool) -> str:
    d = date.fromisoformat(iso)
    return (f"יום {_HE_WEEKDAY[d.weekday()]} {d.day}.{d.month}" if he
            else f"{_EN_WEEKDAY[d.weekday()]} {d.day}.{d.month}")


def _is_prep_kind(task: dict) -> bool:
    return str(task.get("category") or "") in ("interview", "exam", "class", "course") \
        or _says_interview(tokens(task.get("text", "")))


def _short_title(task: dict, he: bool) -> str:
    text = str(task.get("text") or "")
    if str(task.get("category") or "") == "interview" or _says_interview(tokens(text)):
        m = re.search(r"\bat\s+([A-Z][\w&'\-]*(?:\s+[A-Z][\w&'\-]*)?)", text)
        if m:
            return (f"הראיון ב-{m.group(1)}" if he else f"the {m.group(1)} interview")
        return "הראיון" if he else "the interview"
    return text[:50]


def _rel_day(iso: str, today: date, he: bool) -> str:
    """"today" / "tomorrow" / the dated weekday — a block is never undated (rule 4)."""
    delta = _days_between(today, iso)
    if delta == 0:
        return "היום" if he else "today"
    if delta == 1:
        return "מחר" if he else "tomorrow"
    return ("ב" + day_label(iso, True)) if he else ("on " + day_label(iso, False))


def reply(move: dict, today: date, he: bool, clash_with: Optional[str] = None,
          calendar_owned: bool = False, proposal: Optional[dict] = None) -> tuple:
    """-> (text, offered): what moved, what it gives her, and ONE question.

    With a `proposal` (propose_study) the question NAMES an hour that is free in her
    diary — "yes" is the whole answer. Without one it asks for the hour. It never
    promises a wake-up: nothing booked here wakes her (silent-state rule 3)."""
    task = move["task"]
    when = day_label(move["new_date"], he)
    at = move.get("new_time") or str(task.get("fixed_time") or task.get("fixedTime") or "")[:5]
    title = _short_title(task, he)
    gained = _days_between(date.fromisoformat(move["old_date"]), move["new_date"]) \
        if move.get("old_date") else 0
    prep = _is_prep_kind(task)
    parts = []
    if he:
        parts.append(f"הזזתי את {title} ל{when}{' ב-' + at if at else ''} ✓")
        if prep and gained > 0:
            parts.append("זה נותן לך עוד זמן להתכונן!" if gained > 1 else "זה נותן לך עוד יום להתכונן!")
        if clash_with:
            parts.append(f"שימי לב: באותה שעה יש לך {clash_with}.")
        if calendar_owned:
            parts.append("ביומן של גוגל ההזמנה נשארה על התאריך הקודם.")
        if prep and proposal:
            parts.append(f"ללמוד {_rel_day(proposal['date'], today, True)} ב-{proposal['time']}?")
        elif prep:
            parts.append("לשים לך ביומן זמן לימוד? באיזו שעה?")
    else:
        parts.append(f"I moved {title} to {when}{' at ' + at if at else ''} ✓")
        if prep and gained > 0:
            parts.append("That gives you more time to prepare!" if gained > 1
                         else "That gives you one more day to prepare!")
        if clash_with:
            parts.append(f"Heads up: you have {clash_with} at that time.")
        if calendar_owned:
            parts.append("In Google Calendar the invite still shows the old date.")
        if prep and proposal:
            parts.append(f"Study {_rel_day(proposal['date'], today, False)} at {proposal['time']}?")
        elif prep:
            parts.append("Want study time in your diary? At what time?")
    return " ".join(parts), prep


# ── her answer to the question ───────────────────────────────────────────────

_HE_HOURS = {"אחת": 1, "שתיים": 2, "שתים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6,
             "שבע": 7, "שמונה": 8, "תשע": 9, "עשר": 10, "אחת עשרה": 11, "שתים עשרה": 12}
_YES = re.compile(r"^(?:כן|בטח|ברור|יאללה|סבבה|אוקיי?|אוקי|טוב|מעולה|yes|yeah|yep|sure|ok(?:ay)?)\b", re.I)
_NO = re.compile(r"^(?:לא\b|אין צורך|לא צריך|no\b|nope|not now)", re.I)
_LATER = re.compile(r"^(?:אחר כך|אחרכך|אחר־כך|בהמשך|עוד מעט|later|in a bit)", re.I)
_OTHER = re.compile(r"שעה אחרת|זמן אחר|אחרת|another (?:time|hour)|different (?:time|hour)|other time", re.I)
_MORNING = re.compile(r"בבוקר|בבקר|בוקר|\bam\b|morning", re.I)
_AFTERNOON = re.compile(r"אחר הצהריים|אחרי הצהריים|אחה'צ|צהריים|afternoon", re.I)
_EVENING = re.compile(r"בערב|הערב|ערב|בלילה|\bpm\b|evening|tonight", re.I)


def normalize_level(level) -> str:
    """How pushy Meira is about a study block: 'alarm' (one plain reminder), 'gentle' (default,
    a heads-up and the reminder), 'motivating' (cheer, reminder, check-in). Anything else is gentle."""
    lv = str(level or "").strip().lower()
    return lv if lv in ("alarm", "gentle", "motivating") else "gentle"


def parse_answer(content: str, prefer: Optional[str] = None) -> dict:
    """{answer: 'yes'|'no'|'later'|'other'|'daypart'|'time'|None, time, part?} — her reply to an offer.

    `prefer` ('evening' | 'morning') says what an unmarked "8" means for the block on offer:
    an evening study block is 20:00, a morning wake-up is 08:00. A word she says ("בבוקר",
    "pm") always wins over the guess."""
    text = _clean(content).replace("״", "'").replace('"', "'").strip()
    if not text:
        return {"answer": None, "time": None}
    if _NO.search(text):
        return {"answer": "no", "time": None}
    if _LATER.search(text):
        return {"answer": "later", "time": None}
    if _OTHER.search(text):
        return {"answer": "other", "time": None}
    hhmm = None
    m = re.search(r"(?<!\d)(\d{1,2})(?:[:.](\d{2}))?(?!\d)", text)
    h = mi = None
    if m:
        h, mi = int(m.group(1)), int(m.group(2) or 0)
    else:
        for word in sorted(_HE_HOURS, key=len, reverse=True):
            if re.search(rf"(?:^|\s)ב?{word}(?![֐-׿])", text):
                h, mi = _HE_HOURS[word], (30 if "וחצי" in text else 0)
                break
    if h is not None and 0 <= h < 24 and 0 <= mi < 60:
        said_morning = bool(_MORNING.search(text))
        said_pm = bool(_EVENING.search(text) or _AFTERNOON.search(text))
        if h < 12 and (said_pm or (prefer == "evening" and not said_morning and h >= 1)):
            h += 12
        hhmm = f"{h:02d}:{mi:02d}"
    if hhmm:
        return {"answer": "time", "time": hhmm}
    for part, rx in (("afternoon", _AFTERNOON), ("evening", _EVENING), ("morning", _MORNING)):
        if rx.search(text):
            return {"answer": "daypart", "time": None, "part": part}
    if _YES.search(text):
        return {"answer": "yes", "time": None}
    return {"answer": None, "time": None}


_PARTS = {"morning": (6 * 60, 12 * 60), "afternoon": (12 * 60, 17 * 60), "evening": (17 * 60, 23 * 60)}


def _mins(hhmm: str) -> int:
    h, m = str(hhmm)[:5].split(":")
    return int(h) * 60 + int(m)


def _hhmm(total: int) -> str:
    return f"{total // 60:02d}:{total % 60:02d}"


def pick_in_part(slots: list, part: str, minutes: int) -> Optional[str]:
    """The earliest free start, on the half hour, inside a part of the day; None when none fits."""
    lo, hi = _PARTS.get(part, (0, 24 * 60))
    for sl in sorted(slots or [], key=lambda x: x["start"]):
        start = max(_mins(sl["start"]), lo)
        start = -(-start // 30) * 30
        if start + minutes <= min(_mins(sl["end"]), hi):
            return _hhmm(start)
    return None


# ── where the offered block goes ─────────────────────────────────────────────

def _normal_row(r: dict) -> dict:
    return {**r, "fixed_time": r.get("fixed_time") or r.get("fixedTime") or r.get("scheduled_time")
            or r.get("scheduledTime"),
            "duration_minutes": r.get("duration_minutes") or r.get("durationMinutes") or 30}


def propose_study(move: dict, rows: list, today: date, now_hhmm: str, minutes: int = 120) -> Optional[dict]:
    """{date, time, minutes, windows} — an hour on the day before that is FREE in her diary
    (with free_slots' buffers), in the evening first, nearest 20:00. Two hours if they fit,
    otherwise one. None when the day is gone or full — the reply then asks for the hour.

    The moved task is left out of the rows: its old slot is not busy any more, and the prep
    for it must not be blocked by itself."""
    import free_slots as _fs
    day = study_day(move["new_date"], today, now_hhmm)
    if not day:
        return None
    mine = str(move["task"].get("id"))
    others = [_normal_row(r) for r in rows or [] if str(r.get("id")) != mine]

    def free(mins):
        return _fs.find(others, day, day, mins, day_start="08:00", day_end="22:30",
                        now_date=today.isoformat(), now_hhmm=now_hhmm)["slots"]

    def fits(slots, start, mins):
        return any(_mins(s["start"]) <= start and start + mins <= _mins(s["end"]) for s in slots)

    evening = sorted(range(17 * 60, 21 * 60 + 31, 30), key=lambda st: (abs(st - 20 * 60), st))
    for mins in dict.fromkeys((minutes, 60)):
        slots = free(mins)
        for st in evening:
            if fits(slots, st, mins):
                return {"date": day, "time": _hhmm(st), "minutes": mins,
                        "windows": [{"start": s["start"], "end": s["end"]} for s in free(60)]}
    slots = free(60)
    time = pick_in_part(slots, "morning", 60) or pick_in_part(slots, "afternoon", 60)
    if time:
        return {"date": day, "time": time, "minutes": 60,
                "windows": [{"start": s["start"], "end": s["end"]} for s in slots]}
    return None


def free_starts(windows: list, minutes: int, limit: int = 3) -> list:
    """Whole-hour starts that fit in her free windows, evening first — what "another hour?" shows."""
    out = []
    for h in (20, 19, 21, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8):
        st = h * 60
        if any(_mins(w["start"]) <= st and st + minutes <= _mins(w["end"]) for w in windows or []):
            out.append(_hhmm(st))
    return sorted(out[:limit])


def suggest_for_change(task: dict, before: dict, after: dict, rows: list, today: date,
                       now_hhmm: str) -> dict:
    """What to offer when the CALENDAR moved `task` (the phone posts it): the same proposal the
    chat makes. -> {prep, kind, proposal, starts, morning}. Facts, no booking, no model.

    Only a prep kind (interview / exam / class / course) that moved to a LATER day than today gets
    a study proposal; a same-day shift or an ordinary meeting gets none — the card just says it moved."""
    kind = "sameDay"
    if before.get("date") and after.get("date") and before["date"] != after["date"]:
        kind = "later" if after["date"] > before["date"] else "earlier"
    out = {"prep": _is_prep_kind(task), "kind": kind, "proposal": None, "starts": [], "morning": []}
    if not out["prep"] or kind == "sameDay" or str(after.get("date") or "") <= today.isoformat():
        return out
    move = {"task": task, "new_date": after["date"], "new_time": after.get("time"),
            "old_date": before.get("date")}
    out["proposal"] = propose_study(move, rows, today, now_hhmm)
    if out["proposal"]:
        out["starts"] = free_starts(out["proposal"]["windows"], out["proposal"]["minutes"])
    event_time = str(after.get("time") or task.get("fixed_time") or "")[:5]
    out["morning"] = morning_options(event_time, int(task.get("travel_minutes") or 45)) if event_time else []
    return out


def study_day(new_date: str, today: date, now_hhmm: str) -> Optional[str]:
    """The day for the study block: the day before the event; today when that is today and the
    evening is not over; otherwise tomorrow if that is still before the event."""
    target = date.fromisoformat(new_date) - timedelta(days=1)
    if target > today:
        return target.isoformat()
    if target == today and now_hhmm < "21:30":
        return today.isoformat()
    tomorrow = today + timedelta(days=1)
    if target < today and tomorrow < date.fromisoformat(new_date):
        return tomorrow.isoformat()
    return None


def morning_options(event_time: str, travel_minutes: int = 45, minutes: int = 60, ready: int = 30) -> list:
    """Up to three hours to wake and study on the day of the event — 7, 8, 9 when there is room,
    not one fixed hour. Only hours that still leave the trip and getting ready; [] when the
    event is too early to study before it (then Meira offers nothing, rather than a bad hour)."""
    try:
        latest = _mins(event_time) - int(travel_minutes) - ready - minutes
    except (ValueError, TypeError):
        return []
    hourly = [h * 60 for h in (7, 8, 9, 10, 11) if h * 60 <= latest]
    if hourly:
        return [_hhmm(x) for x in hourly[:3]]
    early = [x for x in range(6 * 60, 7 * 60, 30) if x <= latest]
    return [_hhmm(x) for x in early[:3]]


# ── how pushy: the reminders around a block ──────────────────────────────────

_CHEER = {True: ("יש לך את זה! עוד שעה לומדים 💪", "את מסוגלת! 💪", "איך הולך? 🙂"),
          False: ("You've got this! Study in an hour 💪", "You can do this! 💪", "How's it going? 🙂")}


def nudges_for(level, hhmm: str, label: str, he: bool) -> list:
    """[(HH:MM, text)] — the reminders for a block at `hhmm`, by how pushy she wants Meira.
    alarm: one plain reminder. gentle: a heads-up half an hour before, and the reminder.
    motivating: a cheer an hour before, the reminder, and a check-in after. Same-day only."""
    level = normalize_level(level)
    at = _mins(hhmm)
    cheer = _CHEER[he]

    def shift(delta):
        t = at + delta
        return _hhmm(t) if 0 <= t < 24 * 60 else None

    plan = [(hhmm, f"⏰ {label}")]
    if level == "gentle":
        plan.insert(0, (shift(-30), f"⏰ {label} — " + ("בעוד חצי שעה" if he else "in half an hour")))
    elif level == "motivating":
        plan = [(shift(-60), f"{cheer[0]} ({label})"), (hhmm, f"⏰ {label} — {cheer[1]}"),
                (shift(30), cheer[2])]
    return [(t, text) for t, text in plan if t]


def study_slot(new_date: str, today: date, hhmm: str, now_hhmm: str) -> Optional[str]:
    """The day for the study block: the day before the interview, never in the past.
    Today only if the hour has not gone; otherwise tomorrow."""
    target = date.fromisoformat(new_date) - timedelta(days=1)
    if target > today:
        return target.isoformat()
    if target == today and hhmm > now_hhmm:
        return today.isoformat()
    tomorrow = today + timedelta(days=1)
    return tomorrow.isoformat() if tomorrow < date.fromisoformat(new_date) else None
