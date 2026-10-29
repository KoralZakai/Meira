"""questions_store — what Meira asked her, what she answered, what it changed.

Koral (6.10): "Meira should ask about anything unclear — a popup. After each
one, record what happened and how I answered, learn from it, and update the
rules, memory and data." The first question: a routine written with an hour
but no day ("קיקבוקס 20:30-21:30 יגאל אלון 94") was read as every day. The
phone now asks "every day, or which days?", and the answer lands here.

An answer does three things, each one visible:

1. DATA. Her line is rewritten where it lives ("… · ימי ג׳"): the phone does
   her Routines box, routes_app does what she told Meira (user_profile).
2. MEMORY. One sentence goes into user_memory ("routines"), so the agent knows
   it on WhatsApp and in the chat without being told twice.
3. RECORD. The answer itself, newest last, so user_rules can notice when she
   answers the same way again and again — and ask before making it a rule.

The chat counts too: an answer she gives Meira in words (save_profile widening
a dayless line with its days) is recorded with channel="chat"
(record_from_lines), so learning does not depend on which door she used.

A second kind, "place" (15.10): a task whose place the phone could not find.
The phone searches the map and asks "Where is "Space Gym"?"; she picks one of
the rows (choice "pick": the name, address and coordinates she chose) or says
"Something else" (choice "edit": she will fix the task herself, nothing is
learned). `subject` is the task id — one answer per task — and `line` is the
task's words, the ACTIVITY the place is learned for.

Store: {brain_key: [answer, …]}, newest last, capped. Encrypted (secure_store).
Deleted with the account (account_deletion._STORE_MODULES). Read as a union
over her identity aliases, like feedback_store.
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Optional

import config
import identity_keys
import routine_match
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "questions.json")
_MAX_PER_USER = 300
KINDS = ("routine_days", "place")
CHOICES = {"routine_days": ("days", "every_day", "varies"), "place": ("pick", "edit")}
_EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _clean(s: Optional[str], n: int) -> str:
    return " ".join(str(s or "").split())[:n]


def days_of(answer: dict):
    """The answer as what with_days takes: a list of days, or 'varies'."""
    choice = answer.get("choice")
    if choice == "every_day":
        return list(range(7))
    if choice == "varies":
        return "varies"
    return sorted({int(d) for d in answer.get("days") or [] if 0 <= int(d) <= 6})


def _coord(value, lo: float, hi: float, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"place: {name} must be a number") from None
    if not lo <= number <= hi:
        raise ValueError(f"place: {name} is out of range")
    return number


def _validate_place(choice: str, answer: dict) -> dict:
    out = {"choice": choice, "query": _clean(answer.get("query"), 160)}
    if choice == "edit":
        return out
    name = _clean(answer.get("name"), 120)
    address = _clean(answer.get("address"), 200)
    if not name or not address:
        raise ValueError("place: name and address are required")
    lat = _coord(answer.get("lat"), -90, 90, "lat")
    lng = _coord(answer.get("lng"), -180, 180, "lng")
    # 0,0 is how an UNKNOWN position used to be spelled (CLAUDE.md: Null Island).
    if lat == 0 and lng == 0:
        raise ValueError("place: 0,0 is not a place")
    out.update({"name": name, "address": address, "lat": lat, "lng": lng})
    return out


def _validate(kind: str, answer: dict) -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    choice = str(answer.get("choice") or "")
    if choice not in CHOICES[kind]:
        raise ValueError(f"choice must be one of {CHOICES[kind]}")
    if kind == "place":
        return _validate_place(choice, answer)
    out = {"choice": choice}
    if choice == "days":
        days = days_of(answer)
        if not days:
            raise ValueError("days: pick at least one day")
        out["days"] = days
    return out


def record(user_key: str, kind: str, subject: str, answer: dict, *, channel: str = "app",
           applied: Optional[dict] = None, line: Optional[str] = None) -> dict:
    """Store one answer and its memory sentence. Raises ValueError on a bad answer.

    A newer answer on the same subject replaces the older one: she changed her
    mind, and the older one must not count twice toward a rule."""
    answer = _validate(kind, answer if isinstance(answer, dict) else {})
    subject = _clean(subject, 120)
    if not subject:
        raise ValueError("subject is required")
    rec = {"kind": kind, "subject": subject, "answer": answer, "channel": _clean(channel, 12) or "app",
           "applied": applied or {}, "line": _clean(line, 300) or None, "at": time.time()}
    data = _load()
    mine = [r for r in data.get(user_key, [])
            if not (r.get("kind") == kind and r.get("subject") == subject)]
    mine.append(rec)
    data[user_key] = mine[-_MAX_PER_USER:]
    _save(data)
    try:
        import user_memory
        # A changed answer replaces the old sentence instead of contradicting it.
        memory_kind = "preference" if kind == "place" else "routine"
        user_memory.remove_insight(user_key, memory_kind, _sentence_head(rec))
        said = sentence(rec)
        if said:   # "Something else" teaches nothing about the place
            user_memory.add_insight(user_key, memory_kind, said)
    except Exception as exc:  # noqa: BLE001 — the answer itself is kept either way
        logger.warning("questions: memory sentence not saved: %s", exc)
    return rec


def answers(user_key: str, kind: Optional[str] = None) -> list:
    """Her answers, oldest first, under every key she was stored with."""
    data = _load()
    rows = [r for k in (identity_keys.keys_of(user_key) or [user_key]) for r in data.get(k, [])]
    rows.sort(key=lambda r: r.get("at") or 0)
    return [r for r in rows if not kind or r.get("kind") == kind]


def _when(rec: dict) -> str:
    t = time.localtime(rec.get("at") or time.time())
    return f"{t.tm_mday}.{t.tm_mon}"


def _days_en(answer: dict) -> str:
    days = days_of(answer)
    if days == "varies":
        return "on days that change every week"
    if len(days) == 7:
        return "every day"
    return "on " + "/".join(_EN_DAYS[d] for d in days)


def _sentence_head(rec: dict) -> str:
    if rec.get("kind") == "place":
        # The task's words, not its id: the id means nothing to the agent.
        return f"place for '{_clean(rec.get('line'), 80) or rec['subject']}' is "
    what, _, hour = rec["subject"].partition("|")
    return f"routine '{what}'" + (f" at {hour}" if hour else "") + " is "


def sentence(rec: dict) -> str:
    """The answer as one line for the agent's memory ("" = nothing to remember)."""
    if rec.get("kind") == "place":
        answer = rec["answer"]
        if answer.get("choice") != "pick":
            return ""
        return (f"{_sentence_head(rec)}'{answer['name']}', {answer['address']}"
                f" — she picked it when asked ({_when(rec)})")
    how = "she said when asked" if rec.get("channel") == "app" else "she told Meira"
    return f"{_sentence_head(rec)}{_days_en(rec['answer'])} — {how} ({_when(rec)})"


