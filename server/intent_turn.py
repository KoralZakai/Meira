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
import program_plan
import session
import user_memory
import tz as _tz

logger = logging.getLogger(__name__)

SLOT_OWNER = "slot_pick"
CONTACT_OWNER = "contact_confirm"
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


_GUESS_DROP = re.compile(
    r"(\b(?:can\s+you|please|schedule|book|add|put|plan|set\s+up|a|an|the|on|next|this|for\s+me|me)\b|"
    r"(?<![\u0590-\u05FF])(?:תקבעי|תוסיפי|תשמרי|תשבצי|לי|את|הבא|הבאה|בבקשה)(?![\u0590-\u05FF]))", re.I)


def _title_guess(content: str) -> str:
    """What she asked to book, minus the verbs and the day ("a meeting with Dana")."""
    t = past_log._DAY_RE.sub(" ", _frame.normalize(content))
    t = re.sub(r"\b(?:at|ב-?)\s*\d{1,2}(?::\d{2})?\b", " ", t)
    t = _GUESS_DROP.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip(" .,!?")
    return t[:40]


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
    if program_plan.PROGRAM_RE.search(content or ""):
        text = await _program(phone, profile_key, content, he, channel)
        if text:
            remember(phone, fr, content)
            return _reply(text)
    prep = _PREP_RE.search(content or "")
    if prep:
        text = await _prepare(phone, profile_key, prep, he)
        if text:
            remember(phone, fr, content)
            return _reply(text)
    if _NOW_RE.search(_frame.normalize(content or "")):
        text = await _what_now(phone, he)
        if text:
            remember(phone, fr, content)
            return _reply(text)
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
    if owner == CONTACT_OWNER and channel != "mcp":
        return _contact_answer(phone, content, choice, he)
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


async def _program(phone: str, profile_key: str, content: str, he: bool, channel: str) -> Optional[str]:
    """A program: steps by the model, days and hours by code, saved as one group."""
    at = _at()
    try:
        import user_profile
        about = at.user_memory.format_for_prompt(phone) + "\n" + str((user_profile.get_profile(profile_key) or {}).get("routinesNotes") or "")
    except Exception:  # noqa: BLE001
        about = ""
    name, steps = program_plan.steps_from(await program_plan.build(content, about))
    if not steps:
        return ("לא הצלחתי לבנות תוכנית כרגע — נסי שוב בעוד רגע." if he
                else "I couldn't build the program just now — try again in a moment.")
    now = _tz.now_il()
    day = await at._her_days(phone, 30)

    def finder(tasks, iso, minutes, window):
        return day_slots.first_free(day_slots.busy_of(tasks, iso), minutes, window)

    placed = program_plan.schedule(steps, day, now.date() + timedelta(days=1),
                                   lambda iso: constraints.blocked(profile_key, iso, day), finder)
    label = name or ("תוכנית" if he else "Program")
    tasks = [{"text": st["title"], "date": iso, "fixed_time": hhmm, "isFixed": False, "durationMinutes": st["minutes"],
              "category": "aspiration", "priority": "need_to", "subgroup": label} for st, iso, hhmm in placed]
    saved = await at.persist_agent_tasks(phone, label, {"tasks": tasks}, channel) if tasks else []
    if not saved:
        return ("כתבתי תוכנית, אבל לא הצלחתי לשמור אותה ביומן — נסי שוב." if he
                else "I wrote the program but couldn't save it to your calendar — try again.")
    lines = [f"🎯 {label} — {len(placed)} {'צעדים' if he else 'steps'}:"]
    for n, (st, iso, hhmm) in enumerate(placed, 1):
        lines.append(f"{n}) {st['title']} · {_dl(iso, he)} {hhmm} ({st['minutes']} {'דק׳' if he else 'min'})")
    lines.append("קבעתי ביומן בזמנים פנויים — לשנות משהו?" if he else "Booked in free time on your calendar — change anything?")
    return "\n".join(lines)


