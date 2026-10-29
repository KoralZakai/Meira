"""advice — "help me choose", and "where should I move the call with Yossi?".

27.10, Koral: "Meira should help with conflicts — two things overlap, I open
a chat: 'which conference will help me more?'. 'Where should I move the call
with Yossi?' — after the change Yossi gets the new time, the task is marked
'maybe', and only once he confirms is it really happening." Her rules:

- Meira brings TWO options and she chooses. Meira never decides.
- The weighing is about HER: distance, what can be combined after each, the
  events' content, and what Meira knows about her — not only the clock.
- A message to the other person is DRAFTED; she approves and sends it (email,
  SMS or WhatsApp — whichever the event's details allow). Nothing is sent.

Code finds the two events, their context and the free hours; the judgment is
one LARGE-tier call that returns JSON; code writes the reply and keeps the
numbered choice (session.pending_choice) so "1" / "2" is read as her answer.

Consumed by agent_turn.run_turn.
"""
from __future__ import annotations

import json
import logging
import re
import urllib.parse
from datetime import date as _date, timedelta
from typing import Optional

import clashes
import day_schedule
import day_slots
import llm_usage
import model_router
import tz as _tz

logger = logging.getLogger(__name__)

CHOOSE_OWNER, MOVE_OWNER = "advice_choose", "advice_move"
MAYBE_NOTE_HE, MAYBE_NOTE_EN = "⏳ אולי — מחכה לאישור של {who}", "⏳ maybe — waiting for {who} to confirm"

_CHOOSE_RE = re.compile(
    r"(?:במה|באיזה|באיזו|איזה|איזו|מה)\s+(?:מהם\s+|מהשניים\s+)?(?:כדאי|עדיף|יותר\s+(?:יעזור|כדאי|חשוב|שווה))"
    r"|תעזרי\s+לי\s+(?:לבחור|להחליט)|לבחור\s+בין|מה\s+לבחור"
    r"|which\s+(?:one|should\s+i|is\s+better|will\s+help)|help\s+me\s+(?:choose|decide|pick)"
    r"|should\s+i\s+(?:go\s+to|pick|choose)", re.IGNORECASE)
_MOVE_RE = re.compile(
    r"(?:לאן|למתי|מתי|לאיזו\s+שעה|לאיזה\s+יום)\s+(?:כדאי\s+(?:לי\s+)?|עדיף\s+)?(?:להזיז|לדחות|להעביר)"
    r"|(?:where|when)\s+(?:should|could|can)\s+i\s+(?:move|reschedule|push)"
    r"|(?:find|suggest)\s+(?:a\s+)?(?:new\s+)?time\s+for", re.IGNORECASE)
_CONFIRMED_RE = re.compile(r"(?:\S+\s+)?(?:אישר|אישרה|אישרו|מאשר|מאשרת)\b|\b(?:confirmed|accepted|said yes)\b",
                           re.IGNORECASE)
_HE_RE = re.compile(r"[֐-׿]")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?972[-\s]?|0)5\d(?:[-\s]?\d){7}(?!\d)")
_WITH_RE = re.compile(r"(?:עם|with)\s+([\w֐-׿]{2,20})", re.IGNORECASE)


_OVERLAP_CUE_RE = re.compile(r"חופף|חופפים|חופפות|חפיפה|מתנגש|התנגשות|באותה שעה|בין\s|שני\s|שתי\s|כנס|אירוע"
                             r"|overlap|clash|same time|between|both|conference|event", re.IGNORECASE)


def wants_choice(content: str, day: Optional[list] = None) -> bool:
    """"Which one should I pick?" about HER events — not "what should I eat?"."""
    if not _CHOOSE_RE.search(content or ""):
        return False
    return bool(_OVERLAP_CUE_RE.search(content or "")) or len(named(day or [], content)) >= 1


def wants_move(content: str) -> bool:
    return bool(_MOVE_RE.search(content or ""))


def confirms(content: str) -> bool:
    return bool(_CONFIRMED_RE.search(content or "")) and len((content or "").split()) <= 6


# ── finding the events ───────────────────────────────────────────────────────

def _words(text: str) -> set:
    return {w for w in re.findall(r"[\w֐-׿]{3,}", (text or "").lower())}


def named(day: list, content: str) -> list:
    """Her tasks the message names, best word overlap first."""
    said = _words(content)
    scored = []
    for t in day or []:
        hit = len(said & _words(str(t.get("text") or "")))
        if hit:
            scored.append((hit, t))
    return [t for _, t in sorted(scored, key=lambda p: -p[0])]


def overlapping_pair(day: list) -> Optional[tuple]:
    """The first two timed tasks that overlap, soonest first."""
    timed = sorted((t for t in day or [] if t.get("date") and clashes.start_of(t)),
                   key=lambda t: (str(t["date"]), clashes.start_of(t)))
    for i, a in enumerate(timed):
        for b in timed[i + 1:]:
            if str(b["date"]) != str(a["date"]):
                break
            if clashes.overlap_minutes(a, b) > 0:
                return a, b
    return None


