"""intent_turn — the turn, dispatched by WHAT the message is (29.10).

    message → frame.read (code) → this router → handler → a reply that answers her

Each handler reads what it needs, checks her constraints, acts only when the
frame allows it, and says the result in terms of HER goal ("Zumba is on Mon
2.11 at 18:00", "You're on vacation Monday — another day?") — never "saved" /
"nothing saved". A handler that cannot answer returns None and the turn goes
on as before (understanding model → agent), with the frame stamped so the
agent knows the message is a past question / a context update.

Lives beside agent_turn, which imports it; agent_turn helpers are imported
lazily inside functions (no import cycle).
"""
from __future__ import annotations

import logging
import re
from datetime import date, timedelta
from typing import Optional

import constraints
import day_slots
import frame as _frame
import past_log
import session
import user_memory
import tz as _tz

logger = logging.getLogger(__name__)

SLOT_OWNER = "slot_pick"
BOOK_OWNER = "book_offer"
_YES_RE = re.compile(r"^\s*(?:כן|בטח|יאללה|סגור|אוקיי?|מעולה|yes|yeah|yep|sure|ok(?:ay)?|please|go ahead)\b", re.I)
_NO_RE = re.compile(r"^\s*(?:לא|עזבי|no|nope|not now|לא עכשיו)\b", re.I)
_NUM_RE = re.compile(r"^\s*(?:ה?(?:מספר\s*)?)?([1-3])\s*[.!]?\s*$")
_WORKOUT_WINDOW = ("17:00", "21:00")
_DAY_WINDOW = ("09:00", "20:00")


def _at():
    import agent_turn
    return agent_turn


def _he(content: str, user: dict) -> bool:
    return bool(re.search(r"[֐-׿]", content or "")) or user.get("language") == "he"


def _reply(text: str, **more) -> dict:
    return {"text": text, "type": "answer", "tasks": more.pop("tasks", []), "departures": [], **more}


def _dl(iso: str, he: bool) -> str:
    return past_log.day_label(iso, he)


def _title_of(fr: dict, content: str, he: bool) -> str:
    if fr.get("entity"):
        label = fr["entity"][0]
        return label if he else _EN_KIND.get(label, label)
    if re.search(r"\bwork(?:ed)?\s*out\b|\bworkouts?\b|\bgym\b|\btrain(?:ed|ing)?\b|\bexercis|אימון|התאמנ", content or "", re.I):
        return "אימון" if he else "Workout"
    return ""


_EN_KIND = {"זומבה": "Zumba", "קיקבוקס": "Kickboxing", "יוגה": "Yoga", "פילאטיס": "Pilates",
            "ריצה": "Run", "שחייה": "Swim", "ספינינג": "Spinning", "חדר כושר": "Gym", "ריקוד": "Dance"}


def _is_workout_title(title: str) -> bool:
    return past_log.is_workout({"text": title})


# ─── state ──────────────────────────────────────────────────────────────────

def _quoted(text: str) -> str:
    """Her words as DATA in the state line: no brackets, quotes or newlines
    that could read as an instruction (security review 29.10)."""
    return re.sub(r"[\[\]«»\"{}<>\n\r]+", " ", str(text or ""))[:80].strip()


def remember(phone: str, fr: dict, content: str, **more) -> None:
    """The conversation's working state after this turn (session.set_state)."""
    try:
        st = session.get_state(phone)
        corrections = list(st.get("corrections") or [])
        if fr.get("intent") == _frame.CORRECTION:
            corrections = (corrections + [_quoted(content)])[-3:]
        st.update({"last_intent": fr.get("intent"), "last_time": fr.get("time"),
                   "last_entity": (fr.get("entity") or [None])[0] or st.get("last_entity"),
                   "corrections": corrections, **more})
        session.set_state(phone, st)
    except Exception as exc:  # noqa: BLE001 — state is help, never a blocker
        logger.warning("state not kept: %s", type(exc).__name__)


