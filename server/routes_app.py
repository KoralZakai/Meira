"""routes_app — the endpoints the phone talks to, once the phone stops thinking.

The app is becoming a thin client: it sends what the user said and renders what
comes back. That needs doors the app can use for the two jobs it used to do
itself with an on-device LLM — capture a task from a sentence, and lay a day out
on a timeline. Both now happen here, where the API key lives on a server instead
of inside an APK anyone can unzip.

`POST /app/schedule/build` makes NO model call at all. It is a sort, and it runs
in about a millisecond. The old path computed the correct schedule locally and
then paid a 235B-parameter model to redo it, whose answer was clamped by the
local one anyway.

`POST /app/tasks/extract` makes exactly ONE cheap model call for the part that
is genuinely language — which words are the tasks — and decides everything else
in code (see task_extract).

Both are authenticated the way `/agent/chat` always was: the Supabase access
token the app already holds, verified by Supabase. Identity is never a phone
number in the body; that is the hole the rest of the routes still have.

This module is also the first FastAPI router in the codebase. main.py is 2,300
lines with every route at the top level; new routes go in routers from here on.

Dependencies: app_auth, task_extract, profile_extract, checkin_parse, email_events,
day_schedule, task_store, tz, stt.
Consumed by main.py (include_router) and by the app's LumiServer client.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response

import add_understand
import app_auth
import checkin_parse
import config
import day_planner
import day_schedule
import geo
import email_events
import meeting_brief
import reschedule
import task_prep
import history_store
import group_time
import transit_alerts
import errands_along
import feedback_store
import identity_keys
import known_places
import place_hours
import profile_extract
import questions_store
import routine_match
import user_profile
import user_rules
import rate_limit
import route_proxy
import supabase_tasks
import stt
import tts
import user_quota
import task_extract
import task_store
import tz as _tz

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/app", tags=["app"])


def _over_limit(door: str, caller: dict, shape: str = "error") -> JSONResponse | None:
    """A 429 when this account has spent its allowance on this model-calling door.

    `shape` matches what the door already answers with, so the client reads the
    refusal the way it reads every other one: "ok" doors get {ok: false,
    reason: "rate_limited"}, the rest {error: "rate_limited"}. Never an empty
    list — a refused extraction must not look like "no tasks in what you said".
    """
    if rate_limit.allow(f"{door}:{caller['key']}", rate_limit.APP_MODEL_LIMIT,
                        rate_limit.APP_MODEL_WINDOW_S):
        return None
    logger.warning("app rate limit hit on %s for one account", door)
    body = {"ok": False, "reason": "rate_limited"} if shape == "ok" else {"error": "rate_limited"}
    return JSONResponse(body, status_code=429,
                        headers={"Retry-After": str(int(rate_limit.APP_MODEL_WINDOW_S))})


def _summary(scheduled: list, language: str) -> str:
    """Lumi's one line about the day. SHORT — the schedule is the answer, not
    the sentence about it (CLAUDE.md: max 1-2 sentences, never a speech)."""
    count = sum(1 for t in scheduled if t.get("scheduled_time"))
    if not count:
        return "היום פנוי 🌤" if language == "he" else "Nothing on the timeline yet 🌤"
    first = min((t["scheduled_time"] for t in scheduled if t.get("scheduled_time")), default="")
    if language == "he":
        return f"{count} משימות היום, מתחילים ב-{first} 👇"
    return f"{count} tasks today, starting {first} 👇"


def _plan_summary(plan: dict, language: str) -> str:
    """One short line about what the planner did. The timeline is the answer."""
    placed, missed = len(plan["placed"]), len(plan["unplaced"])
    if language == "he":
        line = f"שיבצתי {placed} משימות 👇" if placed else "לא מצאתי זמן פנוי היום"
        return line + (f" · {missed} לא נכנסו" if missed else "")
    line = f"Planned {placed} tasks 👇" if placed else "No free time left today"
    return line + (f" · {missed} didn't fit" if missed else "")


@router.post("/schedule/build")
async def build_schedule(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Lay a day on a timeline. Deterministic — no model call, no cost, ~1 ms.

    Body: {date?, wake_time?, important_only?, language?, tasks?, mode?, sleep_time?}
    `tasks` lets the client schedule what it is holding (an unsaved draft, or
    its offline cache); omit it and the server reads the user's saved day.

    mode "plan" runs day_planner instead of the sort: flexible tasks go into
    the time that is really free — after journeys, with buffers, before bed —
    and the answer carries {placed, unplaced, windows}. Unplaced tasks come
    back WITH their reason, never dropped. The default stays the sort, which
    the WhatsApp tool and its tests rely on.
    """
    body = await request.json() if await request.body() else {}
    date = str(body.get("date") or _tz.today_il().isoformat())[:10]
    wake_time = day_schedule.hhmm(body.get("wake_time")) or "08:00"
    language = "he" if str(body.get("language") or "he").startswith("he") else "en"

    tasks = body.get("tasks")
    if not isinstance(tasks, list):
        tasks = await task_store.fetch_task_rows(caller["key"], date, date)

    now = _tz.now_il().strftime("%H:%M") if date == _tz.today_il().isoformat() else None

    if body.get("mode") == "plan":
        sleep_time = day_schedule.hhmm(body.get("sleep_time")) or "22:00"
        plan = day_planner.plan_day(tasks, wake_time=wake_time, sleep_time=sleep_time, now=now)
        slots = {p["id"]: p["start"] for p in plan["placed"]}
        planned = []
        for i, task in enumerate(tasks):
            tid = str(task.get("id") or f"#{i}")
            if tid in slots:
                task = dict(task, scheduled_time=slots[tid])
                if "scheduledTime" in task or "durationMinutes" in task:
                    task["scheduledTime"] = slots[tid]
            planned.append(task)
        return {"date": date, "wake_time": wake_time, "sleep_time": sleep_time,
                "tasks": planned, **plan,
                "summary": _plan_summary(plan, language), "source": "planner"}

    scheduled = day_schedule.build_day_schedule(
        tasks, wake_time=wake_time, now=now,
        important_only=bool(body.get("important_only")), today=date)

    return {"date": date, "wake_time": wake_time, "tasks": scheduled,
            "summary": _summary(scheduled, language), "source": "deterministic"}