_PREP_RE = re.compile(
    r"(?:help\s+me\s+)?prep(?:are)?\s+(?:me\s+)?for\s+(?:an?\s+|my\s+|the\s+)?(?P<kind>interview|meeting|presentation|exam|call)"
    r"\s+(?:at|in|with)\s+(?P<org>[^,.?!]+?)(?:\s+(?:in|for|as)\s+(?P<role>[^,.?!]+?))?\s*[.?!]*$"
    r"|(?:תעזרי\s+לי\s+)?להתכונן\s+ל(?P<hkind>ראיון|פגישה|מצגת|מבחן)(?:\s+עבודה)?\s+(?:ב|אצל|עם)\s*-?(?P<horg>[^,.?!]+?)"
    r"(?:\s+(?:ב|לתפקיד|כ)\s*-?(?P<hrole>[^,.?!]+?))?\s*[.?!]*$",
    re.I)


async def _prepare(phone: str, profile_key: str, m: re.Match, he: bool) -> Optional[str]:
    """"Help me prepare for an interview at Asterra Labs in System Validation" —
    researched NOW (task_prep: Tavily, every line cited), never three questions
    back (29.10 live). One question at most: when, if it is not on her day."""
    import task_prep
    kind = m.group("kind") or m.group("hkind") or "interview"
    org = (m.group("org") or m.group("horg") or "").strip()
    role = re.sub(r"^(?:an?|the)\s+", "", (m.group("role") or m.group("hrole") or "").strip(), flags=re.I)
    if not org:
        return None
    title = f"{'ראיון עבודה' if he else 'Interview'} — {org}" + (f", {role}" if role else "") \
        if kind.lower() in ("interview", "ראיון") else f"{kind} — {org}" + (f", {role}" if role else "")
    interview = kind.lower() in ("interview", "ראיון")
    if interview:
        # Interviews have their own researcher (meeting_brief: company, the role, questions
        # candidates were ACTUALLY asked, prep — every line cited). task_prep is told
        # "interviews are handled elsewhere" and would answer nothing_to_prepare (review 29.10).
        import meeting_brief
        out = await meeting_brief.build({"id": f"chat:{org.lower()}:{role.lower()}", "title": f"Interview at {org}" + (f" — {role}" if role else ""),
                                         "description": f"Position: {role}" if role else "", "date": "", "time": "",
                                         "location": "", "organizer": ""}, profile_key)
        pick = (lambda k: out.get(f"{k}_he") or out.get(f"{k}_en") or []) if he else (lambda k: out.get(f"{k}_en") or [])
        items = [*pick("company")[:2], *pick("role")[:2], *pick("likely_questions")[:3], *pick("prep")[:2]]
        head = (out.get("headline_he") if he else None) or out.get("headline_en") or title
        if not out.get("ok") or not items:
            # The brief could not cite enough (29.10 live: Asterra Labs) — the general
            # researcher still can; the reason is kept for the log.
            logger.warning("prep: interview brief gave %s — trying task_prep", out.get("reason") or "no items")
            interview = False
    if not interview:
        # Asked as what to LEARN, not as "an interview" — task_prep refuses interviews
        # by design (meeting_brief owns them), so the fallback names the company and role.
        topic = (f"Learn about {org}" + (f" and the {role} role" if role else "") + " before a job interview"
                 if kind.lower() in ("interview", "ראיון") else title)
        out = await task_prep.build({"text": topic}, profile_key)
        items = (out.get("items_he") if he and out.get("items_he") else out.get("items_en")) or []
        head = (out.get("headline_he") if he and out.get("headline_he") else out.get("headline_en")) or title
        if not out.get("ok"):
            logger.warning("prep: task_prep gave %s", out.get("reason"))
    if not out.get("ok"):
        why = {"search_not_configured": "החיפוש ברשת לא מוגדר כרגע" if he else "web search isn't set up right now",
               "no_company": "לא הצלחתי לזהות את החברה" if he else "I couldn't tell which company this is",
               "nothing_to_prepare": "לא מצאתי מה להכין לזה מהרשת" if he else "the web has nothing to prepare for this",
               "no_sources": "לא מצאתי מקורות עליה ברשת" if he else "I found no sources about it on the web"}.get(
            str(out.get("reason")), "לא הצלחתי לחקור את זה כרגע" if he else "I couldn't research it right now")
        return (f"{why}. אפשר לנסות שוב בעוד רגע." if he else f"{why}. Try again in a moment.")
    srcs = out.get("sources") or []
    lines = [f"🎯 {head}", *[f"• {it}" for it in items[:8]]]
    said = re.sub(r"[^a-z\u0590-\u05FF]", "", org.lower())
    found = re.sub(r"[^a-z\u0590-\u05FF]", "", f"{head} {' '.join(str(s.get('title') or '') for s in srcs[:3])}".lower())
    if said and said not in found:
        # 29.10 live: "Asterra Labs" came back as Astera Labs — say which company was read (silent-state rule 4).
        lines.append(f"⚠️ קראתי את זה כמו שמופיע במקורות, לא בדיוק '{org}' — אם התכוונת לחברה אחרת, שלחי לי את האתר שלה."
                     if he else f"⚠️ The sources spell it differently from '{org}' — if that's not your company, send me its website.")
    if srcs:
        lines.append(("מקורות: " if he else "Sources: ") + " · ".join(f"[{s.get('n', i + 1)}] {str(s.get('title', ''))[:50]}"
                                                                     for i, s in enumerate(srcs[:3])))
    on_day = next((t for t in await _at()._her_days(phone, 30)
                   if org.lower().split()[0] in str(t.get("text") or "").lower()), None)
    if on_day:
        lines.append((f"הראיון ביומן: {_dl(str(on_day['date']), he)} {on_day.get('fixed_time') or ''} — לשבץ שעת הכנה יום לפני?"
                      if he else f"It's on your calendar: {_dl(str(on_day['date']), he)} {on_day.get('fixed_time') or ''} — "
                                 "book a prep hour the day before?").replace("  ", " "))
    else:
        lines.append("מתי הראיון? אשמור אותו ואשבץ שעת הכנה." if he else "When is it? I'll save it and book a prep hour.")
    return "\n".join(lines)