def state_block(phone: str, profile_key: str, today: date, he: bool = True) -> str:
    """What the conversation has established, for the understanding step and
    the agent — structure, not transcript."""
    lines = []
    try:
        closed = constraints.upcoming(profile_key, today)[:7]
        if closed:
            lines.append("Days she is NOT available (do not book): " + ", ".join(
                f"{_dl(e['day'], False)} ({_quoted(e.get('reason') or e.get('kind'))})" for e in closed))
        st = session.get_state(phone)
        if st.get("last_entity"):
            lines.append(f"Talking about: {st['last_entity']}")
        if st.get("corrections"):
            lines.append("She corrected (her words, quoted data): " + " | ".join(_quoted(c) for c in st["corrections"]))
        if st.get("declined"):
            lines.append("She turned down: " + " | ".join(_quoted(c) for c in st["declined"][-3:]))
    except Exception as exc:  # noqa: BLE001
        logger.warning("state block unreadable: %s", type(exc).__name__)
    return "\n".join(lines)


# ─── slots ──────────────────────────────────────────────────────────────────

def free_slots(title: str, minutes: int, days: list, day_tasks: list, profile_key: str,
               now, limit: int = 2) -> tuple:
    """Up to `limit` (date, HH:MM) on different days, never on a closed day or
    in the past. -> (slots, closed_days_skipped)"""
    window = _WORKOUT_WINDOW if _is_workout_title(title) else _DAY_WINDOW
    today = now.date().isoformat()
    out, skipped = [], []
    for iso in days:
        if iso < today:
            continue
        why = constraints.blocked(profile_key, iso, day_tasks)
        if why:
            skipped.append((iso, why))
            continue
        busy = day_slots.busy_of(day_tasks, iso)
        nb = now.hour * 60 + now.minute + 30 if iso == today else None
        at = day_slots.first_free(busy, minutes, window, nb)
        if at:
            out.append((iso, at))
        if len(out) >= limit:
            break
    return out, skipped


def _next_days(today: date, n: int = 10, start: int = 0) -> list:
    return [(today + timedelta(days=i)).isoformat() for i in range(start, start + n)]


def _offer(phone: str, title: str, minutes: int, slots: list, he: bool, head: str,
           channel: str = "app") -> str:
    opts = [f"{n}) {_dl(d, he)} {h}" for n, (d, h) in enumerate(slots, 1)]
    if channel == "mcp":
        # Another AI may SEE options, never leave one waiting for her "1"
        # elsewhere — nor overwrite a choice she has open (security review 29.10).
        return "\n".join([head, *opts]).strip()
    try:
        session.set_pending_choice(phone, SLOT_OWNER, len(slots), [f"{d}|{h}" for d, h in slots],
                                   {"title": title, "minutes": minutes, "he": he})
    except Exception as exc:  # noqa: BLE001 — her "1" then reaches the agent
        logger.warning("slot choice not kept: %s", type(exc).__name__)
    tail = "איזה מתאים?" if he else "Which works?"
    return "\n".join([head, *opts, tail]).strip()


async def _book(phone: str, channel: str, title: str, iso: str, at: Optional[str], minutes: int, he: bool) -> str:
    at_mod = _at()
    task = {"text": title, "date": iso, "fixed_time": at, "isFixed": bool(at),
            "durationMinutes": minutes, "category": "gym" if _is_workout_title(title) else None}
    task = {k: v for k, v in task.items() if v is not None}
    # The content passed carries no day words, so nothing re-reads the date.
    saved = await at_mod.persist_agent_tasks(phone, title, {"tasks": [task]}, channel)
    if not saved:
        return (f"לא הצלחתי לקבוע את {title} — נסי שוב בעוד רגע." if he
                else f"I couldn't book {title} — try again in a moment.")
    try:
        session.set_last_saved(phone, [saved[0].get("id")])
    except Exception as exc:  # noqa: BLE001
        logger.warning("last-saved not kept: %s", type(exc).__name__)
    when = f"{_dl(iso, he)}" + (f" ב-{at}" if he and at else f" at {at}" if at else "")
    return f"קבעתי: {title} · {when} ✓" if he else f"Done — {title} is on {when} ✓"