@router.post("/tasks/extract")
async def extract_tasks(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Raw user input (spoken or typed) → structured tasks. Nothing is saved.

    Body: {text, date?, language?, history?}
    `history` is the last few chat turns ([{role, text}]) — context for "actually
    make it tomorrow"; tasks still come only from `text`.
    Returns {tasks: [...]} — already categorised, dated and timed by code, so
    the client only has to render them and ask the user to confirm.
    """
    if (limited := _over_limit("extract", caller)) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)

    today = _tz.today_il()
    raw_date = str(body.get("date") or "")[:10]
    if raw_date:
        try:
            today = _tz.date.fromisoformat(raw_date)
        except ValueError:
            pass

    history = body.get("history")
    tasks = await task_extract.extract(text, today=today,
                                       history=history if isinstance(history, list) else None)
    return {"tasks": tasks, "count": len(tasks)}


@router.post("/profile/extract")
async def extract_profile(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """One onboarding answer → the profile fields it carried.

    Body: {text, profile?}   Returns the merged profile plus `missingFields`,
    `followUpQuestion` and `isComplete`.

    What it learns is written into the profile the WhatsApp brain reads, so
    onboarding done in the app is onboarding the whole product knows about. A
    502 tells the client to use its own on-device fallback rather than lose the
    answer the user just spoke.
    """
    if (limited := _over_limit("profile", caller)) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    known = body.get("profile") if isinstance(body.get("profile"), dict) else {}
    user_quota.free_request()      # the first meeting never eats her day (8.10)
    try:
        return await profile_extract.extract(text, known, phone=identity_keys.brain_key(caller),
                                             lang=str(body.get("lang") or ""))
    except Exception as exc:  # noqa: BLE001
        logger.warning("profile extraction unavailable: %s", exc)
        # Rule 3: "today's AI allowance is used up" is not "I can't reach the
        # server" — the first meeting said the second on 8.10 when it was the first.
        if "meira_ai_limit" in str(exc):
            lang = str(body.get("lang") or "")
            line = user_quota.blocked_reply(identity_keys.brain_key(caller), text, lang) or ""
            return JSONResponse({"error": "ai_limit", "detail": line}, status_code=429)
        return JSONResponse({"error": "extraction unavailable"}, status_code=502)


@router.post("/checkin/parse")
async def parse_checkin(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """The check-in screen's verdict: what the user meant, and what to change.

    Body: {text, mode: "capture"|"review", pending_tasks?: [str]}
    Returns the agent shape the screen already renders. Rules only since
    2026-09-08 — no model call, so there is no "the model is unreachable" case
    left and the 502 below now only fires on empty text. The client keeps its
    own offline parse because the network can still fail before the request
    arrives here.
    """
    body = await request.json() if await request.body() else {}
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    mode = "review" if body.get("mode") == "review" else "capture"
    pending = body.get("pending_tasks")
    result = await checkin_parse.parse(
        text, mode, pending if isinstance(pending, list) else None)
    if result is None:
        return JSONResponse({"error": "agent unavailable"}, status_code=502)
    return result


@router.post("/email/events")
async def email_to_events(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Gmail subjects and snippets → real upcoming appointments.

    Body: {emails: [{subject, sender, snippet}], date?}
    The mailbox stays on the phone: the app reads Gmail with the user's own
    Google token and sends only what it found, so no mailbox access moves here.
    Returns {events: [...]}, empty when nothing survives the date filter — a
    missed suggestion is recoverable, an invented appointment is not.
    """
    if (limited := _over_limit("email", caller)) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    emails = body.get("emails")
    if not isinstance(emails, list) or not emails:
        return {"events": []}

    today = _tz.today_il()
    raw_date = str(body.get("date") or "")[:10]
    if raw_date:
        try:
            today = _tz.date.fromisoformat(raw_date)
        except ValueError:
            pass
    return {"events": await email_events.extract(emails[:40], today)}


@router.post("/change/suggest")
async def change_suggest_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """The calendar moved one of her events: which hour is free for the offer on the Today card?

    Body: {task: {id, category, text?, fixed_time?, travel_minutes?},
           before: {date, time?}, after: {date, time?},
           rows: [{id, fixed_time?, duration_minutes?, status?, category?}]}   (the day before the
           event is what matters; the phone sends that day's rows and nothing else)

    Returns {ok, prep, kind, proposal: {date, time, minutes, windows} | null, starts[], morning[]}.
    Pure arithmetic over what the phone sent (reschedule.suggest_for_change): no model, no
    storage, nothing booked — the phone saves the block and its reminder, and says so only
    when both landed. A proposal of null with prep true means the day before is full or gone:
    the card then offers no hour rather than a guess."""
    body = await request.json() if await request.body() else {}
    task, before, after = body.get("task"), body.get("before"), body.get("after")
    rows = body.get("rows") if isinstance(body.get("rows"), list) else []
    if not (isinstance(task, dict) and isinstance(before, dict) and isinstance(after, dict)
            and str(after.get("date") or "")[:10]):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    after = {**after, "date": str(after["date"])[:10]}
    before = {**before, "date": str(before.get("date") or "")[:10]}
    result = reschedule.suggest_for_change(
        task, before, after, rows[:60], _tz.today_il(), _tz.now_il().strftime("%H:%M"))
    return {"ok": True, **result}


@router.post("/meeting/brief")
async def meeting_brief_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """One calendar event → a short pre-meeting brief, sourced and cited.

    Body: {event: {id, title, date, time, location?, description?, organizer?,
                   attendees?[], history?[{date, subject, from, snippet}],
                   previous?[{date, title, notes}]},
           force?: bool}

    The calendar stays on the phone, exactly like Gmail does: the app reads it
    with the user's own Google token and posts ONE event. No Google credential
    reaches this server.

    `history` is the same bargain for the mailbox: the app searches Gmail for
    messages with ONE named correspondent and posts at most four subjects and
    snippets. It becomes a numbered source like any other, so "you last agreed
    to send the CV" cites its origin exactly as "Ceva makes DSP cores" does.
    Nothing else from the mailbox is sent, and no body text at all.

    `previous` is the same bargain for the calendar: at most two earlier events with
    the same attendees (or title) — "what happened last time" — cited like any source.

    Returns {ok: true, headline_he/_en, company_*, person_*, questions_*,
    sources[], confidence} — or {ok: false, reason} when there is nothing worth
    researching ("gym"), search is unconfigured, or nothing was found. A plain
    reason is the point: the app shows no card rather than an invented one.

    An INTERVIEW (title/description says interview or ראיון, or `category` is
    "interview") also carries role_*, likely_questions_*, prep_* — every line
    cited to a fetched web source — and `missing`, the names of the sections
    that came out empty. Its refusals are told apart so the card can say why:
    no_company, search_not_configured, search_failed, no_sources, compose_failed,
    nothing_cited. `category` is optional in `event`.
    """
    if (limited := _over_limit("brief", caller, "ok")) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    event = body.get("event")
    if not isinstance(event, dict) or not (event.get("title") or event.get("description")):
        return JSONResponse({"ok": False, "reason": "no_event"}, status_code=400)
    return await meeting_brief.build(event, identity_keys.brain_key(caller), force=bool(body.get("force")))


@router.post("/task/prep")
async def task_prep_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """One task → what to prepare for it, from live search, every item cited.

    Body: {task: {id?, text, category?, date?, time?, location?}, force?: bool}

    Karaoke → songs to practise and where the lyrics are; a clinic → what to
    bring and ask. Returns {ok: true, kind, headline_*, items_*, sources[]} or
    {ok: false, reason} — "nothing_to_prepare" for laundry, and a different
    reason for every way it could fail, so the app never shows an invented card.
    """
    if (limited := _over_limit("prep", caller, "ok")) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    task = body.get("task")
    if not isinstance(task, dict) or not (task.get("text") or "").strip():
        return JSONResponse({"ok": False, "reason": "no_task"}, status_code=400)
    return await task_prep.build(task, identity_keys.brain_key(caller), force=bool(body.get("force")))


@router.post("/add/understand")
async def add_understand_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Meira's conclusions while she types something to add (server/add_understand.py).

    Body: {text, lang: "he"|"en", parsed: {category, time?, endTime?, date?,
           person?: {label, relation?, hasPhone}, place?, occasion?},
           context: {now, here_label?, tomorrow: [{text, time, place}]}}

    `parsed` is what the phone already read from the sentence on its own (free,
    local). The phone's number for the person NEVER comes up here: `hasPhone`
    is a boolean, and the WhatsApp link is built on the phone.

    Returns {ok: true, conclusions: [{kind, text_he, text_en, action}],
    greeting?: {to, text_he, text_en}, model_used} or {ok: false, reason:
    "ai_limit" | "model_unavailable" | "bad_output" | "too_short"}. One model
    call at most — and none for an interview or a sentence with no occasion.
    """
    if not rate_limit.allow(f"addu:{caller['key']}", rate_limit.CHAT_LIMIT, rate_limit.CHAT_WINDOW_S):
        return JSONResponse({"ok": False, "reason": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    return await add_understand.understand(body)


@router.post("/errands/along")
async def errands_along_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """An errand with no place → places ON her planned route, open when she passes.

    Body: {task: {text}, trips: [{polyline, leave, arrive, date, label?}]}

    The trips are the journeys the phone already planned (their encoded
    polylines and times) — no position trace, just the lines. Returns
    {ok, query, minutes, candidates:[{name, address, lat, lng, pass_at,
    off_route_m, open_when_passing, maps_url, trip}]} or {ok: false, reason}.
    """
    if (limited := _over_limit("errands", caller, "ok")) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    task = body.get("task") or {}
    trips = body.get("trips") or []
    if not isinstance(task, dict) or not isinstance(trips, list):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    if body.get("rules_only"):
        # The Add screen's "on your way" suggestions look at her open errands
        # every time it opens. They must not spend a model call (one of her
        # fifteen requests today) per look: the words decide — errands_along's
        # own rule table — and a task no rule recognises is "not an errand" here
        # (OnYourWayCard on the task itself still asks the model).
        plan = errands_along.rule_understand(task.get("text") or "") or {
            "errand": False, "query_he": "", "query_en": "", "minutes": 15, "why": "no rule matches"}
        return await errands_along.along(task.get("text") or "", trips[:3], plan=plan,
                                         user_key=identity_keys.brain_key(caller), prices=False)
    memory = ""
    try:
        import memory_recall
        memory = (await memory_recall.block_for(identity_keys.brain_key(caller), task.get("text") or "")) or ""
    except Exception as exc:  # noqa: BLE001 — works without memory
        logger.info("errands_along: memory unavailable (%s)", exc)
    liked = feedback_store.lines(identity_keys.brain_key(caller), "errand")
    if liked:
        memory = f"{memory}\nHER VERDICTS ON PAST SUGGESTIONS:\n{liked}".strip()
    return await errands_along.along(task.get("text") or "", trips[:3], memory=memory,
                                     user_key=identity_keys.brain_key(caller))


@router.post("/questions/answer")
async def question_answer_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Her answer to one of Meira's questions (questions_store). Body:
    {kind: "routine_days", subject: "קיקבוקס|20:30", line: <her line as it
    reads now>, answer: {choice: days|every_day|varies, days?: [0-6]},
    rewrite_told: bool — rewrite the line in what she told Meira}.

    kind "place" (15.10, "Where is X?"): {kind: "place", subject: <task id>,
    line: <the task's words>, answer: {choice: "pick", query, name, address,
    lat, lng} | {choice: "edit", query}}. A pick is also remembered as where
    that activity happens (known_places) so WhatsApp finds it too; "edit"
    records that she will fix the task herself and learns nothing.

    Returns {ok, applied, new_line, effect{en,he}, proposal?}. `ok` is false
    with reason "line_changed" when the line she answered about is no longer
    there: the answer is still recorded, nothing is guessed (rule 3).
    """
    if (limited := _over_limit("answer", caller, "ok")) is not None:
        return limited
    body = await request.json() if await request.body() else {}
    brain = identity_keys.brain_key(caller)
    kind = str(body.get("kind") or "")
    answer = body.get("answer") if isinstance(body.get("answer"), dict) else {}
    line = str(body.get("line") or "")[:300]
    applied: dict = {}
    new_line = None
    try:
        if kind == "routine_days" and line:
            new_line = routine_match.with_days(line, questions_store.days_of(answer))
            if body.get("rewrite_told"):
                ok = user_profile.replace_routine_line(brain, line, new_line)
                applied["told"] = "ok" if ok else "line_changed"
        rec = questions_store.record(brain, kind, str(body.get("subject") or ""), answer,
                                     channel="app", applied=applied, line=line)
        if kind == "place" and rec["answer"].get("choice") == "pick":
            # Where this ACTIVITY happens, for the WhatsApp path (the phone keeps its own copy).
            # Best effort: the answer itself is recorded either way, and the response says which.
            try:
                picked = rec["answer"]
                # Under her account id AND her number (caller["key"]): the stores
                # that keep places still read only the key they are handed
                # (identity_keys.report_split), and the WhatsApp path asks by number.
                for who in dict.fromkeys([brain, str(caller.get("key") or "")]):
                    if who:
                        known_places.remember(who, line, picked["address"], picked["lat"], picked["lng"],
                                              name=picked["name"])
                applied["known_place"] = "ok"
            except Exception as exc:  # noqa: BLE001 — say it failed, never "learned"
                logger.warning("place answer: known place not remembered: %s", exc)
                applied["known_place"] = "failed"
    except ValueError as exc:
        return JSONResponse({"ok": False, "reason": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001 — say it failed, never "saved"
        logger.warning("question answer not saved: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    proposal = None
    try:
        proposal = user_rules.proposal_after(brain, kind)
    except Exception as exc:  # noqa: BLE001 — the answer counts without a proposal
        logger.warning("rule proposal skipped: %s", exc)
    out = {"ok": applied.get("told") != "line_changed", "saved": rec, "applied": applied,
           "new_line": new_line, "effect": questions_store.effect(rec)}
    if not out["ok"]:
        out["reason"] = "line_changed"
    if proposal:
        out["proposal"] = proposal
    return out


@router.post("/profile/routines/remove")
async def routines_remove_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """✕ on a routine she told Meira (You → Routines), or Undo on the chat's
    card. Body: {lines: [her words]}. -> {ok, removed: [...]} — removed is []
    when no line read that way any more, and the app says so."""
    body = await request.json() if await request.body() else {}
    lines = [str(x)[:300] for x in (body.get("lines") or []) if str(x).strip()][:20]
    if not lines:
        return JSONResponse({"ok": False, "reason": "lines is required"}, status_code=400)
    try:
        removed = user_profile.remove_routine_lines(identity_keys.brain_key(caller), lines)
    except Exception as exc:  # noqa: BLE001 — say it failed, never "removed"
        logger.warning("routine not removed: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    return {"ok": True, "removed": removed}


@router.post("/profile/routines/replace")
async def routines_replace_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Her routines, consolidated on the phone (one line per routine, no
    duplicates — 13.10, Koral: "optimize all the content, no reduplications"),
    become the whole list Meira keeps. Body: {lines}. -> {ok, kept}.
    An empty list is refused: clearing everything is the ✕, one at a time."""
    body = await request.json() if await request.body() else {}
    lines = [stt.fix_places(str(x).strip())[:300] for x in (body.get("lines") or []) if str(x).strip()][:40]
    if not lines:
        return JSONResponse({"ok": False, "reason": "lines is required"}, status_code=400)
    try:
        user_profile.update_profile(identity_keys.brain_key(caller), routinesNotes="\n".join(lines),
                                    replace_routines=True)
    except Exception as exc:  # noqa: BLE001 — say it failed, never "saved"
        logger.warning("routines not replaced: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    return {"ok": True, "kept": len(lines)}


@router.get("/rules")
async def rules_route(caller: dict = Depends(app_auth.require_caller)):
    """What she taught Meira (user_rules), for You and for the phone's policy."""
    return {"rules": user_rules.rules(identity_keys.brain_key(caller))}


@router.post("/rules")
async def rule_confirm_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Her yes/no to a proposed rule. Body: {id, yes}. -> {ok, rule?}"""
    body = await request.json() if await request.body() else {}
    try:
        rule = user_rules.confirm(identity_keys.brain_key(caller), str(body.get("id") or ""),
                                  bool(body.get("yes")))
    except ValueError as exc:
        return JSONResponse({"ok": False, "reason": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        logger.warning("rule not saved: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    return {"ok": True, **({"rule": rule} if rule else {})}


@router.delete("/rules")
async def rule_remove_route(id: str, caller: dict = Depends(app_auth.require_caller)):
    """✕ on a rule in You. -> {ok, removed}"""
    try:
        removed = user_rules.remove(identity_keys.brain_key(caller), id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("rule not removed: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    return {"ok": True, "removed": removed}


@router.post("/data-key")
async def data_key(caller: dict = Depends(app_auth.require_caller)):
    """The AES key for THIS account's rows in tasks / user_profiles (7.10).

    Derived on the server from LUMI_DATA_KEY for this verified user id only —
    another account gets another key. The app keeps it in SecureStore and seals
    the personal fields before they reach Supabase, so the database (its
    dashboard, backups, a leaked service key) holds ciphertext. {enabled:false}
    until SEAL_APP_ROWS=1: the app then writes as before."""
    import field_crypto
    if not supabase_tasks.sealing_on():
        return {"enabled": False}
    return {"enabled": True, "v": 1, "key": field_crypto.user_key_b64(caller["userId"])}


@router.post("/link/start")
async def link_start(caller: dict = Depends(app_auth.require_caller)):
    """Begin proving a WhatsApp number (phone_links). Returns {code, expires_in,
    url}: `url` opens WhatsApp with the code prefilled to Meira's number; the
    link is made only when that message arrives, signed by Meta, FROM the number.
    A typed number proves nothing — that was the 7.10 takeover hole."""
    import phone_links
    try:
        out = phone_links.start(caller["userId"])
    except Exception as exc:  # noqa: BLE001 — say it failed, never a dead code
        logger.warning("link start failed: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    number = await phone_links.meira_number()
    text = f"קוד חיבור למאירה: {out['code']}"
    from urllib.parse import quote
    out["url"] = f"https://wa.me/{number}?text={quote(text)}" if number else None
    out["text"] = text
    out["ok"] = True
    if not number:
        out["reason"] = "meira_number_unknown"
    return out


@router.post("/link/status")
async def link_status(caller: dict = Depends(app_auth.require_caller)):
    """Is a WhatsApp number linked to me? {linked, phone} — the app polls this
    after opening WhatsApp, so ✓ is shown only when it is TRUE. The number goes
    only to the account that PROVED it."""
    import phone_links
    phone = phone_links.phone_for(caller["userId"])
    return {"linked": bool(phone), "phone": phone}


@router.post("/feedback")
async def feedback_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """👍/👎 on a suggestion. Body: {surface: errand|prep|brief, verdict: up|down,
    subject, place_id?, about?, reason?}.

    Returns {ok, saved, effect} — `effect` says in words what the verdict will
    change, so the app can confirm something TRUE rather than just "thanks".
    """
    body = await request.json() if await request.body() else {}
    try:
        v = feedback_store.record(
            identity_keys.brain_key(caller), str(body.get("surface") or ""), str(body.get("verdict") or ""),
            str(body.get("subject") or ""), place_id=body.get("place_id"),
            about=body.get("about"), reason=body.get("reason"))
    except ValueError as exc:
        return JSONResponse({"ok": False, "reason": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001 — say it failed, never "thanks"
        logger.warning("feedback not saved: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    if v["surface"] == "prep" and v["verdict"] == "down":
        try:
            task_prep.forget(identity_keys.brain_key(caller), v["subject"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("feedback: prep cache not cleared: %s", exc)
    if v["surface"] == "errand":
        effect = ("moves up next time" if v["verdict"] == "up"
                  else "won't be recommended again")
    else:
        effect = "Meira will prepare more like this" if v["verdict"] == "up" else "Meira will prepare differently"
    return {"ok": True, "saved": v, "effect": effect}


@router.post("/geocode")
async def geocode_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """An address → coordinates, resolved with the SERVER's Maps key.

    Body: {address: str, bounds?: "lat,lng|lat,lng"}

    WHY THIS EXISTS. The app was calling Google's Geocoding API directly with
    the key compiled into the APK — and that key is restricted, correctly, to
    four APIs that do NOT include Geocoding. Every call came back
    REQUEST_DENIED, the app fell through to the device geocoder, and the whole
    point of the Google path — `region=il` plus a box around her home, so a
    bare street name lands in her own city — never ran. It failed as a warning
    in a log nobody reads.

    Widening the APK key would fix it by making the shipped key more powerful,
    which is the wrong direction. The server key already has Geocoding and
    never leaves the server.
    """
    body = await request.json() if await request.body() else {}
    address = str(body.get("address") or "").strip()
    if not address:
        return JSONResponse({"ok": False, "reason": "no_address"}, status_code=400)
    hit = await geo.geocode(address, bounds=str(body.get("bounds") or "") or None)
    if not hit:
        # Not an error: the caller falls back to the device geocoder, and a
        # plain "not found" is what tells it to.
        return {"ok": False, "reason": "not_found"}
    return {"ok": True, **hit}


@router.post("/place/search")
async def place_search_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """A place NAME → up to 5 {name, address, lat, lng}, with the server's key.

    Body: {query: str, type?: "train_station", radius?: int}
    Returns {ok: True, results: [...]} — results may be [] (Google found
    nothing) — or {ok: False, reason: "provider_refused" | "rate_limited" |
    "bad_request"}. The profile's place picker and the train-interchange search
    used to ask Google from the phone, with the APK's key (8.10).
    """
    if not rate_limit.allow(f"places:{caller['key']}", rate_limit.CHAT_LIMIT, rate_limit.CHAT_WINDOW_S):
        return JSONResponse({"ok": False, "reason": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}
    query = str(body.get("query") or "").strip()[:200]
    if not query:
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    place_type = str(body.get("type") or "").strip()
    # "gym": her routine's gym is checked on the map (gymCheck, 13.10).
    if place_type and place_type not in ("train_station", "transit_station", "bus_station", "gym"):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    try:
        radius = min(max(int(body.get("radius") or 0), 0), 50_000)
    except (TypeError, ValueError):
        radius = 0
    try:
        results = await geo.text_search(query, place_type or None, radius or None)
    except geo.PlacesRefused as exc:
        logger.warning("place search refused: %s", exc)
        return {"ok": False, "reason": "provider_refused"}
    return {"ok": True, "results": results}


@router.post("/place/hours")
async def place_hours_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Is this place open for this slot? Google Places, with the server's key.

    Body: {place: str, date: "YYYY-MM-DD", start?: "HH:MM", end?: "HH:MM"}

    Returns {ok: True, name, intervals: [["08:00","19:00"]], open?, why?,
    opens?, closes?} — or {ok: False, reason} where reason is not_found |
    no_hours_listed | not_configured | provider_failed. Never a bare "open":
    a place we could not look up is not a place we checked (silent-state
    rule 1), and the app says "I couldn't check the hours" for every one of
    those reasons.
    """
    if not rate_limit.allow(f"hours:{caller['key']}", rate_limit.CHAT_LIMIT, rate_limit.CHAT_WINDOW_S):
        return JSONResponse({"ok": False, "reason": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}
    place = str(body.get("place") or "").strip()
    date_iso = str(body.get("date") or "").strip()
    if not place or len(date_iso) != 10:
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    res = await place_hours.hours_for(place, date_iso)
    start, end = str(body.get("start") or ""), str(body.get("end") or "")
    if res.get("ok") and len(start) == 5 and len(end) == 5:
        res = {**res, **place_hours.slot_verdict(res.get("intervals") or [], start, end)}
    return res


# ─── her history (Feature 2, 20.10) — opt-in only ───────────────────────────

@router.post("/history/consent")
async def history_consent(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Her yes or no to 'learn from my history'. Body {on: bool}.
    Yes → backfills the last 90 days from her tasks. No → deletes the log."""
    body = await request.json() if await request.body() else {}
    if not isinstance(body.get("on"), bool):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    return await history_store.set_consent(identity_keys.brain_key(caller), body["on"])


@router.post("/history/events")
async def history_events(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """A batch of events from the phone: {events: [{kind, day, taskId, text,
    category, minutes, data, dedupKey}]}. Refused (not stored) without her
    opt-in. Returns {ok, stored, streaks} or {ok: False, reason}."""
    if not rate_limit.allow(f"history:{caller['key']}", rate_limit.CHAT_LIMIT, rate_limit.CHAT_WINDOW_S):
        return JSONResponse({"ok": False, "reason": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}
    events = body.get("events")
    if not isinstance(events, list):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    return await history_store.record(identity_keys.brain_key(caller), events)


@router.get("/history/week")
async def history_week(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """'My week': this period's numbers vs the one before, her targets, and the
    ONE firm line. ?period=this week|last week|this month. {ok: False, reason}
    when it could not be computed — never zeros standing in for a failure."""
    key = identity_keys.brain_key(caller)
    if not history_store.opted_in(key):
        return {"ok": False, "optedIn": False, "reason": "not_opted_in"}
    return await history_store.report(key, request.query_params.get("period") or "this week")
@router.post("/transit/alerts")
async def transit_alerts_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """News of disruptions on one trip: roadworks, closed lines, strikes.

    Body: {places: [str], stations?: [str], lines?: [str], modes?: [str]}

    Returns transit_alerts.disruptions_for as is: {ok, checked: True,
    alerts: [{title, link, snippet, published, matched}]} when the search
    ran (alerts may be []), or {ok: False, checked: False, reason}. The card
    shows "couldn't check" for the second, never a clear road.
    """
    if not rate_limit.allow(f"transit:{caller['key']}", rate_limit.CHAT_LIMIT, rate_limit.CHAT_WINDOW_S):
        return JSONResponse({"ok": False, "checked": False, "reason": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}

    def strs(key: str) -> list:
        v = body.get(key) or []
        return [str(x)[:120] for x in v if isinstance(x, (str, int))][:12] if isinstance(v, list) else []

    places, stations, lines, modes = strs("places"), strs("stations"), strs("lines"), strs("modes")
    if not (places or stations or lines):
        return JSONResponse({"ok": False, "checked": False, "reason": "bad_request"}, status_code=400)
    return await transit_alerts.disruptions_for(
        places=places, stations=stations, lines=lines, modes=modes)


# ─── find time together (Feature 3, 20.10) ──────────────────────────────────

@router.post("/groups")
async def groups_create(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Body {title, minutes, slots:[{day, start}], members:[{name, phone}], ownerName}.
    Returns {ok, groupId, invites:[{name, link}]} — a share link for EVERY member,
    so the response never says who is on Meira."""
    if not rate_limit.allow(f"groups:{caller['key']}", 20, 3600):
        return JSONResponse({"ok": False, "reason": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}
    if not isinstance(body.get("slots"), list) or not isinstance(body.get("members"), list):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    return await group_time.create(
        identity_keys.brain_key(caller), str(body.get("ownerName") or "")[:60],
        str(body.get("title") or ""), int(body.get("minutes") or 60),
        body["slots"], body["members"], config.PUBLIC_URL)


@router.get("/groups")
async def groups_mine(caller: dict = Depends(app_auth.require_caller)):
    return await group_time.my_groups(identity_keys.brain_key(caller))


@router.get("/groups/{gid}")
async def groups_view(gid: str, caller: dict = Depends(app_auth.require_caller)):
    """Organizer: the grid (members × slots, ✓/✗/?). Member: her own row."""
    return await group_time.view(gid, identity_keys.brain_key(caller))


@router.post("/groups/{gid}/respond")
async def groups_respond(gid: str, request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Body {join?: bool, answers?: {slotId: "yes"|"no"}}."""
    body = await request.json() if await request.body() else {}
    join = body.get("join") if isinstance(body.get("join"), bool) else None
    answers = body.get("answers") if isinstance(body.get("answers"), dict) else None
    if join is None and not answers:
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    return await group_time.respond(gid, identity_keys.brain_key(caller), join, answers)


@router.post("/groups/{gid}/lock")
async def groups_lock(gid: str, request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Body {slotId}. Organizer only. Adds the slot to everyone who said yes."""
    body = await request.json() if await request.body() else {}
    if not body.get("slotId"):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    return await group_time.lock(gid, identity_keys.brain_key(caller), str(body["slotId"]))


@router.post("/route/directions")
async def route_directions(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Google Directions, asked by the SERVER with the server's key.

    Body: {
      origin, destination,            # addresses, or "lat,lng"
      date?: "YYYY-MM-DD",            # the day of the appointment
      arrive_by?: "HH:MM",            # arrive at or before this
      queries: [{mode, transit_mode?}, ...]   # up to 8, run concurrently
    }
    Returns {results: [{status, error_message, data, cached}, ...]} — Google's
    own body per query, pruned but not parsed.

    WHY. The key compiled into the APK is restricted to `meira.secretary` plus a
    SHA-1 fingerprint, which is right, and which Google enforces through the
    `X-Android-Package` / `X-Android-Cert` headers that only the Maps SDK
    sends. A plain fetch from React Native sends neither, so EVERY Directions
    call from the phone came back REQUEST_DENIED — 107 of them in one day at a
    99% error rate, while the card told her there was no train.

    `/app/geocode` above moved Geocoding here for exactly this reason, in
    exactly these words. Directions was left behind.

    The response is deliberately Google's own shape: `src/utils/transitParse`
    already parses and ranks it the way she asked, and a second parser here
    would be a second thing to keep in step (see server/clashes.py, which has
    to be parity-tested against its TypeScript twin for precisely that reason).

    AUTH: Supabase bearer token, like every other /app route. Without it this
    is an open Directions proxy billed to her account.
    """
    body = await request.json() if await request.body() else {}
    origin = str(body.get("origin") or "").strip()
    destination = str(body.get("destination") or "").strip()
    if not origin or not destination:
        return JSONResponse({"error": "origin and destination are required"}, status_code=400)

    queries = body.get("queries")
    if not isinstance(queries, list) or not queries:
        queries = [{"mode": "transit"}]
    if len(queries) > route_proxy.MAX_QUERIES:
        return JSONResponse(
            {"error": f"at most {route_proxy.MAX_QUERIES} queries per call"}, status_code=400)

    # One caller, one allowance. A client stuck in a loop cannot spend her
    # Maps quota, and the cache below means the honest case rarely gets near it.
    try:
        rate_limit.check(f"route:{caller['key']}", limit=60, window_s=60.0)
    except rate_limit.RateLimited as exc:
        return JSONResponse({"error": "rate limited"}, status_code=429,
                            headers={"Retry-After": str(exc.retry_after)})

    today = _tz.today_il().isoformat()
    date_iso = str(body.get("date") or today)[:10]
    arrive_by = str(body.get("arrive_by") or "").strip()
    arrival_epoch = None
    if arrive_by:
        arrival_epoch = _tz.epoch_il(date_iso, arrive_by)
        if arrival_epoch is None:
            return JSONResponse(
                {"error": f"could not read {date_iso} {arrive_by} as a time"}, status_code=400)

    results = await route_proxy.directions_batch(
        origin, destination, queries, arrival_epoch,
        ttl=route_proxy.ttl_for(date_iso, today))
    return {"results": results, "date": date_iso, "arrive_by": arrive_by or None}


# Whisper's own ceiling is 25 MB; a spoken task is seconds, and two minutes of
# AAC is about 2 MB. Anything near the cap is a stuck recorder, not a sentence.
STT_MAX_BYTES = 10 * 1024 * 1024


@router.post("/tts")
async def text_to_speech(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Meira's own voice for one SHORT line (8.10 — the first meeting must sound
    native; the phone's engine does not). Body {text, lang?}.

    Returns {id, mime} — the player loads GET /app/tts/<id> — or {error}:
      not_configured 503 — no Google key on the server
      refused        503 — Text-to-Speech is off on the key's project
      provider_failed 502 — Google failed; the app falls back to its own voice
    """
    if not rate_limit.allow(f"tts:{caller['key']}", rate_limit.TTS_LIMIT, rate_limit.TTS_WINDOW_S):
        return JSONResponse({"error": "rate_limited"}, status_code=429)
    body = await request.json() if await request.body() else {}
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    clip_id, reason = await tts.synthesize_id(text, str(body.get("lang") or ""))
    if clip_id:
        return {"id": clip_id, "mime": "audio/mpeg"}
    return JSONResponse({"error": reason}, status_code=502 if reason == "provider_failed" else 503)


@router.get("/tts/{clip_id}")
async def text_to_speech_clip(clip_id: str, caller: dict = Depends(app_auth.require_caller)):
    """The mp3 POST /app/tts made, for the phone's audio player (it streams a URL)."""
    audio = tts.clip(clip_id)
    if not audio:
        return JSONResponse({"error": "expired"}, status_code=404)
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "private, max-age=3600"})


@router.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    hint: str = Form(""),
    caller: dict = Depends(app_auth.require_caller),
):
    """The app's microphone → text, through the SAME Whisper as WhatsApp.

    Multipart: `file` (the recording — the app sends AAC/m4a) and optional
    `hint`, a short vocabulary list (her places, the names on her upcoming
    tasks) that biases Whisper's spelling of words it has never heard.

    Returns {text} or {error, detail}:
      no_speech           200 — nothing was said; ask again
      stt_not_configured  503 — the server has no STT key; the app says so
      provider_failed     502 — Groq refused or timed out; worth one retry
    Never an empty 200 — "nobody spoke" and "we could not listen" are
    different fixes (silent-state rule 1).
    """
    if not rate_limit.allow(f"stt:{caller['key']}", rate_limit.STT_LIMIT,
                            rate_limit.STT_WINDOW_S):
        logger.warning("stt rate limit hit for one account")
        return JSONResponse({"error": "rate_limited", "detail": "too many recordings — wait a moment"},
                            status_code=429,
                            headers={"Retry-After": str(int(rate_limit.STT_WINDOW_S))})

    audio = await file.read(STT_MAX_BYTES + 1)
    if len(audio) > STT_MAX_BYTES:
        return JSONResponse({"error": "too_large", "detail": "recording over 10 MB"}, status_code=413)

    result = await stt.transcribe_detailed(
        audio, file.content_type or "audio/mp4", prompt=hint)
    if result.text:
        return {"text": result.text}
    status = {"no_speech": 200, "stt_not_configured": 503}.get(result.error or "", 502)
    return JSONResponse({"error": result.error, "detail": result.detail}, status_code=status)