_NOW_RE = re.compile(
    r"(\bwhat\s+(?:should|do|can)\s+i\s+do\s+(?:now|next|first|right\s+now)\b|\bwhat(?:'s|\s+is)\s+next\b|"
    r"מה\s+(?:כדאי\s+לי\s+|אני\s+צריכה\s+|לעשות\s+|עליי\s+)?(?:לעשות\s+)?(?:עכשיו|קודם|הלאה)|מה\s+הבא\b|מה\s+עכשיו)",
    re.I)
_PRI = {"must": 0, "have_to": 1, "need_to": 2, "nice_to_do": 3}


def _mins(hhmm) -> Optional[int]:
    m = re.match(r"^(\d{1,2}):(\d{2})", str(hhmm or ""))
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


async def _what_now(phone: str, he: bool) -> Optional[str]:
    """"What should I do now?" — from her day, in code: what is on now, what is
    next and when to leave for it, and the one thing that fits before it."""
    now = _tz.now_il()
    today = now.date().isoformat()
    cur = now.hour * 60 + now.minute
    day = [t for t in await _at()._her_days(phone, 1) if str(t.get("date") or "")[:10] == today and not t.get("allDay")]
    timed = sorted((t for t in day if _mins(t.get("fixed_time")) is not None), key=lambda t: _mins(t["fixed_time"]))
    flexible = sorted((t for t in day if _mins(t.get("fixed_time")) is None),
                      key=lambda t: _PRI.get(str(t.get("priority") or "need_to"), 2))
    lines = []
    on_now = next((t for t in timed if _mins(t["fixed_time"]) <= cur < _mins(t["fixed_time"])
                   + int(t.get("duration_minutes") or t.get("durationMinutes") or 30)), None)
    nxt = next((t for t in timed if _mins(t["fixed_time"]) > cur), None)
    if on_now:
        end = _mins(on_now["fixed_time"]) + int(on_now.get("duration_minutes") or on_now.get("durationMinutes") or 30)
        lines.append(f"עכשיו: {on_now.get('text')} עד {end // 60:02d}:{end % 60:02d}" if he
                     else f"Now: {on_now.get('text')} until {end // 60:02d}:{end % 60:02d}")
    if nxt:
        loc = nxt.get("location") if isinstance(nxt.get("location"), dict) else {}
        leave = loc.get("leaveHomeBy") if loc else None
        gap = _mins(leave or nxt["fixed_time"]) - cur
        lines.append((f"הבא: {nxt.get('text')} ב-{nxt['fixed_time']}" + (f" — לצאת ב-{leave}" if leave else "")) if he
                     else (f"Next: {nxt.get('text')} at {nxt['fixed_time']}" + (f" — leave at {leave}" if leave else "")))
        if not on_now and flexible and gap >= 20:
            f = flexible[0]
            h, m = divmod(gap, 60)
            span = (f"{h} ש׳ {m} דק׳" if h and m else f"{h} ש׳" if h else f"{m} דק׳") if he \
                else (f"{h}h {m}m" if h and m else f"{h}h" if h else f"{m} min")
            lines.append(f"עד אז יש לך {span} — הכי כדאי: {f.get('text')}" if he
                         else f"You have {span} until then — best use: {f.get('text')}")
        elif not on_now and gap < 20:
            lines.append("כדאי כבר להתארגן ליציאה 🚪" if he else "Time to get ready to go 🚪")
    elif not on_now:
        if flexible:
            f = flexible[0]
            lines.append(f"אין לך עוד משהו בשעה קבועה היום. הכי כדאי עכשיו: {f.get('text')}" if he
                         else f"Nothing else at a fixed time today. Best thing now: {f.get('text')}")
        else:
            lines.append("היום פנוי ממשימות — זמן טוב למשהו שדחית, או למנוחה 🙂" if he
                         else "Nothing left on today — a good time for something you've put off, or a rest 🙂")
    return "\n".join(lines) if lines else None