# ─── the router ─────────────────────────────────────────────────────────────

async def handle(phone: str, profile_key: str, content: str, user: dict, channel: str,
                 fr: dict) -> Optional[dict]:
    """The turn by intent, or None (the old road takes it, frame stamped)."""
    he = _he(content, user)
    picked = await _picked(phone, content, channel, he)
    if picked:
        return _reply(picked)
    intent = fr.get("intent")
    if intent == _frame.PAST_RETRIEVAL:
        text = await _past_question(phone, content, fr, he)
    elif intent == _frame.CONTEXT_UPDATE:
        text = await _context(phone, profile_key, content, fr, he, channel)
    elif intent == _frame.CORRECTION:
        text = await _correction(phone, profile_key, content, fr, he, channel)
    elif intent == _frame.SCHEDULING_ACTION and fr.get("action") == "move" and channel != "mcp":
        text = await _move(phone, profile_key, content, fr, he)
    elif intent == _frame.SCHEDULING_ACTION and fr.get("action") == "create":
        text = await _schedule(phone, profile_key, content, fr, he, channel)
    else:
        text = None
    if text:
        remember(phone, fr, content)
        return _reply(text)
    return None


async def _picked(phone: str, content: str, channel: str, he: bool) -> Optional[str]:
    """Her answer to a slot offer ("1") or a yes/no offer."""
    choice = session.get_pending_choice(phone) or {}
    owner = choice.get("owner")
    if owner not in (SLOT_OWNER, BOOK_OWNER) or channel == "mcp":
        return None
    ctx = choice.get("context") or {}
    opts = list(choice.get("options") or [])
    n = None
    m = _NUM_RE.match(content or "")
    if m:
        n = int(m.group(1))
    elif _YES_RE.match(content or "") and len(opts) == 1:
        n = 1
    elif _NO_RE.match(content or ""):
        session.clear_pending_choice(phone)
        st = session.get_state(phone)
        session.set_state(phone, {**st, "declined": (list(st.get("declined") or []) + [ctx.get("title", "")])[-3:]})
        return "בסדר, השארתי את זה ככה." if he else "OK, I'll leave it."
    if not n or n > len(opts):
        return None
    session.clear_pending_choice(phone)
    he = bool(ctx.get("he", he))      # "1" has no language; the offer had one
    iso, _, at = opts[n - 1].partition("|")
    return await _book(phone, channel, ctx.get("title") or ("אימון" if he else "Workout"), iso, at or None,
                       int(ctx.get("minutes") or 60), he)


async def _rows(phone: str, a: str, b: str):
    import task_store
    # Location rides along: "when did I last go to Tel Aviv?" matches the address.
    return await task_store.fetch_tasks_with_source(phone, a, b, include_location=True)


async def _past_question(phone: str, content: str, fr: dict, he: bool) -> Optional[str]:
    today = _tz.today_il()
    a = (today - timedelta(days=366)).isoformat()
    rows, source = await _rows(phone, a, today.isoformat())
    if source == "unreachable":
        return ("לא הצלחתי לקרוא את היומן שלך כרגע — זה לא אומר שלא היה כלום. נסי שוב בעוד רגע." if he
                else "I couldn't read your calendar right now — that doesn't mean there was nothing. Try again in a moment.")
    return past_log.history_answer(rows, content, fr.get("days") or [], today, he)


