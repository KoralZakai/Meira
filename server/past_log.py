"""past_log — "I trained on Sunday" is about the Sunday that WAS (29.10, Koral).

Live, 29.10 11:31-11:34: "How many times did I work out this week?" → "0"
(kickboxing on Sun 25.10 was ticked); "I did went to Zumba on Monday" →
a NEW task "And I did went to Zumba" on Mon 2.11; "I trained on Sunday and
Monday" → logged on Sun 1.11 and Mon 2.11 — next week, on her vacation.

A first-person past verb turns every weekday it names into the most recent
one that has already come. Pure functions only; agent_turn reads and writes.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

import history_stats

# label → the words that name it (Hebrew first-class, English by word start).
KINDS = (
    ("זומבה", ("זומבה", "zumba")),
    ("קיקבוקס", ("קיקבוקס", "קיק בוקס", "kickbox")),
    ("יוגה", ("יוגה", "yoga")),
    ("פילאטיס", ("פילאטיס", "pilates")),
    ("ריצה", ("ריצה", "רצתי", "running", "jog")),
    ("שחייה", ("שחייה", "שחיה", "שחיתי", "swim")),
    ("ספינינג", ("ספינינג", "spinning")),
    ("חדר כושר", ("חדר כושר", "חדר הכושר", "מכון כושר", "gym")),
    ("ריקוד", ("ריקוד", "dance", "dancing")),
)

_WORKOUT_VERB = re.compile(r"(התאמנתי|התעמלתי|\btrained\b|\bworked\s+out\b|\bexercised\b)", re.I)
_PAST_VERB = re.compile(
    r"(התאמנתי|התעמלתי|הלכתי|הייתי|עשיתי|רצתי|שחיתי|השתתפתי|"
    r"\bI\s+(?:did\s+|also\s+)?(?:went|go|did|trained|worked\s+out|exercised|was|ran|swam|attended)\b)",
    re.I)
_FUTURE = re.compile(r"(\bwill\b|\bgoing\s+to\b|אלך|אהיה|אתאמן|אעשה|תוסיפי|תשמרי|תקבעי|\bnext\b|הבא)", re.I)

_HE_DAYS = {"ראשון": 6, "שני": 0, "שלישי": 1, "רביעי": 2, "חמישי": 3, "שישי": 4, "שבת": 5}
_EN_DAYS = {"sunday": 6, "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
            "friday": 4, "saturday": 5}
_DAY_RE = re.compile(
    r"(?:(?:ו?[בל]?יום|ו?ב)\s*(?P<he>ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![א-ת])"
    r"|\b(?P<en>sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b"
    r"|(?P<rel>שלשום|אתמול|מחרתיים|מחר|היום|הבוקר|\btomorrow\b|\byesterday\b|\btoday\b|this\s+morning))",
    re.I)


def _find(text: str, word: str) -> int:
    """Where the word starts (English by word start: 'kickbox' in 'kickboxing'), or -1."""
    low = str(text or "").lower()
    if re.search(r"[a-z]", word):
        m = re.search(rf"\b{re.escape(word)}", low)
        return m.start() if m else -1
    return low.find(word)


def _word_in(text: str, word: str) -> bool:
    return _find(text, word) >= 0


def kinds_in(text: str) -> list:
    """The activities named, in the order she said them."""
    found = []
    for label, words in KINDS:
        pos = [p for p in (_find(text, w) for w in words) if p >= 0]
        if pos:
            found.append((min(pos), label))
    return [label for _, label in sorted(found)]


def is_workout(task: dict) -> bool:
    """history_stats' rule, plus the classes it did not know (Zumba was not
    a workout on 29.10)."""
    if history_stats.is_workout(task):
        return True
    return bool(kinds_in(task.get("text") or ""))


def matches(task: dict, kind: Optional[str]) -> bool:
    if kind is None:
        return is_workout(task)
    words = dict(KINDS).get(kind, (kind,))
    return any(_word_in(task.get("text") or "", w) for w in words)


def past_days(text: str, today: date) -> list:
    """Every day she names, as the most recent one that has come (today counts)."""
    return days_named(text, today, past=True)


def days_named(text: str, today: date, past: bool) -> list:
    """Every day she names: the one that has come (past) or the coming one
    (today counts both ways). "בראשון" with no "יום" is a day too."""
    out: list = []
    for m in _DAY_RE.finditer(text or ""):
        if m.group("rel"):
            rel = m.group("rel").lower()
            shift = {"שלשום": -2, "אתמול": -1, "yesterday": -1, "מחר": 1, "tomorrow": 1, "מחרתיים": 2}.get(rel, 0)
            d = today + timedelta(days=shift)
        else:
            wd = _HE_DAYS[m.group("he")] if m.group("he") else _EN_DAYS[m.group("en").lower()]
            d = (today - timedelta(days=(today.weekday() - wd) % 7) if past
                 else today + timedelta(days=(wd - today.weekday()) % 7))
        if d not in out:
            out.append(d)
    return out


_DELETE_RE = re.compile(r"^\s*(?:מאירה[, ]*)?(?:בבקשה\s+)?(?:ת?מחקי|ת?בטלי|תורידי|\bdelete\b|\bcancel\b|\bremove\b)\s+(?P<what>.+)$",
                        re.I)
_NOT_DELETE_RE = re.compile(r"(לא\s+ת?(?:מחקי|בטלי|תורידי)|\b(?:don'?t|do\s+not)\s+(?:delete|cancel|remove)\b)", re.I)
_FILLER = re.compile(r"(^|\s)(את|ה|the|my|on|with|ב|ביום|יום|של|עם|task|המשימה|משימה|please|בבקשה)(?=\s|$)", re.I)


def delete_request(text: str, today: date) -> Optional[dict]:
    """"תמחקי את הזומבה בראשון" → {words: ['זומבה'], days: [1.11]}; "לא תמחקי…" → None."""
    t = str(text or "").strip().rstrip("?.!")
    if _NOT_DELETE_RE.search(t):
        return None
    m = _DELETE_RE.match(t)
    if not m:
        return None
    what = m.group("what")
    days = days_named(what, today, past=False)
    rest = _DAY_RE.sub(" ", what)
    rest = re.sub(r"(?<![א-ת])ה(?=[א-ת]{2})", "", rest)     # "הזומבה" → "זומבה"
    words = [w for w in _FILLER.sub(" ", rest).split() if len(w) > 1]
    return {"words": words, "days": days} if words else None


# One of these alone, with no day, never deletes without asking (security review 29.10).
GENERIC_WORDS = {"פגישה", "שיחה", "אימון", "משימה", "תור", "meeting", "call", "workout", "task",
                 "appointment", "event", "אירוע"}


def _named(title: str, w: str) -> bool:
    return _word_in(title, w.lower()) or any(_word_in(title, x) for x in dict(KINDS).get(w, ()))


def score(task: dict, words: list) -> int:
    """How many of her words the title carries (0 = not this task)."""
    title = str(task.get("text") or "").lower()
    return sum(1 for w in words if _named(title, w))


def names(task: dict, words: list) -> bool:
    return bool(words) and score(task, words) == len(words)


def report(text: str, today: date) -> Optional[list]:
    """[(date, kind|None)] for "I trained on Sunday and Monday" /
    "I went to Zumba on Monday", or None when the message is not a report of
    a workout that already happened."""
    t = str(text or "")
    if not _PAST_VERB.search(t) or history_stats.is_history_question(t) or asks_workouts(t):
        return None
    if _FUTURE.search(t) and not re.search(r"(שהיה|שעבר|\blast\b|\bago\b|בעבר)", t):
        return None
    kinds = kinds_in(t)
    if not kinds and not _WORKOUT_VERB.search(t):
        return None
    days = [d for d in past_days(t, today) if d <= today]
    if not days:
        return None
    if len(kinds) == len(days):
        return list(zip(days, kinds))
    one = kinds[0] if len(kinds) == 1 else None
    return [(d, one) for d in days]


def is_past_titled(task: dict) -> bool:
    """A task whose TITLE is a past-tense report ("And I did went to Zumba")
    was a report filed as a plan — never a real plan."""
    return bool(_PAST_VERB.search(str(task.get("text") or "")))


_ASK_WORKOUTS = re.compile(
    r"(כמה\s+(?:פעמים|אימונים)|(?:באיזה|באילו|איזה)\s+ימים|מתי\s+התאמנתי|"
    r"\bhow\s+(?:many|often)\b|\bwhich\s+days\b|\bwhen\s+did\s+i\b)", re.I)


def asks_workouts(text: str) -> bool:
    """'How many times did I work out this week?' / 'באיזה ימים התאמנתי השבוע?'"""
    t = str(text or "")
    return bool(_ASK_WORKOUTS.search(t)) and history_stats.metric_for(t) == "workouts" and (
        bool(history_stats._PAST_VERB.search(t)) or bool(re.search(r"\bwork(?:ed)?\s+out\b", t, re.I)))


def _short(d: str) -> str:
    return f"{int(d[8:10])}.{int(d[5:7])}"


_HE_NAME = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]
_EN_NAME = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def day_label(d: str, he: bool) -> str:
    wd = date.fromisoformat(d[:10]).weekday()
    return f"{_HE_NAME[wd]} {_short(d)}" if he else f"{_EN_NAME[wd]} {_short(d)}"


def count_line(rows: list, a: str, b: str, today: date, label: str, he: bool) -> str:
    """The week's workouts from her own tasks: the ticked ones, and the past
    ones still open ("planned, not ticked — did you go?"). Never a bare 0
    when the day held a workout she did not tick."""
    past = [r for r in rows if is_workout(r) and a <= str(r.get("date") or "")[:10] <= b
            and str(r.get("date"))[:10] <= today.isoformat() and not is_past_titled(r)]
    done = sorted((r for r in past if r.get("status") == "complete"), key=lambda r: str(r.get("date")))
    open_ = sorted((r for r in past if str(r.get("status") or "pending") in ("pending", "partial")
                    and str(r.get("date"))[:10] < today.isoformat()), key=lambda r: str(r.get("date")))
    when = history_stats.period_words(label, he)
    items = ", ".join(f"{day_label(str(r['date']), he)} {r.get('text')}" for r in done)
    n = len(done)
    if he:
        line = (f"{when}: {'אימון אחד' if n == 1 else f'{n} אימונים'} ✓ ({items})" if n
                else f"{when} עוד לא סומן אף אימון.")
    else:
        line = (f"{when.capitalize()}: {n} workout{'s' if n != 1 else ''} ✓ ({items})" if n
                else f"No workout ticked {when} yet.")
    if open_:
        names = ", ".join(f"{day_label(str(r['date']), he)} {r.get('text')}" for r in open_)
        line += (f"\nבתוכנית ולא סומן: {names} — הלכת?" if he
                 else f"\nPlanned, not ticked: {names} — did you go?")
    elif not n:
        line += (" התאמנת? כתבי למשל 'התאמנתי ביום ראשון' ואסמן." if he
                 else " Did you? Say e.g. 'I trained on Sunday' and I'll tick it.")
    # The push (Koral 29.10): "and if you go today, it'll be 3 — you can make it :)"
    if b >= today.isoformat():
        tonight = sorted((r for r in rows if is_workout(r) and str(r.get("date") or "")[:10] == today.isoformat()
                          and str(r.get("status") or "pending") in ("pending", "partial") and not is_past_titled(r)),
                         key=lambda r: str(r.get("fixed_time") or r.get("fixedTime") or "99"))
        if tonight:
            r = tonight[0]
            at = r.get("fixed_time") or r.get("fixedTime")
            line += (f"\nואם תלכי היום ל{r.get('text')}{' ב-' + at if at else ''} — זה יהיה {n + 1}! את יכולה 💪" if he
                     else f"\nAnd if you go to {r.get('text')} today{' at ' + at if at else ''}, that's {n + 1} — you can make it 💪")
        elif n:
            line += (f"\nעוד אימון היום וזה {n + 1} 💪 רוצה שאמצא לך זמן?" if he
                     else f"\nOne more today and it's {n + 1} 💪 Want me to find you a time?")
    return line


_AWAY_RE = re.compile(
    r"(חופשה|חופש\b|נופש|מידברן|טיסה|בחו\"ל|בחו״ל|מילואים|\bvacation\b|\bholiday\b|\bday\s+off\b|"
    r"\babroad\b|\bflight\b|\bmidburn\b|\bout\s+of\s+office\b)", re.I)


def away_task(day_tasks: list, iso: str) -> Optional[dict]:
    """The vacation / trip / reserve duty that day, if any — a day she is not
    available (29.10: Zumba was booked on her Midburn day)."""
    for t in day_tasks:
        first = str(t.get("date") or "")[:10]
        last = str(t.get("endDate") or first)[:10] if t.get("allDay") else first
        if first <= iso <= max(first, last) and _AWAY_RE.search(str(t.get("text") or "")) \
                and str(t.get("status") or "pending") not in ("complete", "cancelled", "moved", "deleted"):
            return t
    return None


# ─── her past, any kind of thing (29.10) ────────────────────────────────────

_ASK_LAST = re.compile(r"(\blast\s+time\b|\bwhen\s+(?:was|did)\b.*\blast\b(?!\s+(?:week|month|year))|\b(?:my|the)\s+last\b(?!\s+(?:week|month|year))|הפעם האחרונה|מתי\s+.*(?:האחרון|האחרונה|לאחרונה)|מתי\s+הייתי)", re.I)
_ASK_COUNT = re.compile(r"(\bhow\s+(?:many|often)\b|כמה)", re.I)
_ASK_LIST = re.compile(r"(\bwhat\s+did\s+i\s+do\b|מה\s+עשיתי|מה\s+היה\s+לי)", re.I)
_ASK_YESNO = re.compile(r"(^\s*(?:did|have|had)\s+i\b|^\s*(?:האם|כבר)\b|\bdid\s+i\s+already\b|^\s*did\b)", re.I)
_MEETING_WORDS = ("פגישה", "פגישות", "meeting", "meetings", "שיחה", "call")
_CANCEL_WORDS = re.compile(r"(\bcancel|ביטלתי|בוטל)", re.I)
_STOP = {"did", "i", "have", "had", "the", "my", "a", "an", "to", "in", "at", "go", "went", "last", "time",
         "when", "was", "already", "this", "week", "yesterday", "how", "many", "times", "of", "on", "is",
         "האם", "כבר", "מתי", "הייתי", "הפעם", "האחרונה", "האחרון", "השבוע", "אתמול", "כמה", "פעמים",
         "היה", "לי", "את", "של", "שבוע", "שעבר", "ב", "ל", "עשיתי", "what", "do", "class", "שיעור",
         "that", "appointment", "תור", "lately", "לאחרונה", "ago", "most", "recent"}
_DONE_LIKE = ("complete",)
_GONE = ("cancelled", "moved", "deleted")


def _matcher(text: str):
    """What she asks about → a task filter, and its name for the reply."""
    kinds = kinds_in(text)
    if kinds:
        return (lambda r: any(matches(r, k) for k in kinds)), kinds[0]
    if history_stats.metric_for(text) == "workouts" or re.search(r"\bwork(?:ed)?\s*out\b|\bworkouts?\b|אימונ", text, re.I):
        return is_workout, None
    if any(_word_in(text, w) for w in _MEETING_WORDS):
        return (lambda r: r.get("category") in ("meeting", "call", "zoom")
                or any(_word_in(str(r.get("text") or ""), w) for w in _MEETING_WORDS)), "meeting"
    words = [w for w in re.findall(r"[\w֐-׿]+", text.lower()) if w not in _STOP and len(w) > 1]
    words = [w[1:] if re.match(r"^[בלה][֐-׿]{3,}", w) else w for w in words]
    if words:
        def by_words(r):
            hay = (str(r.get("text") or "") + " " + str((r.get("location") or {}).get("address") or "")
                   if isinstance(r.get("location"), dict) else str(r.get("text") or "") + " " + str(r.get("location") or "")).lower()
            return any(w in hay for w in words)
        return by_words, " ".join(words[:3])
    return None, None


def history_answer(rows: list, text: str, days: list, today: date, he: bool) -> Optional[str]:
    """A question about her past, answered from her own tasks. None → not one this can answer.

    Ticked = done. A past one still open is said as "planned, not ticked",
    never counted silently and never dropped (silent-state rule 1)."""
    import history_stats as _hs
    t = str(text or "")
    if asks_workouts(t) and not _ASK_LAST.search(t) and not _ASK_YESNO.search(t):
        p = _hs.period(t, today)
        return count_line(rows, p["from"], p["to"], today, p["label"], he)
    match, name = _matcher(t)
    asked_cancel = bool(_CANCEL_WORDS.search(t))
    if days and len(days) == 1 and not _ASK_COUNT.search(t):
        a = b = days[0]
    else:
        p = _hs.period(t, today)
        a, b = p["from"], p["to"]
        if re.search(r"(שבוע שעבר|\blast\s+week\b)", t, re.I) is None and _ASK_LAST.search(t):
            a = (today.replace(year=today.year - 1)).isoformat()      # "last time" looks back a year
    past = [r for r in rows if a <= str(r.get("date") or "")[:10] <= min(b, today.isoformat())
            and not is_past_titled(r)]
    if _ASK_LIST.search(t) and not match:
        match = lambda r: True  # noqa: E731
    if not match:
        return None
    hits = [r for r in past if match(r)]
    if asked_cancel:
        gone = [r for r in hits if str(r.get("status")) in _GONE]
        if gone:
            r = gone[-1]
            return (f"כן — {r.get('text')} ({day_label(str(r['date']), True)}) בוטל ✓" if he
                    else f"Yes — {r.get('text')} ({day_label(str(r['date']), False)}) is cancelled ✓")
        live = [r for r in rows if match(r) and str(r.get("status") or "pending") == "pending"]
        if live:
            r = live[0]
            return (f"לא — {r.get('text')} עדיין ביומן ({day_label(str(r['date']), True)}). לבטל?" if he
                    else f"No — {r.get('text')} is still on {day_label(str(r['date']), False)}. Cancel it?")
        return None
    hits = [r for r in hits if str(r.get("status") or "pending") not in _GONE]
    done = sorted((r for r in hits if r.get("status") in _DONE_LIKE), key=lambda r: (str(r.get("date")), str(r.get("fixed_time") or "")))
    open_ = sorted((r for r in hits if r.get("status") not in _DONE_LIKE
                    and str(r.get("date"))[:10] < today.isoformat()), key=lambda r: str(r.get("date")))

    def it(r):
        return f"{day_label(str(r['date']), he)} {r.get('text')}".strip()

    label = name or ("אימון" if he else "workout") if match is is_workout else (name or "")
    if _ASK_LAST.search(t):
        if done:
            r = done[-1]
            return (f"הפעם האחרונה: {it(r)}" + (f" {r['fixed_time']}" if r.get("fixed_time") else "") if he
                    else f"Last time: {it(r)}" + (f" {r['fixed_time']}" if r.get("fixed_time") else ""))
        if open_:
            r = open_[-1]
            return (f"לא מצאתי {label} מסומן כבוצע. האחרון בתוכנית: {it(r)} — הלכת?" if he
                    else f"I don't see a {label} ticked as done. The last one planned: {it(r)} — did you go?")
        return (f"לא מצאתי {label} ביומן שלך בשנה האחרונה." if he
                else f"I don't see any {label} on your calendar in the last year.")
    if _ASK_YESNO.search(t) and not _ASK_COUNT.search(t):
        if done:
            names = ", ".join(it(r) for r in done)
            return f"כן ✓ {names}" if he else f"Yes ✓ {names}"
        if open_:
            names = ", ".join(it(r) for r in open_)
            return (f"זה היה בתוכנית ({names}) אבל לא סומן כבוצע — הלכת?" if he
                    else f"It was planned ({names}) but not ticked as done — did you go?")
        return "לא — לא מצאתי ביומן." if he else "No — I don't see it on your calendar."
    if _ASK_LIST.search(t):
        if not done and not open_:
            return "לא מצאתי כלום ביומן לאותו יום." if he else "I don't see anything on your calendar for that day."
        lines = [f"• {r.get('fixed_time') or ''} {r.get('text')} ✓".replace("•  ", "• ") for r in done]
        lines += [f"• {r.get('fixed_time') or ''} {r.get('text')} (לא סומן)" if he else
                  f"• {r.get('fixed_time') or ''} {r.get('text')} (not ticked)" for r in open_]
        return "\n".join(lines)
    if _ASK_COUNT.search(t):
        when = _hs.period_words(_hs.period(t, today)["label"], he)
        n = len(done)
        line = (f"{when}: {n}" + (f" ({', '.join(it(r) for r in done)})" if done else "") if he
                else f"{when.capitalize()}: {n}" + (f" ({', '.join(it(r) for r in done)})" if done else ""))
        if open_:
            line += (f"\nועוד {len(open_)} בתוכנית שלא סומנו: {', '.join(it(r) for r in open_)}" if he
                     else f"\nPlus {len(open_)} planned but not ticked: {', '.join(it(r) for r in open_)}")
        return line
    return None
