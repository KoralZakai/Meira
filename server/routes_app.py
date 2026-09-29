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
from fastapi.responses import JSONResponse

import app_auth
import checkin_parse
import day_planner
import day_schedule
import geo
import email_events
import meeting_brief
import task_prep
import errands_along
import feedback_store
import profile_extract
import rate_limit
import route_proxy
import stt
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


@router.post("/task/prep")
async def task_prep_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """One task → what to prepare for it, from live search, every item cited.

    Body: {task: {id?, text, category?, date?, time?, location?}, force?: bool}

    Karaoke → songs to practise and where the lyrics are; a clinic → what to
    bring and ask. Returns {ok: true, kind, headline_*, items_*, sources[]} or
    {ok: false, reason} — "nothing_to_prepare" for laundry, and a different
    reason for every way it could fail, so the app never shows an invented card.
    """
    body = await request.json() if await request.body() else {}
    task = body.get("task")
    if not isinstance(task, dict) or not (task.get("text") or "").strip():
        return JSONResponse({"ok": False, "reason": "no_task"}, status_code=400)
    return await task_prep.build(task, caller["key"], force=bool(body.get("force")))


@router.post("/errands/along")
async def errands_along_route(request: Request, caller: dict = Depends(app_auth.require_caller)):
    """An errand with no place → places ON her planned route, open when she passes.

    Body: {task: {text}, trips: [{polyline, leave, arrive, date, label?}]}

    The trips are the journeys the phone already planned (their encoded
    polylines and times) — no position trace, just the lines. Returns
    {ok, query, minutes, candidates:[{name, address, lat, lng, pass_at,
    off_route_m, open_when_passing, maps_url, trip}]} or {ok: false, reason}.
    """
    body = await request.json() if await request.body() else {}
    task = body.get("task") or {}
    trips = body.get("trips") or []
    if not isinstance(task, dict) or not isinstance(trips, list):
        return JSONResponse({"ok": False, "reason": "bad_request"}, status_code=400)
    memory = ""
    try:
        import memory_recall
        memory = (await memory_recall.block_for(caller["key"], task.get("text") or "")) or ""
    except Exception as exc:  # noqa: BLE001 — works without memory
        logger.info("errands_along: memory unavailable (%s)", exc)
    liked = feedback_store.lines(caller["key"], "errand")
    if liked:
        memory = f"{memory}\nHER VERDICTS ON PAST SUGGESTIONS:\n{liked}".strip()
    return await errands_along.along(task.get("text") or "", trips[:3], memory=memory,
                                     user_key=caller["key"])


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
            caller["key"], str(body.get("surface") or ""), str(body.get("verdict") or ""),
            str(body.get("subject") or ""), place_id=body.get("place_id"),
            about=body.get("about"), reason=body.get("reason"))
    except ValueError as exc:
        return JSONResponse({"ok": False, "reason": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001 — say it failed, never "thanks"
        logger.warning("feedback not saved: %s", exc)
        return JSONResponse({"ok": False, "reason": "not_saved"}, status_code=500)
    if v["surface"] == "prep" and v["verdict"] == "down":
        try:
            task_prep.forget(caller["key"], v["subject"])
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

    WHY. The key compiled into the APK is restricted to `com.lumi.app` plus a
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