async def _context(phone: str, profile_key: str, content: str, fr: dict, he: bool, channel: str) -> Optional[str]:
    today = _tz.today_il()
    c = fr.get("constraint")
    if c:
        days = c.get("days") or ([today.isoformat()] if fr.get("time") == "present" else [])
        if not days:
            return None
        if channel == "mcp":
            return None        # another AI does not close her days
        constraints.add(profile_key, c["kind"], days, c.get("reason") or "", today)
        span = _span(days, he)
        on_them = [t for t in await _at()._her_days(phone, 21) if str(t.get("date") or "")[:10] in set(days)
                   and not past_log.away_task([t], str(t.get("date"))[:10])]
        why = {"why": c.get("reason"), "source": "said", "kind": c["kind"]}
        head = (f"הבנתי — {span} את {constraints.say_away(why, True)}, לא אקבע שם כלום." if he and c["kind"] == "unavailable"
                else f"הבנתי — אשאיר את {span} פנוי." if he
                else f"Got it — you're {constraints.say_away(why, False)} {span}; I won't plan anything then." if c["kind"] == "unavailable"
                else f"Got it — I'll keep {span} clear.")
        if fr.get("time") == "present" and not c.get("days"):
            head += " עד מתי?" if he else " Until when?"
        if on_them:
            names = ", ".join(f"{t.get('text')} ({_dl(str(t['date']), he)})" for t in on_them[:3])
            head += (f"\nיש לך שם כבר: {names} — להזיז?" if he else f"\nYou already have {names} then — move it?")
        return head
    routine = fr.get("routine")
    if routine in ("habit", "recurring_event", "intention"):
        kind = {"habit": "routine", "recurring_event": "routine", "intention": "preference"}[routine]
        label = {"habit": "Habit", "recurring_event": "Recurring", "intention": "Intention"}[routine]
        if channel != "mcp":
            try:
                user_memory.add_insight(phone, kind, f"{label}: {content.strip()[:120]}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("insight not kept: %s", type(exc).__name__)
        if routine == "habit":
            return ("רשמתי לעצמי שזה ההרגל שלך — אתחשב בזה כשאתכנן, בלי לקבוע אוטומטית." if he
                    else "Noted — that's your habit. I'll keep it in mind when planning, without booking anything.")
        title = _title_of(fr, content, he)
        days = past_log.days_named(content, today, past=False)
        if title and days:
            iso = days[0].isoformat()
            if iso == today.isoformat():
                iso = (days[0] + timedelta(days=7)).isoformat()
            if channel != "mcp":
                session.set_pending_choice(phone, BOOK_OWNER, 1, [f"{iso}|"], {"title": title, "minutes": 60, "he": he})
            if routine == "recurring_event":
                return (f"הבנתי — {title} קבוע אצלך. להכניס את הבא ליומן, {_dl(iso, he)}?" if he
                        else f"Got it — {title} is a regular thing. Add the next one, {_dl(iso, he)}, to your calendar?")
            return (f"יופי! להתחיל עם {title} ב{_dl(iso, he)}?" if he
                    else f"Love it! Start with {title} on {_dl(iso, he)}?")
        return "רשמתי לעצמי ✓" if he else "Noted ✓"
    if fr.get("time") == "past":
        if fr.get("action") == "log":
            return await _at().past_turn(phone, content, he, tidy=channel != "mcp")
        # "I tried Zumba last week" / "I trained three times this week": what happened, no day to tick.
        if channel != "mcp":
            try:
                user_memory.add_insight(phone, "behavior", f"{today.isoformat()}: {content.strip()[:120]}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("insight not kept: %s", type(exc).__name__)
        title = _title_of(fr, content, he)
        said_n = _count_said(content)
        if said_n and title:
            p_from = (today - timedelta(days=(today.weekday() + 1) % 7)).isoformat()
            rows, source = await _rows(phone, p_from, today.isoformat())
            if source != "unreachable":
                n = sum(1 for r in rows if r.get("status") == "complete" and past_log.is_workout(r))
                if n >= said_n:
                    return (f"כל הכבוד 💪 {said_n} השבוע — כולם מסומנים אצלי." if he
                            else f"Nice 💪 {said_n} this week — all of them are ticked on your calendar.")
                if not n:
                    return (f"כל הכבוד 💪 {said_n} השבוע! באיזה ימים? אסמן אותם." if he
                            else f"Nice 💪 {said_n} this week! Which days? I'll tick them.")
                return (f"כל הכבוד 💪 {said_n} השבוע. אצלי מסומנים {n} — באיזה ימים היו האחרים? אסמן." if he
                        else f"Nice 💪 {said_n} this week. I have {n} ticked — which days were the others? I'll tick them.")
        if title:
            when = _when_words(content, he)
            return (f"יופי! רשמתי לעצמי: {title}{(' ' + when) if when else ''} ✓" if he
                    else f"Nice! Noted — {title}{(' ' + when) if when else ''} ✓")
        return "רשמתי לעצמי ✓" if he else "Noted ✓"
    return None


_NUM_WORDS = {"פעם אחת": 1, "פעמיים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "once": 1, "twice": 2,
              "two": 2, "three": 3, "four": 4, "five": 5}


def _count_said(content: str) -> int:
    m = re.search(r"(?<!\d)([1-9])\s*(?:times|פעמים|אימונים|workouts)", content or "", re.I)
    if m:
        return int(m.group(1))
    low = (content or "").lower()
    return next((n for w, n in _NUM_WORDS.items() if w in low), 0)


def _when_words(content: str, he: bool) -> str:
    m = re.search(r"(last\s+week|yesterday|last\s+\w+day|this\s+week|בשבוע שעבר|שבוע שעבר|אתמול|השבוע)", content or "", re.I)
    return m.group(1) if m else ""


def _span(days: list, he: bool) -> str:
    if len(days) == 1:
        return _dl(days[0], he)
    return (f"{_dl(days[0], he)}–{_dl(days[-1], he)}")


async def _correction(phone: str, profile_key: str, content: str, fr: dict, he: bool, channel: str) -> Optional[str]:
    if channel == "mcp":
        return None
    at = _at()
    ids = session.get_last_saved(phone)
    if not ids:
        return None
    day = await at._her_days(phone, 21)
    task = next((t for t in day if str(t.get("id")) == str(ids[0])), None)
    if not task:
        return None
    today = _tz.today_il().isoformat()
    if fr.get("action") == "log":
        ok = await at._patch_task(phone, str(task["id"]), {"status": "complete", "date": min(str(task.get("date") or today), today)})
        return ((f"הבנתי — סימנתי {task.get('text')} כבוצע ✓" if ok else f"לא הצלחתי לסמן את {task.get('text')}") if he
                else (f"Got it — {task.get('text')} is marked done ✓" if ok else f"I couldn't mark {task.get('text')} done"))
    days = fr.get("days") or []
    if not days:
        return None
    iso = days[0]
    if fr.get("time") == "past":
        ok = await at._patch_task(phone, str(task["id"]), {"date": iso, "status": "complete"})
        return ((f"תיקנתי — {task.get('text')} היה ב{_dl(iso, he)}, סימנתי כבוצע ✓" if ok else "לא הצלחתי לתקן") if he
                else (f"Fixed — {task.get('text')} was on {_dl(iso, he)}, marked done ✓" if ok else "I couldn't fix it"))
    why = constraints.blocked(profile_key, iso, day)
    if why:
        return (f"ב{_dl(iso, he)} את {constraints.say_away(why, he)} — לחפש יום אחר?" if he
                else f"You're {constraints.say_away(why, he)} on {_dl(iso, he)} — look for another day?")
    ok = await at._patch_task(phone, str(task["id"]), {"date": iso})
    return ((f"תיקנתי: {task.get('text')} · {_dl(iso, he)} {task.get('fixed_time') or ''} ✓".strip() if ok else "לא הצלחתי לתקן") if he
            else (f"Fixed: {task.get('text')} · {_dl(iso, he)} {task.get('fixed_time') or ''} ✓".strip() if ok else "I couldn't fix it"))


_MOVE_WORDS_RE = re.compile(r"(תזיזי|תעבירי|תדחי|הזיזי|העבירי|\bmove\b|\breschedule\b|\bpush\b|\bpostpone\b|\bto\b|\bmy\b|\bthe\b|את|ל|שלי)", re.I)


async def _move(phone: str, profile_key: str, content: str, fr: dict, he: bool) -> Optional[str]:
    days = fr.get("days") or []
    if len(days) != 1:
        return None
    at = _at()
    day = await at._her_days(phone, 21)
    words = [w for w in re.findall(r"[\w֐-׿]+", past_log._DAY_RE.sub(" ", _MOVE_WORDS_RE.sub(" ", content)))
             if len(w) > 2]
    if fr.get("entity"):
        cand = [t for t in day if any(past_log.matches(t, k) for k in fr["entity"])]
    elif re.search(r"\bwork(?:ed)?\s*out\b|\bworkouts?\b|אימון", content, re.I):
        cand = [t for t in day if past_log.is_workout(t)]
    else:
        cand = [t for t in day if words and past_log.score(t, words)]
    if len(cand) != 1:
        return None      # none or several: the understanding step / agent decides
    task, iso = cand[0], days[0]
    why = constraints.blocked(profile_key, iso, day)
    if why:
        return (f"ב{_dl(iso, he)} את {constraints.say_away(why, he)}, אז לא הזזתי. יום אחר?" if he
                else f"You're {constraints.say_away(why, he)} on {_dl(iso, he)}, so I didn't move it. Another day?")
    busy = day_slots.busy_of([t for t in day if t is not task], iso)
    hhmm = task.get("fixed_time")
    minutes = int(task.get("duration_minutes") or task.get("durationMinutes") or 60)
    patch = {"date": iso}
    note = ""
    if hhmm and day_slots.first_free(busy, minutes, (hhmm, "23:59")) != hhmm:
        new = day_slots.first_free(busy, minutes, _WORKOUT_WINDOW if past_log.is_workout(task) else _DAY_WINDOW)
        if new:
            patch["fixed_time"] = new
            note = (f" (ב-{hhmm} תפוס)" if he else f" ({hhmm} is taken)")
    ok = await at._patch_task(phone, str(task["id"]), patch)
    if not ok:
        return f"לא הצלחתי להזיז את {task.get('text')}" if he else f"I couldn't move {task.get('text')}"
    session.set_last_saved(phone, [task["id"]])
    when = f"{_dl(iso, he)} {patch.get('fixed_time') or hhmm or ''}".strip()
    return f"הזזתי: {task.get('text')} · {when}{note} ✓" if he else f"Moved: {task.get('text')} · {when}{note} ✓"


async def _schedule(phone: str, profile_key: str, content: str, fr: dict, he: bool, channel: str) -> Optional[str]:
    """Book only after the constraints are checked. A closed day is said, with
    another day; no day at all → two good slots, never a dateless note."""
    at = _at()
    title = _title_of(fr, content, he)
    if not title:
        return None      # "schedule a call with Dana at 10" — the understanding step reads it
    now = _tz.now_il()
    today = now.date()
    day = await at._her_days(phone, 21)
    days = fr.get("days") or []
    minutes = 60
    if days and len(days) == 1:
        iso = days[0]
        why = constraints.blocked(profile_key, iso, day)
        if why:
            slots, _ = free_slots(title, minutes, _next_days(today, 10, 1), day, profile_key, now)
            head = (f"ב{_dl(iso, he)} את {constraints.say_away(why, he)}, אז לא הייתי קובעת שם {title}. יום אחר?"
                    if he else f"You're {constraints.say_away(why, he)} on {_dl(iso, he)}, so I wouldn't put {title} there. Want another day?")
            return _offer(phone, title, minutes, slots, he, head, channel) if slots else head
        # A free day: the understanding step books it (her hour, alarm, place).
        return None
    # No single day: "Can you schedule Zumba?" / "Find me a workout next week".
    window = days if days else _next_days(today, 10, 1)
    slots, skipped = free_slots(title, minutes, window, day, profile_key, now)
    if not slots:
        return (f"לא מצאתי זמן פנוי ל{title} בימים האלה." if he else f"I couldn't find a free time for {title} in those days.")
    head = f"ל{title} יש לי שתי אפשרויות:" if he else f"Two good times for {title}:"
    if skipped:
        head += (f" (דילגתי על {', '.join(_dl(d, he) for d, _ in skipped[:2])} — את לא זמינה)" if he
                 else f" (skipped {', '.join(_dl(d, he) for d, _ in skipped[:2])} — you're unavailable)")
    return _offer(phone, title, minutes, slots, he, head, channel)