def pair_for(day: list, content: str) -> Optional[tuple]:
    """The two things she is choosing between: the ones she named, else the
    first overlap on her days."""
    picked = named(day, content)
    if len(picked) >= 2:
        return picked[0], picked[1]
    pair = overlapping_pair(day)
    if pair and picked and picked[0] not in pair:
        return None          # she named something that is not in the overlap: ask
    return pair


def _place(t: dict) -> str:
    loc = t.get("location")
    if isinstance(loc, dict):
        return str(loc.get("displayName") or loc.get("address") or "")
    return str(loc or "")


def describe(t: dict) -> str:
    parts = [f"id={t.get('id')}", str(t.get("text") or ""),
             f"{t.get('date')} {clashes.start_of(t) or ''}-{clashes.end_of(t) if clashes.start_of(t) else ''}"]
    for key in ("category", "description", "notes", "progress", "how", "why"):
        if t.get(key):
            parts.append(f"{key}: {str(t[key])[:300]}")
    if _place(t):
        parts.append(f"place: {_place(t)}")
    if t.get("attendees"):
        parts.append(f"with: {str(t['attendees'])[:200]}")
    return " | ".join(parts)


def after_lines(t: dict, day: list) -> str:
    """What else is on that day after it — the things that could be combined."""
    start = clashes.start_of(t) or "00:00"
    later = [x for x in day if str(x.get("date")) == str(t.get("date")) and x is not t
             and (clashes.start_of(x) or "") > start]
    loose = [x for x in day if not x.get("date")][:5]
    rows = [f"{clashes.start_of(x)} {x.get('text')}" + (f" @ {_place(x)}" if _place(x) else "") for x in later[:5]]
    rows += [f"(open, no day) {x.get('text')}" for x in loose]
    return "; ".join(rows) or "nothing else"


# ── the judgment ─────────────────────────────────────────────────────────────

_SYSTEM = (
    "You help a user choose between TWO overlapping commitments. You know her (ABOUT HER). "
    "Weigh, for each: what it gives HER given her goals and situation, its content, the distance/"
    "travel from where she will be, and what she could combine with it afterwards. Be concrete and "
    "honest; never invent facts not given. Reply JSON only:\n"
    '{"options":[{"task_id":"…","for":"≤18 words: the strongest reason to pick it, about HER",'
    '"against":"≤12 words: its real cost"}, {…}],"lean":"task_id you would pick, or null if it is '
    'truly even","why":"≤20 words: why that one, in her terms"}\n'
    "Write in the language of her message. Exactly two options, in the order given."
)


