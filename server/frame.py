"""frame — WHAT a message is, before anything is done about it (29.10).

Until now a message was do / question / chat, and every day name was read
forward. So "I went to Zumba on Monday" became a task next Monday, "how many
times did I work out?" reached a model that answered 0, and "Monday I'm at
Midburn" moved the Zumba instead of closing the day.

A frame is read in CODE, from her words alone — no model, ~0 ms, unit-tested
against golden conversations (evals/datasets/conversations.jsonl):

  intent    PAST_RETRIEVAL | CURRENT_STATUS | FUTURE_PLANNING | SCHEDULING_ACTION
            | CONTEXT_UPDATE | CORRECTION | GENERAL_CONVERSATION | CLARIFICATION
            | None (no strong signal: the understanding model decides, as before)
  time      past | present | future | recurring | hypothetical | None
  action    create | move | delete | log | remember | none
  routine   habit ("I usually…") | recurring_event ("I have X every Monday")
            | intention ("I want to start…") | one_time | None
  entity    the activities she named (past_log.KINDS labels)
  days      ISO days she named, read in the direction of `time`
  should_act  may anything be written to her calendar this turn?
  constraint  {"kind": "unavailable"|"no_new", "days": [...], "reason": "…"}

The rule the whole module serves: a statement about her past, her habits or
her availability is CONTEXT, never an instruction to schedule.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

import past_log

PAST_RETRIEVAL = "PAST_RETRIEVAL"
CURRENT_STATUS = "CURRENT_STATUS"
FUTURE_PLANNING = "FUTURE_PLANNING"
SCHEDULING_ACTION = "SCHEDULING_ACTION"
CONTEXT_UPDATE = "CONTEXT_UPDATE"
CORRECTION = "CORRECTION"
GENERAL_CONVERSATION = "GENERAL_CONVERSATION"
CLARIFICATION = "CLARIFICATION"

_Q = re.compile(r"(\?|？|^\s*(?:כמה|מתי|האם|איזה|איזו|באיזה|באילו|מה|did|do|does|have|has|how|when|what|which|was|were|is|are)\b)",
                re.I)
_PAST_HINT = re.compile(
    r"(אתמול|שלשום|שבוע שעבר|בשבוע שעבר|החודש שעבר|כבר|בעבר|הפעם האחרונה|לאחרונה|שהיה|הייתה|האחרונה|האחרון|"
    r"התאמנתי|הייתי|עשיתי|הלכתי|נסעתי|ביטלתי|היו לי|היה לי|ניסיתי|"
    r"\byesterday\b|\blast\s+(?:week|month|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|"
    r"\balready\b|\bago\b|\bdid\s+i\b|\bhave\s+i\b|\bhad\b|\bwent\b|\bwas\b|\bwere\b|\btried\b|\bcancell?ed\b|"
    r"\bworked\s+out\b|\btrained\b)", re.I)
_FUTURE_HINT = re.compile(r"(מחר|מחרתיים|הבא|הבאה|בעוד|שבוע הבא|\btomorrow\b|\bnext\b|\bin\s+\d+\s+days\b|\bwill\b|\bgoing\s+to\b)", re.I)

_SCHEDULE_RE = re.compile(
    r"(תקבעי|תוסיפי|תשמרי|תכניסי|תשבצי|תזמני|תמצאי לי|תמצאי זמן|לקבוע|לשבץ|קבעי|הוסיפי|שבצי|"
    r"\bschedule\b|\bbook\b|\badd\b|\bput\b|\bplan\b|\bfind\s+me\b|\bset\s+up\b|\bfit\s+in\b)", re.I)
_MOVE_RE = re.compile(r"(תזיזי|תעבירי|תדחי|הזיזי|העבירי|\bmove\b|\breschedule\b|\bpush\b|\bpostpone\b)", re.I)

_UNAVAIL_RE = re.compile(
    r"(בחופש(?:ה)?|בחו[\"״]ל|חולה|לא זמינה|לא פנויה|לא אהיה זמינה|במילואים|בטיסה|מחוץ לעיר|בנופש|במידברן|"
    r"\bon\s+(?:vacation|holiday|leave)\b|\baway\b|\babroad\b|\bsick\b|\bnot\s+available\b|\bunavailable\b|"
    r"\bout\s+of\s+(?:town|office)\b|\bbusy\s+all\s+day\b|\bday\s+off\b)", re.I)
_NO_NEW_RE = re.compile(
    r"(אני לא רוצה (?:לקבוע|לשבץ|שום|כלום|משהו)|אל תקבעי|אל תשבצי|בלי (?:משימות|כלום)|"
    r"\bi\s+don'?t\s+want\s+(?:to\s+(?:schedule|do|plan)\s+)?(?:anything|that)\b|\bdon'?t\s+(?:schedule|book|plan)\b|"
    r"\bkeep\b.*\bfree\b|\bnothing\s+(?:on|for)\b)", re.I)
_HABIT_RE = re.compile(r"(בדרך כלל|בד[\"״]כ|אני רגילה|אני נוהגת|תמיד אני|\busually\b|\bnormally\b|\btypically\b|\bi\s+always\b|\btend\s+to\b)", re.I)
_INTENT_RE = re.compile(r"(אני רוצה להתחיל|אני מתכננת להתחיל|הייתי רוצה להתחיל|\bi\s+want\s+to\s+start\b|\bi'?d\s+like\s+to\s+start\b|\bi'?m\s+planning\s+to\s+start\b|\bstart\s+doing\b)", re.I)
_EVERY_RE = re.compile(r"(כל\s+(?:יום|שבוע|בוקר|ערב)|בכל\s+יום|\bevery\b|\beach\s+(?:week|day)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)days\b)", re.I)
_HAVE_RE = re.compile(r"(^|\s)(יש לי|\bi\s+have\b|\bi'?ve\s+got\b)", re.I)
_CORRECT_RE = re.compile(r"^\s*(?:לא[,!.\s]|לא$|nope\b|no\b[,!.\s]?|not\s+|actually\b|בעצם|רגע[,\s]|התכוונתי|i\s+meant\b|sorry,?\s+i\s+meant)", re.I)
_ALREADY_RE = re.compile(r"(כבר עשיתי|כבר הייתי|כבר התאמנתי|עשיתי את זה|\balready\s+(?:did|done|went|had)\b|\bi\s+did\s+it\b)", re.I)
_STRAIN_RE = re.compile(r"(לא אספיק|לא אגיע|לא אוכל להגיע|גמורה|עייפה|מותשת|\bexhausted\b|\btired\b|\bcan'?t\s+make\b|\bwon'?t\s+make\b|\bnot\s+up\s+for\b)", re.I)
_STATUS_RE = re.compile(r"(מה יש לי|מה מחכה לי|מה התוכנית|מה הלו\"ז|\bwhat(?:'s|\s+is|\s+do\s+i\s+have)\b.*\b(?:today|now|tomorrow|on)\b|\bmy\s+(?:day|schedule)\b)", re.I)

_NEXT_WEEK_RE = re.compile(r"(שבוע הבא|בשבוע הבא|\bnext\s+week\b)", re.I)
_THIS_WEEK_RE = re.compile(r"(השבוע|\bthis\s+week\b)", re.I)
_LAST_RE = re.compile(r"(שעבר|שהיה|הקודם|\blast\b|\bago\b|בעבר)", re.I)


def _week_start(d: date) -> date:
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _days(text: str, today: date, past: bool) -> list:
    days = past_log.days_named(text, today, past=past)
    if not past and re.search(r"(הבא|הבאה|\bnext\b)", text, re.I):
        # "next Monday" on a Monday is a week on, never today.
        days = [d + timedelta(days=7) if d == today else d for d in days]
    if not days and _NEXT_WEEK_RE.search(text):
        a = _week_start(today) + timedelta(days=7)
        days = [a + timedelta(days=i) for i in range(7)]
    return [d.isoformat() for d in days]


def _frame(intent, time, action="none", routine=None, entity=None, days=None,
           should_act=False, constraint=None, why="") -> dict:
    return {"intent": intent, "time": time, "action": action, "routine": routine,
            "entity": entity or [], "days": days or [], "should_act": should_act,
            "constraint": constraint, "why": why}


def read(text: str, today: date, after_meira: bool = True) -> dict:
    """The frame of one message. `after_meira`: there is a Meira reply before
    it (a bare "No, I meant…" with nothing before it corrects nothing)."""
    t = str(text or "").strip()
    entity = past_log.kinds_in(t)
    is_q = bool(_Q.search(t))
    past_hint = bool(_PAST_HINT.search(t)) and not (_FUTURE_HINT.search(t) and not _LAST_RE.search(t))

    if after_meira and _CORRECT_RE.search(t) and not past_log.delete_request(t, today):
        if _ALREADY_RE.search(t):
            return _frame(CORRECTION, "past", "log", entity=entity, why="already did it")
        if _LAST_RE.search(t) or _PAST_HINT.search(t):
            return _frame(CORRECTION, "past", "move", entity=entity, days=_days(t, today, True),
                          why="corrected to the past")
        days = _days(t, today, False)
        if days:
            return _frame(CORRECTION, "future", "move", entity=entity, days=days, should_act=True,
                          why="corrected the day")
    if after_meira and _ALREADY_RE.search(t) and not is_q:
        return _frame(CORRECTION, "past", "log", entity=entity, why="already did it")

    if past_log.asks_workouts(t) or (is_q and past_hint and not _SCHEDULE_RE.search(t)):
        return _frame(PAST_RETRIEVAL, "past", "none", entity=entity,
                      days=_days(t, today, True), why="a question about her past")

    if past_log.delete_request(t, today):
        return _frame(SCHEDULING_ACTION, "future", "delete", entity=entity,
                      days=_days(t, today, False), should_act=True, why="delete")

    away = _UNAVAIL_RE.search(t)
    if away and not _SCHEDULE_RE.search(t) and not is_q:
        days = _days(t, today, False)
        return _frame(CONTEXT_UPDATE, "future" if days else "present", "remember", entity=entity, days=days,
                      constraint={"kind": "unavailable", "days": days, "reason": away.group(0).strip()},
                      why="her availability")
    if _NO_NEW_RE.search(t) and not is_q:
        days = _days(t, today, False)
        return _frame(CONTEXT_UPDATE, "future", "remember", entity=entity, days=days,
                      constraint={"kind": "no_new", "days": days, "reason": "keep clear"} if days else None,
                      why="a day she wants kept clear")

    if _INTENT_RE.search(t):
        return _frame(CONTEXT_UPDATE, "future", "remember", routine="intention", entity=entity,
                      why="something she wants to start")
    if _HABIT_RE.search(t) and not _SCHEDULE_RE.search(t):
        return _frame(CONTEXT_UPDATE, "recurring", "remember", routine="habit", entity=entity,
                      why="a habit, not a booking")
    if _HAVE_RE.search(t) and _EVERY_RE.search(t) and not is_q and not _SCHEDULE_RE.search(t):
        return _frame(CONTEXT_UPDATE, "recurring", "remember", routine="recurring_event", entity=entity,
                      why="a recurring event she already has")

    if not is_q and (past_log.report(t, today) or (past_hint and not _SCHEDULE_RE.search(t)
                                                    and not _MOVE_RE.search(t))):
        said = past_log.report(t, today)
        return _frame(CONTEXT_UPDATE, "past", "log" if said else "remember", entity=entity,
                      days=[d.isoformat() for d, _ in said] if said else _days(t, today, True),
                      why="what already happened")

    if _STRAIN_RE.search(t):
        out = _frame(GENERAL_CONVERSATION, "present", "none", entity=entity,
                     why="how she feels about a plan — reason about it, don't act")
        out["about_plan"] = bool(re.search(r"(workout|gym|meeting|class|interview|appointment|אימון|פגישה|שיעור|ראיון|תור|משימה)", t, re.I))
        return out

    if _MOVE_RE.search(t):
        return _frame(SCHEDULING_ACTION, "future", "move", routine="one_time", entity=entity,
                      days=_days(t, today, False), should_act=True, why="move")
    if _SCHEDULE_RE.search(t):
        return _frame(SCHEDULING_ACTION, "recurring" if _EVERY_RE.search(t) else "future", "create",
                      routine="recurring_event" if _EVERY_RE.search(t) else "one_time", entity=entity,
                      days=_days(t, today, False), should_act=True, why="schedule")

    if is_q and _STATUS_RE.search(t):
        return _frame(CURRENT_STATUS, "present" if not _FUTURE_HINT.search(t) else "future", "none",
                      days=_days(t, today, False), why="what is on her day")
    if is_q:
        return _frame(FUTURE_PLANNING if _FUTURE_HINT.search(t) else CURRENT_STATUS,
                      "future" if _FUTURE_HINT.search(t) else "present", "none", entity=entity,
                      days=_days(t, today, False), why="a question")
    # No strong signal: the understanding model decides (an add with a day, chat…).
    return _frame(None, None, "none", entity=entity, days=_days(t, today, False), should_act=True,
                  why="no strong signal")


def may_schedule(fr: Optional[dict]) -> bool:
    """May this turn put anything NEW on her calendar?"""
    return not fr or fr.get("intent") in (None, SCHEDULING_ACTION, CORRECTION, FUTURE_PLANNING) \
        and fr.get("time") != "past"


def stamp(fr: Optional[dict]) -> str:
    """One line the agent reads before her words: what this message IS."""
    if not fr or not fr.get("intent"):
        return ""
    bits = [f"intent={fr['intent']}", f"time={fr['time']}"]
    if fr.get("routine"):
        bits.append(f"routine={fr['routine']}")
    if fr.get("days"):
        bits.append("days=" + ",".join(fr["days"][:7]))
    rule = "" if may_schedule(fr) else " Do NOT create or move anything; answer or acknowledge."
    return f"[MESSAGE READ AS: {' '.join(bits)}.{rule}] "
