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
day_schedule, task_store, tz.
Consumed by main.py (include_router) and by the app's LumiServer client.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

import app_auth
import checkin_parse
import day_schedule
import geo
import email_events
import meeting_brief
import profile_extract
import task_extract
import task_store
import tz as _tz

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/app", tags=["app"])


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


@router.post("/schedule/build")
async def build_schedule(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """Lay a day on a timeline. Deterministic — no model call, no cost, ~1 ms.

    Body: {date?, wake_time?, important_only?, language?, tasks?}
    `tasks` lets the client schedule what it is holding (an unsaved draft, or
    its offline cache); omit it and the server reads the user's saved day.
    """
    body = await request.json() if await request.body() else {}
    date = str(body.get("date") or _tz.today_il().isoformat())[:10]
    wake_time = day_schedule.hhmm(body.get("wake_time")) or "08:00"
    language = "he" if str(body.get("language") or "he").startswith("he") else "en"

    tasks = body.get("tasks")
    if not isinstance(tasks, list):
        tasks = await task_store.fetch_task_rows(caller["key"], date, date)

    now = _tz.now_il().strftime("%H:%M") if date == _tz.today_il().isoformat() else None
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
    body = await request.json() if await request.body() else {}
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    known = body.get("profile") if isinstance(body.get("profile"), dict) else {}
    try:
        return await profile_extract.extract(text, known, phone=caller["key"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("profile extraction unavailable: %s", exc)
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


@router.post("/meeting/brief")
async def meeting_brief_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """One calendar event → a short pre-meeting brief, sourced and cited.

    Body: {event: {id, title, date, time, location?, description?, organizer?,
                   attendees?[], history?[{date, subject, from, snippet}]},
           force?: bool}

    The calendar stays on the phone, exactly like Gmail does: the app reads it
    with the user's own Google token and posts ONE event. No Google credential
    reaches this server.

    `history` is the same bargain for the mailbox: the app searches Gmail for
    messages with ONE named correspondent and posts at most four subjects and
    snippets. It becomes a numbered source like any other, so "you last agreed
    to send the CV" cites its origin exactly as "Ceva makes DSP cores" does.
    Nothing else from the mailbox is sent, and no body text at all.

    Returns {ok: true, headline_he/_en, company_*, person_*, questions_*,
    sources[], confidence} — or {ok: false, reason} when there is nothing worth
    researching ("gym"), search is unconfigured, or nothing was found. A plain
    reason is the point: the app shows no card rather than an invented one.
    """
    body = await request.json() if await request.body() else {}
    event = body.get("event")
    if not isinstance(event, dict) or not (event.get("title") or event.get("description")):
        return JSONResponse({"ok": False, "reason": "no_event"}, status_code=400)
    return await meeting_brief.build(event, caller["key"], force=bool(body.get("force")))


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