async def _judge(a: dict, b: dict, day: list, about: str, content: str) -> Optional[dict]:
    import understand
    context = (f"ABOUT HER:\n{about or '(little known)'}\n\nHER MESSAGE: {content}\n\n"
               f"OPTION A: {describe(a)}\nafter A that day: {after_lines(a, day)}\n\n"
               f"OPTION B: {describe(b)}\nafter B that day: {after_lines(b, day)}")
    model = model_router.pick("advice", prompt_chars=len(_SYSTEM) + len(context))
    try:
        resp = await understand._client().chat.completions.create(
            model=model, temperature=0.2, response_format={"type": "json_object"}, timeout=40,
            max_tokens=450,
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": context}])
        if resp.usage:
            llm_usage.record("advice", resp.usage.prompt_tokens or 0, resp.usage.completion_tokens or 0, model)
        out = json.loads(resp.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001 — the caller says it could not weigh them
        logger.warning("advice: judgment failed: %s", type(exc).__name__)
        return None
    opts = out.get("options") if isinstance(out, dict) else None
    if not isinstance(opts, list) or len(opts) < 2:
        logger.warning("advice: no two options in the answer")
        return None
    return {"options": opts[:2], "lean": out.get("lean"), "why": str(out.get("why") or "")}


def _when(t: dict, he: bool) -> str:
    d = str(t.get("date") or "")[:10]
    try:
        y, m, dd = (int(x) for x in d.split("-"))
        day = f"{dd}.{m}"
    except ValueError:
        day = d
    return f"{day} {clashes.start_of(t) or ''}".strip()


async def choose(a: dict, b: dict, day: list, about: str, content: str, he: bool) -> tuple:
    """-> (reply, [id_a, id_b]) — two options with reasons; she picks."""
    judged = await _judge(a, b, day, about, content)
    lines = [f"{a.get('text')} ({_when(a, he)}) או {b.get('text')} ({_when(b, he)}):" if he
             else f"{a.get('text')} ({_when(a, he)}) or {b.get('text')} ({_when(b, he)}):"]
    if judged is None:
        lines.append("לא הצלחתי לשקול אותם כרגע — אבל הבחירה שלך:" if he
                     else "I couldn't weigh them right now — but it's your pick:")
        for n, t in ((1, a), (2, b)):
            lines.append(f"{n}️⃣ {t.get('text')}")
    else:
        by_id = {str(o.get("task_id")): o for o in judged["options"] if isinstance(o, dict)}
        for n, t in ((1, a), (2, b)):
            o = by_id.get(str(t.get("id"))) or judged["options"][n - 1]
            pro, con = str(o.get("for") or "").strip(), str(o.get("against") or "").strip()
            lines.append(f"{n}️⃣ {t.get('text')} — {pro}" + (f" ({'מחיר' if he else 'cost'}: {con})" if con else ""))
        lean = str(judged.get("lean") or "")
        pick = a if lean == str(a.get("id")) else b if lean == str(b.get("id")) else None
        if pick is not None and judged.get("why"):
            name = str(pick.get("text") or "")
            to = ("אני נוטה ל" + ("" if _HE_RE.match(name) else "-")) if he else "I lean to "
            lines.append(f"{to}{name}: {judged['why']}")
    lines.append("מה בוחרים? כתבי 1 או 2" if he else "Which one? Reply 1 or 2")
    return "\n".join(lines), [str(a.get("id")), str(b.get("id"))]


# ── moving one, and the message to the person ───────────────────────────────

def two_slots(task: dict, day: list, now_minutes: int, today_iso: str) -> list:
    """Two free starts for it: later that same day, and the next day — never
    on top of anything, never in the past. [(date, HH:MM)]."""
    minutes = int(task.get("duration_minutes") or task.get("durationMinutes") or 30)
    try:
        base = _date.fromisoformat(str(task.get("date") or today_iso)[:10])
    except ValueError:
        base = _date.fromisoformat(today_iso)
    others = [t for t in day if t is not task and str(t.get("id")) != str(task.get("id"))]
    out: list = []
    for offset in range(0, 8):
        d = (max(base, _date.fromisoformat(today_iso)) + timedelta(days=offset)).isoformat()
        busy = day_slots.busy_of(others, d)
        not_before = now_minutes + 15 if d == today_iso else None
        if offset == 0 and clashes.start_of(task):
            start = clashes.start_of(task)
            after = int(start[:2]) * 60 + int(start[3:]) + minutes
            not_before = max(not_before or 0, after)
        hour = day_slots.first_free(busy, minutes, not_before=not_before)
        if hour:
            out.append((d, hour))
        if len(out) == 2:
            break
    return out


def person_of(task: dict) -> dict:
    """{name, email, phone} of the other person, from what the event carries."""
    # Only the fields that NAME a contact — never the invitation's prose, where
    # a planted address would aim her message at a stranger (security review).
    blob = " ".join(str(task.get(k) or "") for k in ("contact", "contactName", "contactPhone", "attendees"))
    email = next(iter(_EMAIL_RE.findall(blob)), None)
    phone = next(iter(_PHONE_RE.findall(blob)), None)
    name = str(task.get("contactName") or "").strip()
    if not name:
        m = _WITH_RE.search(str(task.get("text") or ""))
        name = m.group(1) if m else ""
    return {"name": name, "email": email, "phone": re.sub(r"[^\d+]", "", phone) if phone else None}


def draft(task: dict, new_date: str, new_hour: str, he: bool) -> dict:
    """The message she will send — text plus the ways the event allows.
    Nothing is sent from here."""
    who = person_of(task)
    old = _when(task, he)
    new = _when({"date": new_date, "fixed_time": new_hour}, he)
    hi = f"היי {who['name']}" if he and who["name"] else ("היי" if he else (f"Hi {who['name']}" if who["name"] else "Hi"))
    body = (f"{hi}, אני צריכה להזיז את {task.get('text')} מ-{old} ל-{new}. מתאים לך?" if he
            else f"{hi}, I need to move {task.get('text')} from {old} to {new}. Does that work for you?")
    links: dict = {}
    if who["email"]:
        links["email"] = ("mailto:" + who["email"] + "?" + urllib.parse.urlencode(
            {"subject": str(task.get("text") or ""), "body": body}, quote_via=urllib.parse.quote))
    if who["phone"]:
        intl = who["phone"].lstrip("+")
        if intl.startswith("0"):
            intl = "972" + intl[1:]
        links["sms"] = f"sms:+{intl}?body={urllib.parse.quote(body)}"
        links["whatsapp"] = f"https://wa.me/{intl}?text={urllib.parse.quote(body)}"
    return {"text": body, "to": who, "links": links}


def maybe_note(who: str, he: bool) -> str:
    return (MAYBE_NOTE_HE if he else MAYBE_NOTE_EN).format(who=who or ("הצד השני" if he else "them"))


def is_maybe(task: dict) -> bool:
    note = str(task.get("notes") or task.get("progress") or "")
    return note.startswith("⏳")
