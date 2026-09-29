"""understand — read the conversation, decide what she asked for, then act.

Koral, 2026-09-28: "I want the user to talk to the agent naturally, and the
agent will analyse the conversation — understand what the user wants, what she
is asking for, what the agent should do — then act."

What she got instead was a task literally titled "תוסיפי לי שיחה עם דותן בזום
5." The ReAct turn answered in prose and saved nothing, and the last line of
defence (task_rescue) is a set of regexes over her raw words: it cannot know
that "תוסיפי לי" is the request, not the task, or that "5" said at 14:00 means
17:00. Regexes decide by the shape of the words; this is a question of meaning.

So the safety net is now a language step first:

    conversation (last turns) + her message + now + her day
        → ONE model call, JSON only → {understood, actions[]}
        → code executes each action: add / update / nothing

The model decides WHAT she meant. Code still decides everything that is
arithmetic or a lookup — the date (tz.resolve_date), the label (categorize),
the duration from a range, the dedupe against her day, the clash check — so
the parts that must be deterministic stay deterministic.

The regex rescue stays underneath, for when the model cannot be reached at
all: a task saved with a clumsy title beats a task lost (and it says so).

Consumed by agent_turn.run_turn when the agent turn saved and updated nothing.
"""
from __future__ import annotations

import json
import logging
from datetime import date as _date
from typing import Optional

import day_schedule
import llm_usage
import model_router
import task_extract
import tz as _tz

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You read a conversation between a user and her planning assistant, Meira, and "
    "decide what the user's LAST message asks Meira to DO. Reply with JSON only:\n"
    '{"understood":"one short line: what she wants, in her language",'
    '"ask":"ONE short question in her language when something she clearly meant is missing '
    'or impossible (a date that does not exist, an appointment with no day), else null",'
    '"actions":[{"do":"add","title":"the thing itself, as a short noun phrase",'
    '"date_expression":"her own words for the day (מחר / 8 באוקטובר / next Monday) or null",'
    '"start":"HH:MM 24h or null","end":"HH:MM 24h or null","place":"place as she said it or null"},'
    '{"do":"update","task_id":"an id from HER DAY","start":"HH:MM or null","end":"HH:MM or null",'
    '"date_expression":"… or null","place":"… or null"}]}\n'
    "\n"
    "RULES\n"
    "- The TITLE is the thing, never the request: 'תוסיפי לי שיחה עם דותן בזום' → "
    "'שיחת זום עם דותן'. Drop 'תוסיפי/תרשמי/שימי/תכניסי לי', 'add/put', the time, the "
    "date and the place — each has its own field.\n"
    "- Times: convert to 24h using NOW. A bare hour said without בבוקר/am that is "
    "already past this morning is the afternoon/evening: at 14:00, 'ב5' / 'ב-5' / "
    "'בחמש' = 17:00. 'משתיים עד שתיים וחצי' = start 14:00, end 14:30. 'עכשיו' = NOW "
    "rounded to the next 5 minutes.\n"
    "- Never resolve dates yourself: copy her words into date_expression.\n"
    "- One real commitment = one action. A reminder about a task, the trip to it, "
    "or preparing for it is NOT a separate add.\n"
    "- If her message answers Meira's last question or changes something already on "
    "HER DAY ('תזיזי ל-5', 'לפני האימון', 'actually tomorrow'), that is an UPDATE of "
    "that task (use its id), never a new add. If the answer only says where it goes "
    "relative to other things and gives no time, return no action.\n"
    "- Something already on HER DAY, said again, is not a new add.\n"
    "- UNCLEAR → ASK, do not guess: a day she did not give for something that needs "
    "one, a date that cannot exist ('80 באוקטובר' — ask if she meant the 8th), a place "
    "too vague to route to. Still add what IS clear; put the ONE question in \"ask\".\n"
    "- Questions, chit-chat, thanks: {\"understood\":\"…\",\"actions\":[]}.\n"
    "- Several things in one message → several actions, in the order she said them."
)

_MAX_HISTORY_TURNS = 6
_TIMEOUT_S = 20


def _client():
    # Shared with task_extract: one client, one key, one endpoint.
    return task_extract._get_client()


def _day_lines(day: list) -> str:
    rows = []
    for t in day[:25]:
        when = day_schedule.hhmm(t.get("fixed_time") or t.get("fixedTime")) or "—"
        rows.append(f"- id={t.get('id')} | {t.get('date') or 'no date'} {when} | {t.get('text')}")
    return "\n".join(rows) or "(nothing)"


