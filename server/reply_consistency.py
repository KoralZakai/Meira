"""Make Lumi's reply agree with what Lumi actually SAVED.

The reported bug, from a real conversation at 03:37 on Friday 28.8:

    user      "ב 11:00 יוגה ביגאל אלון 94"
    Lumi      "✓ הוספתי ליום שישי, 28.8 | 11:00"      <- the reply
    Supabase  date = 2026-08-29                        <- what was stored

    user      "מחר שיחה ב 10:09 עם זוהר גיא"
    Lumi      "✓ הוספתי ליום שישי, 28.8 | 10:09"      <- wrong day named
    Supabase  date = 2026-08-29, fixedTime = 10:00     <- and the minutes lost

lumi_agent already carries two anti-fabrication guards, but both ask only
whether a tool RAN — never whether the reply describes what that tool actually
did. So the model is free to write one date in prose and pass another to the
tool, and nothing notices. The user then trusts the message, and the task is
filed on a day they never see.

The prose is the model's; the tool arguments are the record. Where they
disagree, the record wins. This module is pure so it can be tested without a
model or a network.
"""
import re
from datetime import date

# "28.8", "28/8", "28.08.2026" — the confirmation forms Lumi writes.
_DM_RE = re.compile(r"\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b")
# "יום שישי" / "Friday" — the weekday it names alongside the date.
_HE_DAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]  # Monday-based
_EN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_HE_DAY_RE = re.compile(r"יום\s+(" + "|".join(_HE_DAYS) + r")")
_EN_DAY_RE = re.compile(r"\b(" + "|".join(_EN_DAYS) + r")\b", re.IGNORECASE)
# A bare clock time. Used only to READ what the user asked for.
_TIME_RE = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")


def he_day(d: date) -> str:
    return "יום " + _HE_DAYS[d.weekday()]


def en_day(d: date) -> str:
    return _EN_DAYS[d.weekday()]


def times_in(text: str) -> list:
    """Every HH:MM in a message, normalized to zero-padded form."""
    return [f"{int(h):02d}:{m}" for h, m in _TIME_RE.findall(text or "")]


def correct_reply_dates(reply: str, saved: date):
    """Rewrite day/date tokens in `reply` so they name `saved`.

    Only the tokens are touched — the sentence, its warmth and its emoji are
    the model's and stay exactly as written. Returns (reply, corrections).

    A date already naming `saved` is left alone, so a correct reply is
    byte-identical going out.
    """
    if not reply or saved is None:
        return reply, 0

    fixed = 0

    def _dm(m):
        nonlocal fixed
        day, month = int(m.group(1)), int(m.group(2))
        # Not a date at all (13.45 as a score, 25.90 as a price) — leave it.
        if not (1 <= day <= 31 and 1 <= month <= 12):
            return m.group(0)
        if (day, month) == (saved.day, saved.month):
            return m.group(0)
        fixed += 1
        # Keep the separator the model chose so the line still reads naturally.
        sep = "." if "." in m.group(0) else "/"
        return f"{saved.day}{sep}{saved.month}"

    out = _DM_RE.sub(_dm, reply)

    def _he(m):
        nonlocal fixed
        if m.group(1) == _HE_DAYS[saved.weekday()]:
            return m.group(0)
        fixed += 1
        return he_day(saved)

    out = _HE_DAY_RE.sub(_he, out)

    def _en(m):
        nonlocal fixed
        if m.group(1).lower() == _EN_DAYS[saved.weekday()].lower():
            return m.group(0)
        fixed += 1
        return en_day(saved)

    out = _EN_DAY_RE.sub(_en, out)
    return out, fixed


def correct_task_time(task: dict, user_message: str):
    """Restore a fixed_time the model rounded away.

    "שיחה ב-10:09" was stored as 10:00. The user's own words are the record
    here: when they named exactly one time and the task landed on a different
    one within the same hour, the model dropped the minutes.

    Deliberately narrow. Only rewrites when the hour already agrees, so a task
    the model genuinely scheduled elsewhere (a 09:00 reminder for an 11:00
    appointment) is never dragged onto a time the user merely mentioned in
    passing. Returns (task, corrected?).
    """
    if not isinstance(task, dict):
        return task, False
    saved = task.get("fixed_time")
    if not saved:
        return task, False
    said = times_in(user_message)
    if len(said) != 1:
        return task, False          # ambiguous — leave the model's choice
    want = said[0]
    if want == saved:
        return task, False
    if want.split(":")[0] != str(saved).split(":")[0]:
        return task, False          # a different hour is a real decision
    task = dict(task)
    task["fixed_time"] = want
    return task, True