# A name: 1–3 words of letters only ("משה לוי", "Moshe Levi") — never "yes, delete it" (security review 29.10).
_NAME_RE = re.compile(r"^\s*[A-Za-z\u0590-\u05FF'\-]{2,20}(?:\s+[A-Za-z\u0590-\u05FF'\-]{2,20}){0,2}\s*$")
_YES_WHO_RE = re.compile(r"^\s*(?:כן|yes|yep|נכון|זה הוא|זאת היא)\s*[—–\-:,]?\s*(?P<who>.*)$", re.I)


def _contact_answer(phone: str, content: str, choice: dict, he: bool) -> Optional[str]:
    """Her answer to "Moshe — is that Moshe Levi from your contacts?" (LumiBrain asks)."""
    ctx = choice.get("context") or {}
    he = bool(ctx.get("he", he))
    who = (choice.get("options") or [""])[0]
    m = _YES_WHO_RE.match(content or "")
    if m and (not m.group("who").strip() or _NAME_RE.match(m.group("who"))):
        full = _quoted(m.group("who")) or who
        session.clear_pending_choice(phone)
        try:
            user_memory.add_insight(phone, "preference", f"Contact: '{who}' is {full}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("contact not remembered: %s", type(exc).__name__)
        return (f"מעולה — {full} ✓ אזכיר לך: {ctx.get('reminder') or ''}".strip() if he
                else f"Great — {full} ✓ I'll remind you: {ctx.get('reminder') or ''}".strip())
    if _NO_RE.match(content or ""):
        return (f"איזה {who}? כתבי את השם המלא כמו שהוא שמור אצלך." if he
                else f"Which {who}? Write the full name as it's saved in your contacts.")
    if _NAME_RE.match(content or ""):
        # The full name she typed.
        session.clear_pending_choice(phone)
        full = _quoted(content)
        try:
            user_memory.add_insight(phone, "preference", f"Contact: '{who}' is {full}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("contact not remembered: %s", type(exc).__name__)
        return f"רשמתי: {who} = {full} ✓" if he else f"Noted: {who} = {full} ✓"
    return None


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
        marked = await _mark_away_days(phone, channel, content, days, c, today, he)
        if marked:
            remember(phone, fr, content)
            return marked
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


_VACATION_RE = re.compile(r"(vacation|holiday|abroad|day\s+off|חופש|נופש|חו[\"״]ל|מידברן)", re.I)


async def _mark_away_days(phone: str, channel: str, content: str, days: list, c: dict, today: date,
                          he: bool) -> Optional[str]:
    """"On vacation Monday to Saturday + a recovery day on Sunday" (29.10): every
    one of those days is MARKED on her calendar — one all-day range for the
    vacation, one all-day recovery day — not just remembered. None → nothing to mark."""
    if c.get("kind") != "unavailable" or not _VACATION_RE.search(_frame.normalize(content)) or channel == "mcp":
        return None
    span = [d.isoformat() for d in _frame._range(_frame.normalize(content), today)] or list(days)
    rest = [d for d in days if d not in span]
    recovery = rest if rest and _frame.RECOVERY_RE.search(content) else []
    span = sorted(set(span) | (set(rest) - set(recovery)))
    at = _at()
    day = await at._her_days(phone, 30)
    tasks = []
    title = "חופשה" if he else "Vacation"
    if span and not all(past_log.away_task(day, d) for d in span):
        tasks.append({"text": title, "date": span[0], "allDay": True, "durationMinutes": 24 * 60,
                      "category": "general", "priority": "need_to", "isFixed": False,
                      **({"endDate": span[-1]} if len(span) > 1 else {})})
    for d in recovery:
        tasks.append({"text": "יום התאוששות" if he else "Recovery day", "date": d, "allDay": True,
                      "durationMinutes": 24 * 60, "category": "general", "priority": "need_to", "isFixed": False})
    saved = await at.persist_agent_tasks(phone, title, {"tasks": tasks}, channel) if tasks else []
    if tasks and not saved:
        return ("סגרתי את הימים לתכנון, אבל לא הצלחתי לסמן אותם ביומן — נסי שוב בעוד רגע." if he
                else "I closed those days for planning, but couldn't mark them on your calendar — try again in a moment.")
    parts = []
    if span:
        parts.append((f"חופשה {_span(span, he)}" if he else f"vacation {_span(span, he)}"))
    if recovery:
        parts.append((f"יום התאוששות ב{_dl(recovery[0], he)}" if he else f"a recovery day on {_dl(recovery[0], he)}"))
    head = (f"הבנתי — {' ו'.join(parts)}. סימנתי ביומן כ'כל היום', ולא אקבע שם כלום ✓" if he
            else f"Got it — {' and '.join(parts)}. Marked on your calendar as all day; I won't plan anything then ✓")
    closed = set(span) | set(recovery)
    on_them = [t for t in day if str(t.get("date") or "")[:10] in closed and not t.get("allDay")
               and not past_log.away_task([t], str(t.get("date"))[:10]) and _real_plan(t)]
    if on_them:
        names = ", ".join(f"{t.get('text')} ({_dl(str(t['date']), he)})" for t in on_them[:3])
        head += (f"\nיש לך שם כבר: {names} — להזיז?" if he else f"\nYou already have {names} then — move it?")
    return head


_NOTE_RE = re.compile(r"^\s*(?:Set a new time:|לקבוע מועד חדש|⏳)", re.I)


def _real_plan(t: dict) -> bool:
    """Not a reminder note ("Set a new time: …") nor a past report filed as a plan."""
    text = str(t.get("text") or "")
    return not _NOTE_RE.match(text) and not past_log.is_past_titled(t)


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
    days_said = fr.get("days") or []
    if not title and len(days_said) == 1:
        # "Schedule a meeting with Dana on Wednesday": any booking on a closed day is caught here.
        title = _title_guess(content)
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