def effect(rec: dict) -> dict:
    """What the answer will change, in words she reads after ✓ (both languages)."""
    if rec.get("kind") == "place":
        answer = rec["answer"]
        if answer.get("choice") == "pick":
            return {"en": f"Saved: {answer['name']} — {answer['address']}. I'll plan the way there.",
                    "he": f"נשמר: {answer['name']} — {answer['address']}. אתכנן את הדרך."}
        return {"en": "OK — you can change the place on the task.",
                "he": "בסדר — אפשר לשנות את המקום במשימה."}
    days = days_of(rec["answer"])
    if days == "varies":
        return {"en": "Saved: it changes every week. I'll offer it when a window fits.",
                "he": "נשמר: משתנה כל שבוע. אציע אותו כשיהיה חלון שמתאים."}
    if len(days) == 7:
        return {"en": "Saved: every day. I'll plan around it daily.",
                "he": "נשמר: כל יום. אתכנן סביבו כל יום."}
    en = routine_match.days_phrase(days, "en").lstrip("· ")
    he = routine_match.days_phrase(days, "he").lstrip("· ")
    return {"en": f"Saved: {en}. I'll keep that time and plan the way there.",
            "he": f"נשמר: {he}. אשמור את הזמן הזה ואתכנן את הדרך."}


_TIMES = re.compile(r"\d{1,2}[:.]\d{2}(?:\s*[-–—]\s*\d{1,2}[:.]\d{2})?")


def subject_of(line: str) -> str:
    """"title|HH:MM" — the same key the phone gives the routine's row
    (src/utils/routineRows.ts routineTitle): her words without the hours,
    the address or the days Meira wrote in, lower-cased."""
    text = routine_match.strip_days_phrase(line)
    when = routine_match._when(text)   # noqa: SLF001
    addr = routine_match.address_in(text)
    base = (addr and routine_match.name_before(text, addr)) or text
    title = " ".join(_TIMES.sub(" ", base).split()).strip(" ,·-–—") or text.strip()
    return f"{title.lower()}|{when.get('time') or ''}"


def record_from_lines(user_key: str, before: str, after: str, channel: str = "chat") -> list:
    """Answers she gave in words: a dayless line that now carries its days.

    save_profile widens "קיקבוקס 20:30" into "קיקבוקס 20:30 ימי שלישי" when she
    answers in the chat; that is the same answer the popup would have recorded.
    -> the records made (best effort; never raises)."""
    made = []
    try:
        import user_profile
        old_lines = user_profile.routine_lines(before)
        new_lines = user_profile.routine_lines(after)
        for old in old_lines:
            if old in new_lines or routine_match.read_days(old)["from"] != "unsaid":
                continue
            when = routine_match._when(old)   # noqa: SLF001 — same module family
            if not when.get("time"):
                continue
            for new in new_lines:
                if user_profile._overlap(old, new) != "wider":   # noqa: SLF001
                    continue
                read = routine_match.read_days(new)
                if read["from"] == "unsaid":
                    break
                answer = ({"choice": "varies"} if read["from"] == "varies"
                          else {"choice": "every_day"} if len(read["days"]) == 7
                          else {"choice": "days", "days": read["days"]})
                made.append(record(user_key, "routine_days", subject_of(old), answer,
                                   channel=channel, applied={"told": "ok"}, line=old))
                break
    except Exception as exc:  # noqa: BLE001 — saving her routine must never fail on this
        logger.warning("questions: chat answer not recorded: %s", exc)
    return made