async def understand(message: str, history: Optional[list] = None,
                     day: Optional[list] = None, now_hhmm: Optional[str] = None,
                     today: Optional[_date] = None) -> Optional[dict]:
    """What her last message asks for. -> {understood, actions} or None.

    None means the model could not be asked or answered nonsense — NOT "she
    asked for nothing", which is {"actions": []}. The caller falls back on the
    first and does nothing on the second (silent-state rule 1)."""
    message = (message or "").strip()
    if not message:
        return {"understood": "", "actions": []}
    today = today or _tz.today_il()
    now_hhmm = now_hhmm or _tz.now_il().strftime("%H:%M")
    turns = []
    for turn in (history or [])[-_MAX_HISTORY_TURNS:]:
        content = turn.get("content") if isinstance(turn, dict) else None
        if isinstance(content, str) and content.strip():
            role = "assistant" if turn.get("role") == "assistant" else "user"
            turns.append({"role": role, "content": content[:1200]})
    context = (f"NOW: {today.isoformat()} {now_hhmm} (Israel)\n"
               f"HER DAY (open tasks):\n{_day_lines(day or [])}\n\n"
               f"HER LAST MESSAGE:\n{message}")
    model = model_router.pick("understand", prompt_chars=len(_SYSTEM) + len(context)
                              + sum(len(t["content"]) for t in turns))
    try:
        response = await _client().chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": _SYSTEM}, *turns,
                      {"role": "user", "content": context}],
            temperature=0,
            response_format={"type": "json_object"},
            timeout=_TIMEOUT_S,
        )
        usage = response.usage
        if usage:
            llm_usage.record("understand", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, model)
        payload = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001 — the caller falls back, and says so
        logger.warning("understand: model step failed: %s", exc)
        return None
    actions = payload.get("actions")
    if not isinstance(actions, list):
        logger.warning("understand: no action list in %r", str(payload)[:200])
        return None
    kept = [a for a in actions if isinstance(a, dict) and a.get("do") in ("add", "update")]
    logger.warning("understand: %r → %s", str(payload.get("understood") or "")[:80],
                   [a.get("do") for a in kept])
    ask = payload.get("ask")
    return {"understood": str(payload.get("understood") or ""), "actions": kept,
            "ask": ask.strip() if isinstance(ask, str) and ask.strip() else None}


def _minutes(start: Optional[str], end: Optional[str]) -> Optional[int]:
    s, e = day_schedule.hhmm(start), day_schedule.hhmm(end)
    if not (s and e):
        return None
    span = (int(e[:2]) * 60 + int(e[3:])) - (int(s[:2]) * 60 + int(s[3:]))
    return span if span > 0 else span + 24 * 60


def task_from(action: dict, message: str, today: Optional[_date] = None) -> Optional[dict]:
    """An "add" action → a task, labelled and dated by code, not by the model.

    Undated and untimed stays undated: the general list, where the day's plan
    places it — never dumped on today (her rule: time or place → the timeline,
    otherwise the flexible tasks)."""
    title = str(action.get("title") or "").strip()
    if not title:
        return None
    today = today or _tz.today_il()
    start = day_schedule.hhmm(action.get("start"))
    raw = {"text": title, "fixed_time": start, "duration_minutes": _minutes(start, action.get("end")),
           "date_expression": action.get("date_expression"), "location": action.get("place")}
    # The title is clean by construction; the SENTENCE is only read for a date
    # when the model copied none, and for the day-long default.
    task = task_extract.finalize(raw, title if action.get("date_expression") else message, today)
    task["text"] = title
    if not start and not action.get("date_expression"):
        if task_extract.day_long(title):
            task["fixed_time"] = task_extract.DAY_LONG_START
            task["duration_minutes"] = task_extract.DAY_LONG_MINUTES
        else:
            task["date"] = None
    if not task.get("location"):
        task.pop("location", None)
    return task


def patch_from(action: dict, today: Optional[_date] = None) -> dict:
    """An "update" action → only the fields that change."""
    patch: dict = {}
    start = day_schedule.hhmm(action.get("start"))
    if start:
        patch["fixed_time"] = start
        span = _minutes(start, action.get("end"))
        if span:
            patch["duration_minutes"] = span
    if action.get("date_expression"):
        resolved = _tz.resolve_date(str(action["date_expression"]), today)
        if resolved:
            patch["date"] = resolved.isoformat()
    if action.get("place"):
        patch["location"] = str(action["place"])
    return patch
