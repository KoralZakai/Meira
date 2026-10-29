"""Lumi-App — WhatsApp webhook (FastAPI + Nebius/Qwen).

Fixes vs the original draft:
- adds a lifespan that opens/closes the asyncpg pool
- GET verify returns the challenge as PlainTextResponse (Meta requires the raw
  challenge string, not JSON) and a real 403 on failure
- guards against missing message payloads and persists the task the agent infers

Dependencies (the whole request pipeline routes through here):
webhook -> dedup -> geo.reverse_geocode (shared locations) -> supabase_tasks
(user/message/task persistence, degrades to in-memory) -> lumi_agent (the
LangGraph brain) -> reminders.schedule_departures (persistent wake/leave
alerts, mirrored to the app via push.py) -> WhatsAppService.send_message ->
judge_service.evaluate (async self-improvement).
"""
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
from typing import Optional

from fastapi import Depends, FastAPI, Request
from fastapi import Response
from fastapi.responses import JSONResponse, PlainTextResponse
from contextlib import asynccontextmanager

import asyncio
import public_pages

import config
import user_store
from user_store import DatabaseService, init_pool, close_pool
from whatsapp_service import WhatsAppService
from lumi_agent import (handle_whatsapp_message, get_graph_diagram,
                        _location_from_departure)
# One turn of the brain, shared by every channel (see server/agent_turn.py).
import agent_turn
import url_safety
import app_auth
import rate_limit
import importlib

import account_deletion
import identity_keys
import secure_store
import user_memory
import phone_links
import supabase_tasks
import task_store
import travel_prefs
import known_places
import provenance
import daychain
from personality_learning_service import PersonalityLearningService
import geo
import user_profile
import reminders
import agents_store
import agent_runner
import session
import llm_usage
import model_router
import conversation
import judge_service
import personality_handoff
import bug_reports
import chat_feedback
import stt
import dedup_service
import routes_app
import mcp_server
import secret_guard
import tz as _tz

logging.basicConfig(level=logging.INFO)
import log_redact  # noqa: E402 — must wrap the handler basicConfig just made
log_redact.install()
logger = logging.getLogger(__name__)


def _encrypt_legacy_stores() -> None:
    """Encrypt any store still sitting in plaintext, once, at boot.

    secure_store's migration strategy is "the next write encrypts it", which
    does nothing at all for a store that is not written often. Checked on the
    live volume on 2026-09-17, with LUMI_DATA_KEY deployed since before then:
    known_places.json was still plaintext and world-readable from 31 August,
    holding a phone number and home/work/gym addresses. So were profiles.json,
    cv_master.json and hr_pending.json. secure_store.rotate() was written for
    exactly this case and called from nowhere.

    Runs before anything serves a request, logs the count and the file NAMES
    only, and never blocks a boot.
    """
    paths = []
    for name in account_deletion._STORE_MODULES:
        try:
            mod = importlib.import_module(name)
        except Exception:  # noqa: BLE001 — a missing store is not a boot failure
            continue
        path = getattr(mod, "_PATH", None)
        if isinstance(path, str):
            paths.append(path)
    # Stores that own no module in _STORE_MODULES but hold personal data all
    # the same. Found by auditing the volume, not by reading the list — which
    # is the only way this kind of thing is ever found.
    for extra in ("pending_mirror.json", "judge_log.json"):
        paths.append(os.path.join(config.DATA_DIR, extra))
    try:
        moved = secure_store.migrate_plaintext(paths)
        if moved:
            logger.warning("secure_store: migrated %d legacy plaintext store(s) at boot", moved)
    except Exception as exc:  # noqa: BLE001
        logger.error("secure_store: boot migration skipped: %s", exc)


def _warn_about_open_doors() -> None:
    """Say, on every boot, which protections are currently switched off.

    A protection that is opt-in and silent is a protection nobody ever turns
    on. Each of these is one `fly secrets set` away, and each was found open
    during the pre-release review rather than by anything the server said about
    itself — which is the actual defect this fixes.

    Never raises and never refuses to boot: a server that will not start is
    worse for the user than one that starts and complains loudly.
    """
    if not config.WHATSAPP_APP_SECRET:
        logger.warning(
            "SECURITY: WHATSAPP_APP_SECRET is not set — POST /webhook/whatsapp "
            "accepts UNSIGNED bodies, so anyone can forge a message from any "
            "number and spend a model turn per request. Rate limits cap the "
            "cost but do not close the door. Get the App Secret from the Meta "
            "dashboard (App settings -> Basic) and: "
            "fly secrets set WHATSAPP_APP_SECRET=..."
        )
    if not config.ADMIN_TOKEN:
        logger.warning(
            "SECURITY: ADMIN_TOKEN is not set — /admin/* and /diag/* refuse "
            "with 503 rather than serving, which is safe but means they are "
            "unusable. fly secrets set ADMIN_TOKEN=$(openssl rand -hex 24)"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown: ready the local user store and run the reminder poller."""
    log_redact.install()   # again: uvicorn attached its handlers after import
    await init_pool()
    _warn_about_open_doors()
    _encrypt_legacy_stores()
    # Persistent reminders survive restarts; this poller fires the due ones.
    reminder_task = asyncio.create_task(reminders.run_reminder_loop())
    logger.info("reminder poller started")
    # User-created agents (agents_store/agent_runner): fired by their own poller.
    agent_task = asyncio.create_task(agent_runner.run_agent_loop())
    # Daily: old conversation/provenance rows out of Supabase, stale pins wiped.
    import privacy
    retention_task = asyncio.create_task(privacy.run_retention_loop())
    # Once: adopt the phone links made before proof was required (phone_links).
    try:
        await phone_links.grandfather()
    except Exception as exc:  # noqa: BLE001 — retried next boot; nobody is linked meanwhile
        logger.error("phone_links grandfather failed: %s", exc)
    yield
    reminder_task.cancel()
    agent_task.cancel()
    retention_task.cancel()
    await close_pool()


# No /docs, /redoc or /openapi.json (8.10): they handed anyone with a browser
# the full map of every door, admin and diag included. The app and MCP clients
# never read them.
app = FastAPI(title="Lumi-App", version="1.0", lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)

# The app's own doors (thin client: capture + schedule). First router in this
# file — everything above it predates the split and moves out gradually.
app.include_router(routes_app.router)
app.include_router(mcp_server.router)
app.include_router(public_pages.router)

# In-memory dedup: WhatsApp retries the same msg_id up to 4× if it thinks we're slow.
# Keep the last 200 processed IDs (tiny memory footprint, clears on restart which is fine).
_seen_msg_ids: set[str] = set()
_seen_msg_ids_order: list[str] = []


@app.get("/health")
async def health():
    """Liveness, and nothing else.

    Until 19.10 this also printed the model tiers and the extraction override to
    anyone who asked. Nothing reads them here — Fly's check, the ship skill and
    the web pinger only look at the status — and an open door is the wrong place
    to publish the server's configuration. Which model each tier points at, and
    whether Nebius serves it, is GET /diag/models (admin token).
    """
    return {"status": "ok"}


def _jwt_role(token: str) -> str:
    """The `role` claim of a Supabase JWT, without verifying or echoing it.

    A service-role key bypasses RLS; an anon key is subject to it. Putting the
    anon key in SUPABASE_SERVICE_ROLE_KEY therefore produces a server that
    connects fine, answers every probe with 200, and sees zero rows forever.
    """
    if not token:
        return "unset"
    try:
        import base64 as _b64
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(_b64.urlsafe_b64decode(payload)).get("role", "unknown")
    except Exception:  # noqa: BLE001 — a malformed key is itself the finding
        return "unparseable"


def _postgrest_count(resp) -> int | str:
    """Total row count out of PostgREST's `Content-Range` header (`0-0/174`).

    Only meaningful when the request carried `Prefer: count=exact`. Returns a
    descriptive string instead of raising, because this only ever feeds a
    diagnostics payload — a broken probe must not 500 the whole endpoint.
    """
    if resp.status_code >= 400:
        return f"http {resp.status_code}: {resp.text[:120]}"
    rng = resp.headers.get("content-range", "")
    total = rng.rsplit("/", 1)[-1] if "/" in rng else ""
    return int(total) if total.isdigit() else f"unparsed content-range: {rng!r}"


@app.get("/diag/sync")
async def diag_sync(request: Request, phone: str | None = None):
    """Why WhatsApp tasks are (or aren't) reaching the app — in one request.

    Four independent things must all hold for a task typed in WhatsApp to show
    up in the mobile app, and when one fails everything downstream fails
    SILENTLY (upsert_task just logs and returns None). This reports each of
    them separately so the broken link is obvious instead of guessed at:

      supabase.enabled     SUPABASE_URL + SERVICE_ROLE_KEY set as Fly secrets
      supabase.reachable   the REST endpoint answers, and `tasks` exists
      supabase.migration3  app_settings."whatsAppPhone" exists (migration 0003)
      dataDir.persistent   DATA_DIR points at the /data volume, not the
                           ephemeral container FS (where every deploy wipes
                           reminders, memory and the pending-mirror queue)
      appSettings.rowCount at least one app_settings ROW exists (the column
                           existing is not enough — an empty table is the
                           failure that hid here for weeks). Compare against
                           appSettings.taskOwners: owners >= 1 with rowCount 0
                           means the app is signed in and only the settings
                           mirror is broken.

    Pass ?phone=<number> to also resolve that phone to a Supabase userId.
    Secrets are never echoed — only whether they are present.
    """
    # SECURITY: discloses Supabase projectRef, key role and row counts.
    if (denied := _require_admin(request)) is not None:
        return denied
    out: dict = {}

    # ── Supabase ──
    enabled = bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY)
    sb: dict = {
        "enabled": enabled,
        "urlSet": bool(config.SUPABASE_URL),
        "serviceRoleKeySet": bool(config.SUPABASE_SERVICE_ROLE_KEY),
        # WHICH project. Not a secret — the same URL ships inside the app — and
        # without it "the app says it wrote 95 tasks, the server sees 0" is
        # unresolvable: two healthy halves pointed at different databases look
        # exactly like one broken half. Compare against the app's
        # EXPO_PUBLIC_SUPABASE_URL; they must be the same ref.
        "projectRef": (config.SUPABASE_URL or "").replace("https://", "").split(".")[0] or None,
        # WHICH ROLE the key carries. This is the difference between "the table
        # is empty" and "RLS is hiding every row from me", and the two are
        # indistinguishable from the outside: an anon key returns 200 OK with an
        # empty array for every query, so `tasksTable: ok` and `rowCount: 0`
        # look identical whether the data is absent or merely invisible.
        # Only the `role` claim is decoded — never the key.
        "keyRole": _jwt_role(config.SUPABASE_SERVICE_ROLE_KEY),
    }
    settings_probe: dict = {"probed": enabled}
    if enabled:
        import httpx
        base = config.SUPABASE_URL.rstrip("/")
        headers = {
            "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {config.SUPABASE_SERVICE_ROLE_KEY}",
        }
        async with httpx.AsyncClient(timeout=8.0) as client:
            try:
                r = await client.get(f"{base}/rest/v1/tasks?select=id&limit=1", headers=headers)
                sb["reachable"] = r.status_code < 500
                sb["tasksTable"] = "ok" if r.status_code == 200 else f"http {r.status_code}: {r.text[:200]}"
            except Exception as exc:  # noqa: BLE001
                sb["reachable"] = False
                sb["tasksTable"] = f"error: {exc}"
            # Selecting a missing column is a 400 from PostgREST regardless of
            # RLS — a clean probe for "was migration 0003 ever applied?".
            try:
                r = await client.get(
                    f'{base}/rest/v1/app_settings?select=whatsAppPhone&limit=1', headers=headers)
                sb["migration3_whatsAppPhone"] = (
                    "ok" if r.status_code == 200 else f"MISSING — http {r.status_code}: {r.text[:200]}")
            except Exception as exc:  # noqa: BLE001
                sb["migration3_whatsAppPhone"] = f"error: {exc}"

            # ── Does any app_settings ROW actually exist? ──
            # The probe above only proves the COLUMN is there. The real failure
            # was an empty TABLE: with no row, user_id_for_phone can never
            # resolve a number, so every WhatsApp task queues forever with no
            # symptom. The service-role key bypasses RLS, so this sees the
            # truth the app itself cannot report.
            for key, query in (
                ("rowCount", "select=userId"),
                ("rowsWithPhone", "select=userId&whatsAppPhone=not.is.null"),
            ):
                try:
                    r = await client.get(
                        f"{base}/rest/v1/app_settings?{query}&limit=1",
                        headers={**headers, "Prefer": "count=exact"},
                    )
                    settings_probe[key] = _postgrest_count(r)
                except Exception as exc:  # noqa: BLE001
                    settings_probe[key] = f"error: {exc}"

            # Who owns the task rows? `taskOwners >= 1` while `rowCount == 0`
            # proves the app IS authenticated and that settings-writing
            # specifically is broken — which is exactly the fork we could not
            # tell apart without holding the phone.
            try:
                r = await client.get(
                    f"{base}/rest/v1/tasks?select=userId&limit=1",
                    headers={**headers, "Prefer": "count=exact"},
                )
                settings_probe["taskRowCount"] = _postgrest_count(r)
                r = await client.get(
                    f"{base}/rest/v1/tasks?select=userId,createdAt"
                    f"&order=createdAt.desc&limit=500",
                    headers=headers,
                )
                rows = r.json() if r.status_code == 200 else []
                settings_probe["taskOwners"] = len(
                    {row.get("userId") for row in rows if row.get("userId")})
                settings_probe["newestTaskAt"] = rows[0].get("createdAt") if rows else None
            except Exception as exc:  # noqa: BLE001
                settings_probe["taskOwners"] = f"error: {exc}"
    out["supabase"] = sb
    out["appSettings"] = settings_probe

    # ── Where the JSON state actually lives ──
    data_dir = os.path.abspath(config.DATA_DIR)
    writable = os.access(data_dir, os.W_OK)
    out["dataDir"] = {
        "path": data_dir,
        "writable": writable,
        # /data is the Fly volume; anything else dies with the container.
        "persistent": data_dir.startswith("/data"),
        "files": sorted(f for f in os.listdir(data_dir))[:25] if writable else [],
    }

    # ── The pending-mirror backlog (tasks queued while unlinked) ──
    try:
        pending = supabase_tasks._load_pending()
        out["pendingMirror"] = {
            "count": len(pending),
            "phones": sorted({str(p.get("phone", "?"))[-4:] for p in pending})[:10],
        }
    except Exception as exc:  # noqa: BLE001
        out["pendingMirror"] = {"error": str(exc)}

    # ── Speech-to-text ──
    # Voice notes silently failed for months against a non-existent Nebius audio
    # endpoint; surface the provider and whether a key is present so a broken
    # STT is visible here instead of only in the user's chat.
    out["stt"] = {
        "configured": stt.is_configured(),
        "provider": config.GROQ_BASE_URL,
        "model": config.STT_MODEL,
    }

    # ── Optional: does this phone resolve to an account? ──
    if phone:
        try:
            uid = await supabase_tasks.user_id_for_phone(phone)
            out["phone"] = {"linked": bool(uid), "tail": phone[-4:]}
        except Exception as exc:  # noqa: BLE001
            out["phone"] = {"linked": False, "error": str(exc)}

    return out


@app.get("/diag/embed")
async def diag_embed(request: Request, text: str = "תור לרופא שיניים"):
    """Is the configured embedding model actually usable from this account?

    Nebius documents only an ENGLISH embedding model, and most Lumi tasks are
    Hebrew — so this reports whether embeddings work AND how the model scores a
    Hebrew pair that word-overlap gets wrong ("תור לשיניים" vs "רופא שיניים"
    share no words and score 0 lexically). If `hebrewPair` is low, the model is
    not suitable and dedup should stay on structured + lexical scoring.
    """
    # SECURITY: discloses model config and burns paid embedding calls.
    if (denied := _require_admin(request)) is not None:
        return denied
    out: dict = {"model": config.EMBED_MODEL, "configured": bool(config.EMBED_MODEL)}
    if not config.EMBED_MODEL:
        out["note"] = "EMBED_MODEL unset — dedup uses structured + lexical scoring"
        return out
    probe = [text, "תור לשיניים", "רופא שיניים", "ראיון עבודה"]
    vectors = await dedup_service.embed_texts(probe)
    if not vectors:
        out["usable"] = False
        out["note"] = "model did not return embeddings — check the id and the key"
        return out
    out["usable"] = True
    out["dimensions"] = len(vectors[0])
    out["hebrewPair"] = round(dedup_service.cosine(vectors[1], vectors[2]), 3)
    out["unrelatedPair"] = round(dedup_service.cosine(vectors[1], vectors[3]), 3)
    out["verdict"] = ("usable for Hebrew" if out["hebrewPair"] > out["unrelatedPair"] + 0.1
                      else "NOT separating Hebrew meaning — keep lexical fallback")
    return out


def _require_admin(request: Request) -> Optional[JSONResponse]:
    """Gate for /admin/*: None when allowed, an error response otherwise.

    These endpoints read bug reports and personal tasks, and /admin/dedup can
    MUTATE tasks with apply=true — all on a public URL with no auth until now.
    An unset ADMIN_TOKEN closes them instead of leaving them open, so a
    forgotten secret fails safe.
    """
    if not config.ADMIN_TOKEN:
        return JSONResponse(
            {"error": "admin API disabled — set ADMIN_TOKEN "
                      "(fly secrets set ADMIN_TOKEN=$(openssl rand -hex 24))"},
            status_code=503,
        )
    supplied = request.headers.get("x-admin-token") or ""
    # Constant-time: this is a bearer secret over a public URL.
    if not secrets.compare_digest(supplied, config.ADMIN_TOKEN):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return None


@app.get("/admin/bugs")
async def admin_list_bugs(request: Request, status: Optional[str] = None):
    """Bug reports, newest first — the Mac agent's inbox."""
    denied = _require_admin(request)
    if denied:
        return denied
    return {"bugs": bug_reports.list_all(status=status)}


@app.get("/admin/bugs/{bug_id}/image")
async def admin_bug_image(request: Request, bug_id: str):
    """The attached screenshot's bytes.

    Fetched here rather than by the agent because the WhatsApp media URL needs
    the business API token, which lives on this server and must not be copied
    onto a laptop.
    """
    denied = _require_admin(request)
    if denied:
        return denied
    rec = bug_reports.get(bug_id)
    if not rec:
        return JSONResponse({"error": "no such bug"}, status_code=404)
    media_id = rec.get("imageMediaId")
    if not media_id:
        return JSONResponse({"error": "no image on this bug"}, status_code=404)
    raw = await WhatsAppService.download_media(media_id)
    if not raw:
        return JSONResponse({"error": "media expired or unavailable"}, status_code=404)
    return Response(content=raw, media_type="image/jpeg")


@app.post("/admin/bugs/{bug_id}")
async def admin_update_bug(request: Request, bug_id: str):
    """Move a bug along, and optionally tell the reporter on WhatsApp.

    Body: {status, note?, issueUrl?, build?, notify?}. `notify` is the message
    text to send; omitted means update silently.
    """
    denied = _require_admin(request)
    if denied:
        return denied
    body = await request.json()
    status = body.get("status")
    rec = bug_reports.set_status(
        bug_id, status,
        note=body.get("note"), issueUrl=body.get("issueUrl"), build=body.get("build"),
    )
    if not rec:
        return JSONResponse({"error": "unknown bug or status"}, status_code=400)
    notify = body.get("notify")
    if notify:
        await WhatsAppService.send_message(rec["phone"], str(notify))
    return {"bug": rec}


@app.get("/admin/dedup")
async def admin_dedup(request: Request, phone: str, days_back: int = 30,
                      days_ahead: int = 60, apply: bool = False):
    """Report (apply=false) or merge (apply=true) duplicate tasks for a phone.

    Defaults to a DRY RUN: the first thing anyone should do is read what it
    would merge. Losers are marked status='moved' with a note naming the
    survivor rather than deleted, so a wrong merge stays recoverable.
    """
    denied = _require_admin(request)
    if denied:
        return denied
    from datetime import timedelta as _td
    from tz import today_il
    uid = await supabase_tasks.user_id_for_phone(phone)
    if not uid:
        return {"error": "phone not linked to an account", "linked": False}
    today = today_il()
    return await dedup_service.dedup_user(
        uid, (today - _td(days=days_back)).isoformat(),
        (today + _td(days=days_ahead)).isoformat(), apply=apply)


@app.get("/debug/graph")
async def debug_graph(request: Request):
    """Returns the LangGraph agent structure as a Mermaid diagram.
    Paste the 'mermaid' value at mermaid.live to see a visual graph."""
    # SECURITY: discloses internal agent/tool structure.
    if (denied := _require_admin(request)) is not None:
        return denied
    return {"mermaid": get_graph_diagram()}


def _client_ip(request: Request) -> str:
    """The caller's address: Fly's proxy puts it in Fly-Client-IP."""
    return (request.headers.get("fly-client-ip")
            or (request.client.host if request.client else "")
            or "unknown")


@app.get("/personality/resolve")
async def resolve_personality_handoff(token: str, request: Request):
    """The app calls this right after opening a lumi://personality?token=... link.

    Open on purpose (the token is the credential), so it is counted per client
    IP: guessing a 256-bit token is hopeless, but each try is a database read.
    """
    if not rate_limit.allow(f"resolve:{_client_ip(request)}", rate_limit.RESOLVE_LIMIT,
                            rate_limit.RESOLVE_WINDOW_S):
        return JSONResponse({"error": "rate_limited"}, status_code=429,
                            headers={"Retry-After": str(int(rate_limit.RESOLVE_WINDOW_S))})
    user_id = await personality_handoff.resolve_handoff(token)
    if not user_id:
        return JSONResponse({"error": "invalid_or_expired"}, status_code=410)
    user = await DatabaseService.get_user_by_id(user_id)
    if not user:
        return JSONResponse({"error": "user_not_found"}, status_code=404)
    return {
        "user_id": user_id,
        "mbti_type": user.get("mbti_type"),
        "mbti_confidence": float(user.get("mbti_confidence") or 0.4),
    }


@app.post("/personality/complete")
async def complete_personality_handoff(request: Request,
                                       caller: dict = Depends(app_auth.require_caller)):
    """The app calls this once the user finishes the quiz, so the WhatsApp side learns it too.

    AUTH: Supabase bearer token required, and the target is the VERIFIED
    caller's own account. `user_id` in the body used to be taken on trust, which
    let anyone overwrite any user's personality profile — the input that shapes
    every prompt Lumi builds for that person. The field is still read for
    backward compatibility, but only to reject a mismatch.
    """
    body = await request.json()
    mbti_type = body.get("mbti_type")
    if not mbti_type or len(mbti_type) != 4:
        return JSONResponse({"error": "a 4-letter mbti_type is required"}, status_code=400)

    claimed = body.get("user_id")
    if claimed and str(claimed) != caller["userId"]:
        return JSONResponse({"error": "cannot set another account's personality"}, status_code=403)

    await DatabaseService.set_mbti(caller["userId"], mbti_type.upper())
    return {"ok": True}


@app.post("/push/register")
async def register_push(request: Request,
                        caller: dict = Depends(app_auth.require_caller)):
    """The mobile app posts its Expo push token so the reminder loop can notify
    the phone (not just send WhatsApp).

    AUTH: Supabase bearer token required, and the phone now comes from the
    VERIFIED identity rather than the request body. Unauthenticated, this was a
    push-hijack primitive: anyone could bind their own Expo token to a
    stranger's number and start receiving that person's reminders — which carry
    task text, times and places. The body's `phone` field is still accepted for
    backward compatibility but is only checked for ownership, never trusted.

    A phone with no local record is still NOT a rejection (that regression cost
    three good tokens in five minutes on 2026-08-31, silently): if Supabase says
    an account has linked the number, the record is created here.
    """
    body = await request.json()
    token = body.get("expo_push_token") or ""
    if not token.startswith("ExponentPushToken"):
        return JSONResponse({"error": "a valid expo_push_token is required"}, status_code=400)

    # Ownership check on the legacy body field, then ignore it.
    app_auth.storage_key_for(caller, body.get("phone"))
    phone = caller.get("phone")
    if not phone:
        return JSONResponse(
            {"error": "link your WhatsApp number in the app before registering for push"},
            status_code=409,
        )

    try:
        matched = await DatabaseService.set_push_token_by_phone(phone, token)
        if not matched:
            # The caller is verified and Supabase already told us this number is
            # theirs (that is where caller['phone'] came from), so create it.
            await DatabaseService.create_user_from_whatsapp(phone)
            matched = await DatabaseService.set_push_token_by_phone(phone, token)
            logger.info("push register created a record for linked number ...%s", phone[-4:])
    except Exception as exc:  # noqa: BLE001 — storage unavailable
        logger.warning("push register failed: %s", exc)
        return JSONResponse({"error": "storage_unavailable"}, status_code=503)
    if not matched:
        return JSONResponse({"error": "storage_unavailable"}, status_code=503)
    return {"ok": True}


def _normalize_task_row(r: dict) -> dict:
    """One canonical wire shape for GET /tasks/{phone}, whatever the store.
    Coerces DB types (date objects, HH:MM:SS times) to the strings the app's
    WhatsAppTaskSync.mapRow expects."""
    fixed = r.get("fixed_time")
    return {
        "id": str(r.get("id", "")),
        "text": r.get("text", ""),
        "category": r.get("category") or "general",
        "priority": r.get("priority") or "need_to",
        "duration_minutes": r.get("duration_minutes") or 30,
        "fixed_time": str(fixed)[:5] if fixed else None,
        "date": str(r.get("date", ""))[:10],
        "status": r.get("status") or "pending",
        **({"location": r["location"]} if r.get("location") else {}),
    }


@app.get("/tasks/{phone}")
async def get_tasks_for_phone(phone: str, caller: dict = Depends(app_auth.require_caller)):
    """Return the tasks Lumi saved from this user's WhatsApp chat so the mobile
    app can merge them in.

    AUTH: Supabase bearer token required. The tasks returned are the CALLER'S,
    resolved from the verified token — `{phone}` is only checked for ownership,
    never used to select the data (see app_auth.storage_key_for).

    Reads through task_store, the one door: Supabase first, the JSON mirror when
    it is unreachable or has not seen this user. This endpoint used to read the
    mirror directly and call it canonical, while every other caller preferred
    Supabase — so the same tasks had two possible answers depending on who
    asked. Ids are the shared UUIDs across both stores, so the app still dedups
    to one task whichever store answered.

    `source` says which one did, because "why is this list stale" is otherwise
    unanswerable from the outside."""
    key = app_auth.storage_key_for(caller, phone)
    rows, source = await task_store.fetch_tasks_with_source(key, include_location=True)
    return {"tasks": [_normalize_task_row(r) for r in rows], "source": source}


@app.post("/agent/chat")
async def agent_chat(request: Request):
    """The APP talking to the same brain WhatsApp talks to.

    Until now the agent had exactly one door — the Twilio webhook — so the app
    could not reach it and shipped its own weaker engine instead (regex intent
    matching, one JSON call, no tools, no memory, no personality). Same model on
    both sides; only one of them was ever an agent. This is the second door.

    Auth is the Supabase access token the app already holds from sign-in,
    verified BY Supabase (app_auth.verify) — never a phone number in the body,
    which anyone knowing the number could send. The verified account is then
    mapped to the linked WhatsApp number so both channels are one person with
    one memory.

    Body: {"message": "...", "here"?: {lat,lng,label}, "mode"?: "voice_plan"}
    Header: Authorization: Bearer <supabase token>
    Returns: {"text", "tasks", "departures"}
    """
    try:
        caller = await app_auth.identify(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)

    # Authentication bounds WHO, never HOW MUCH. Every turn below is a full
    # ReAct loop — up to 15 tool calls on a 235B model — charged to one Nebius
    # account, so a signed-in user in a retry loop is a bill rather than a
    # breach. Keyed on the verified identity, so one noisy account cannot lock
    # anybody else out.
    if not rate_limit.allow(f"chat:{caller['key']}", rate_limit.CHAT_LIMIT,
                            rate_limit.CHAT_WINDOW_S):
        logger.warning("chat rate limit hit for one account")
        return JSONResponse(
            {"error": "too many requests — slow down a moment"},
            status_code=429,
            headers={"Retry-After": str(int(rate_limit.CHAT_WINDOW_S))},
        )

    body = await request.json()
    content = (body.get("message") or "").strip()
    if not content:
        return JSONResponse({"error": "message is required"}, status_code=400)
    _guard = secret_guard.handle(content, he=bool(re.search(r"[\u0590-\u05FF]", content)))
    if _guard:
        return {"text": _guard, "type": "secret_blocked", "tasks": [], "departures": []}

    key = caller["key"]
    # The same user record the WhatsApp path resolves (agent_turn.user_for_caller).
    user, learned = await agent_turn.user_for_caller(caller)

    try:
        result = await agent_turn.run_turn(
            key, content, user, learned, channel="app",
            # Optional, per turn, never stored: {"lat","lng","label"}. The app
            # sends a fix it already holds so "from here" has a here.
            here=body.get("here") if isinstance(body.get("here"), dict) else None,
            # "voice_plan": the app's mic — the planner places times after
            # this turn, so the model must not pin them. Unknown modes ignored.
            mode=body.get("mode") if body.get("mode") in ("voice_plan",) else None,
            # What she set on the Profile screen (transport, home, routines).
            # See agent_turn.sync_app_profile for what is accepted.
            profile=body.get("profile") if isinstance(body.get("profile"), dict) else None,
            # The Meira message she is answering (WhatsApp-style reply). Kept
            # out of `message`, so her own words stay hers to parse.
            reply_to=str(body.get("reply_to") or "").strip()[:1200] or None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("agent_chat failed: %s", exc)
        return JSONResponse({"error": "agent failed"}, status_code=502)

    return result


@app.post("/agent/feedback")
async def agent_feedback(request: Request):
    """👍 / 👎 on one Meira reply (27.10). Who comes from the verified token,
    never the body; texts are capped and location-stripped (chat_feedback)."""
    try:
        caller = await app_auth.identify(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)
    if not rate_limit.allow(f"feedback:{caller['key']}", 60, 3600):
        return JSONResponse({"error": "too many requests"}, status_code=429)
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return JSONResponse({"error": "a JSON object is required"}, status_code=400)
    reaction = body.get("reaction")
    if reaction not in chat_feedback.REACTIONS:
        return JSONResponse({"error": "reaction must be up, down or none"}, status_code=400)
    ok = chat_feedback.record(caller["key"], reaction, str(body.get("reply") or ""),
                              str(body.get("question") or ""), str(body.get("message_id") or ""))
    return {"ok": ok} if ok else JSONResponse({"ok": False, "error": "not stored"}, status_code=503)


@app.get("/admin/chat-feedback")
async def admin_chat_feedback(request: Request, reaction: Optional[str] = None):
    """The reactions, newest first — 👎 ones become golden cases."""
    denied = _require_admin(request)
    if denied:
        return denied
    return {"feedback": chat_feedback.list_all(reaction=reaction)}


@app.get("/admin/chat-feedback/insights")
async def admin_chat_feedback_insights(request: Request):
    """What her 👍/👎 taught: reward per intent, which intents now get the large
    model, and every 👎 as a draft golden case (feedback_learning)."""
    denied = _require_admin(request)
    if denied:
        return denied
    import feedback_learning
    return feedback_learning.report()


@app.get("/usage")
async def get_usage(request: Request):
    """LLM token spend: today + this month, per source, estimated USD at the
    current model's Nebius list price. The Nebius console is the invoice truth."""
    # SECURITY: discloses spend and usage volume.
    if (denied := _require_admin(request)) is not None:
        return denied
    report = llm_usage.summary()
    import user_quota
    import ai_gate
    report["balance"] = ai_gate.balance(fresh=True)
    report["per_person"] = {"daily_requests": user_quota.daily_requests(),
                            "daily_limit_usd": user_quota.daily_limit(),
                            "monthly_limit_usd": user_quota.monthly_limit(),
                            "top": user_quota.top(10)}
    return report


@app.get("/diag/models")
async def diag_models(request: Request):
    """Which model each tier points at, and whether Nebius actually serves it.

    A tier naming a model Nebius does not serve fails EVERY call at that tier —
    and this project's failure mode has always been a silent one, so check here
    after any model rename rather than finding out from an empty reply."""
    if (denied := _require_admin(request)) is not None:
        return denied
    report = await model_router.verify()
    report["defaults"] = model_router.DEFAULT_TIER
    report["budget_usd"] = config.LLM_MONTHLY_BUDGET_USD or None
    return report


# ── Personal agents (agents_store + agent_runner) — the app's Agents screen ──

@app.get("/agents/{phone}")
async def get_agents(phone: str, caller: dict = Depends(app_auth.require_caller)):
    """The user's personal agents + the installable templates (for the gallery).

    AUTH: Supabase bearer token required; lists the CALLER'S agents only."""
    key = app_auth.storage_key_for(caller, phone)
    templates = [
        {"id": tkey, "name": t["name"], "emoji": t["emoji"],
         "soul": t["soul"], "schedule": t["schedule"]}
        for tkey, t in agents_store.TEMPLATES.items()
    ]
    return {"agents": agents_store.list_agents(key),
            "templates": templates, "max": agents_store.MAX_AGENTS}


@app.post("/agents/{phone}")
async def post_agent(phone: str, request: Request,
                     caller: dict = Depends(app_auth.require_caller)):
    """Create an agent. Body: {template} to install a built-in, or
    {name, soul, days, time, emoji?} for a custom one. 409 at the cap.

    AUTH: Supabase bearer token required. This one mattered most of the set —
    unauthenticated, it let anyone create a scheduled agent that would message a
    stranger's WhatsApp on a recurring timer."""
    key = app_auth.storage_key_for(caller, phone)
    body = await request.json()
    agent = agents_store.create_agent(
        key,
        name=body.get("name"), soul=body.get("soul"), days=body.get("days"),
        time=body.get("time"), emoji=body.get("emoji") or "🤖",
        template=body.get("template"), created_via="app")
    if agent.get("error") == "limit":
        return JSONResponse(agent, status_code=409)
    if agent.get("error"):
        return JSONResponse(agent, status_code=400)
    return {"agent": agent}


@app.patch("/agents/{phone}/{agent_id}")
async def patch_agent(phone: str, agent_id: str, request: Request,
                      caller: dict = Depends(app_auth.require_caller)):
    """Partial update: enabled / days / time / soul / name / emoji.

    AUTH: Supabase bearer token required; scoped to the caller's own agents."""
    key = app_auth.storage_key_for(caller, phone)
    body = await request.json()
    agent = agents_store.update_agent(key, agent_id, body)
    if not agent:
        return JSONResponse({"error": "not_found"}, status_code=404)
    return {"agent": agent}


@app.post("/agents/{phone}/{agent_id}/run")
async def run_agent_now(phone: str, agent_id: str,
                        caller: dict = Depends(app_auth.require_caller)):
    """Run one agent NOW, so she sees what it writes without waiting for its
    hour. Does not move its schedule. {ok} or {error: not_found | empty |
    whatsapp_failed | crashed}.

    AUTH: Supabase bearer token required; scoped to the caller's own agents."""
    key = app_auth.storage_key_for(caller, phone)
    agent = agents_store.get_agent(key, agent_id)
    if not agent:
        return JSONResponse({"error": "not_found"}, status_code=404)
    try:
        reason = await agent_runner._run_agent(agent)
    except Exception as exc:  # noqa: BLE001 — say it failed, never 500 silently
        logger.error("agent %s run-now crashed: %s", agent_id, exc)
        return JSONResponse({"error": "crashed"}, status_code=502)
    if reason:
        return JSONResponse({"error": reason}, status_code=502)
    return {"ok": True}


@app.delete("/agents/{phone}/{agent_id}")
async def remove_agent(phone: str, agent_id: str,
                       caller: dict = Depends(app_auth.require_caller)):
    """AUTH: Supabase bearer token required; scoped to the caller's own agents."""
    key = app_auth.storage_key_for(caller, phone)
    if not agents_store.delete_agent(key, agent_id):
        return JSONResponse({"error": "not_found"}, status_code=404)
    return {"ok": True}


def _app_task_to_server(body: dict) -> dict:
    """Map the app's camelCase task JSON to the server's snake_case shape.
    Keeps the app-minted id so both sides share ONE identity key (Phase 1 of
    the shared task store — the app id becomes canonical in user_memory too)."""
    return {
        "id": body.get("id"),
        "text": body.get("text") or body.get("title") or "",
        "category": body.get("category", "general"),
        "priority": body.get("priority", "need_to"),
        "duration_minutes": body.get("durationMinutes") or body.get("duration_minutes") or 30,
        "fixed_time": body.get("fixedTime") or body.get("fixed_time"),
        "date": str(body.get("date") or "")[:10],
        "status": body.get("status", "pending"),
        # The app's own completion stamp, so the mirror writes the moment the
        # user actually ticked rather than the moment the sync happened to run.
        **({"completedAt": body["completedAt"]} if body.get("completedAt") else {}),
        **({"deadline": body.get("deadline")} if body.get("deadline") else {}),
        **({"location": body["location"]} if body.get("location") else {}),
    }


async def _mirror_task_to_supabase(phone: str, task: dict, trust_status: bool = False) -> None:
    """Best-effort Supabase mirror, same as the WhatsApp webhook path.

    `trust_status` is passed through for a push that came from the app, whose
    status is a decision and not a default — see user_memory.add_task."""
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            await supabase_tasks.upsert_task(uid, task, trust_status=trust_status)
        else:
            supabase_tasks.queue_pending(phone, task)
    except Exception as exc:  # noqa: BLE001
        logger.debug("supabase task mirror skipped: %s", exc)


@app.post("/tasks/{phone}")
async def post_task(phone: str, request: Request,
                    caller: dict = Depends(app_auth.require_caller)):
    """The app pushes a task it created/edited into the server's canonical
    store (user_memory) so nudges, agents and reminders can see it.

    AUTH: Supabase bearer token required; the task is written under the
    CALLER'S key, so a token cannot create tasks in someone else's account."""
    key = app_auth.storage_key_for(caller, phone)
    body = await request.json()
    task = _app_task_to_server(body)
    if not task["text"]:
        return JSONResponse({"error": "task text required"}, status_code=400)
    # The app sends the whole task on every edit, so its status is the user's
    # last decision in the UI — not the bare default a chat re-mention carries.
    # Treating the two alike is what resurrected a tick each time she removed
    # one: see server/tests/test_untick_not_resurrected.py.
    stored = user_memory.add_task(key, task, trust_status=True)
    await _mirror_task_to_supabase(key, stored, trust_status=True)
    return {"task": _normalize_task_row(stored)}


@app.patch("/tasks/{phone}/{task_id}")
async def patch_task(phone: str, task_id: str, request: Request,
                     caller: dict = Depends(app_auth.require_caller)):
    """Edit a task the app already pushed. Partial — only sent fields change.

    AUTH: Supabase bearer token required. `task_id` is looked up ONLY within the
    caller's own store, so a guessed id cannot reach another user's task."""
    key = app_auth.storage_key_for(caller, phone)
    body = await request.json()
    patch = {k: v for k, v in _app_task_to_server(body).items()
             if k != "id" and v is not None}
    updated = user_memory.update_task(key, task_id, patch)
    if not updated:
        return JSONResponse({"error": "not_found"}, status_code=404)
    await _mirror_task_to_supabase(key, updated, trust_status=True)
    return {"task": _normalize_task_row(updated)}


@app.delete("/tasks/{phone}/{task_id}")
async def delete_task(phone: str, task_id: str,
                      caller: dict = Depends(app_auth.require_caller)):
    """Soft-delete (status='moved') so the tombstone syncs.

    AUTH: Supabase bearer token required; scoped to the caller's own store."""
    key = app_auth.storage_key_for(caller, phone)
    updated = user_memory.update_task(key, task_id, {"status": "moved"})
    if not updated:
        return JSONResponse({"error": "not_found"}, status_code=404)
    await _mirror_task_to_supabase(key, updated)
    return {"ok": True}


@app.delete("/account")
async def delete_account(caller: dict = Depends(app_auth.require_caller)):
    """Erase the CALLER's account and everything in it. Permanent.

    Google Play has required since 2024 that an app which creates accounts also
    deletes them — in-app and from the web. Lumi had only a sign-out, which
    moves nothing, and the privacy policy promises this.

    There is deliberately NO path parameter. Every other user route takes
    `{phone}` and checks it (app_auth.storage_key_for), which is right for
    reads and writes and wrong for this: a delete endpoint that accepts an
    identifier is one URL away from being pointed at someone else, and the
    blast radius of getting that wrong is a stranger's entire account. The
    caller can only ever delete themselves, because the only identity in play
    comes from the verified token.

    Returns what happened to each store rather than a bare ok, so a partial
    failure is visible instead of being reported as success.
    """
    key = caller["key"]
    # Every key her data may sit under — the account id the agent uses, her
    # phone the app routes used, and the pre-link id — not just one of three.
    result = await account_deletion.erase_account(
        key, caller.get("userId"), extra_keys=identity_keys.all_keys(caller))
    logger.warning("account deletion requested and %s",
                   "completed" if result["ok"] else "INCOMPLETE")
    if not result["ok"]:
        # 207: some of it went. The app must NOT tell the user they are gone.
        return JSONResponse(result, status_code=207)
    return result


@app.get("/admin/links")
async def admin_links(request: Request):
    """Proved WhatsApp ↔ account links, and grandfathered pairs left for review."""
    if (denied := _require_admin(request)) is not None:
        return denied
    return phone_links.summary()


@app.get("/link/verify/{phone}")
async def verify_phone_link(phone: str, caller: dict = Depends(app_auth.require_caller)):
    """Confirm the phone→account link resolves server-side, and flush anything
    queued while it did not.

    AUTH + ANTI-ENUMERATION. This endpoint used to answer "is this number a Lumi
    user?" for ANY number, unauthenticated — a free user-enumeration oracle over
    a public URL. It now answers only "is this number linked to *me*", by
    comparing the resolved owner against the verified caller. A stranger's
    number reports linked:false whether or not they use Lumi, so the endpoint
    can no longer be used to discover who does.
    """
    digits = supabase_tasks._digits(phone)   # noqa: SLF001
    uid = await supabase_tasks.user_id_for_phone(digits) if digits else None
    mine = bool(uid) and uid == caller["userId"]

    flushed = 0
    if mine:
        try:
            flushed = await supabase_tasks.flush_pending(digits)
        except Exception as exc:  # noqa: BLE001
            logger.warning("flush on verify failed: %s", exc)
    return {"linked": mine, "flushed": flushed}


@app.get("/webhook/whatsapp")
async def verify_webhook(request: Request):
    """Meta webhook verification handshake."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if mode == "subscribe" and token and token == config.WHATSAPP_WEBHOOK_VERIFY_TOKEN:
        return PlainTextResponse(content=challenge or "")
    return PlainTextResponse(content="Invalid verification token", status_code=403)


import re as _re

# Deterministic intent detectors — these run in Python, NOT via the LLM, so a
# clear "delete this" / "recompute the route" can never be misunderstood or
# answered with the wrong thing (the LLM was unreliable at both).
# Deleting is destructive, so the trigger has to be a word that can only mean
# deleting. Bare "drop" could not: "icons for סינון drop down" in a list of
# design tasks fired this path, found no single match, and answered a page of
# new work with "Which task should I delete?". "drop" now needs an object
# ("drop the task", "drop it"), which is how anyone actually asks for it.
_DELETE_RE = _re.compile(
    r"\b(delete|remove|cancel)\b|\bdrop\s+(?:the\s+|this\s+|that\s+)?(?:task|it)\b"
    r"|תמחק|למחוק|תבטל|לבטל|בטל|תסיר|להסיר", _re.IGNORECASE)
_ROUTE_RE = _re.compile(
    r"\b(route|directions|how do i get|when.*(leave|train|bus)|recompute|recalculate)\b"
    r"|מסלול|איך.*(מגיע|אגיע)|מתי.*(רכבת|אוטובוס|לצאת)|תחשב|לחשב|מחדש", _re.IGNORECASE)

# Task-cleanup intent (delete duplicates + past-deadline tasks).
_CLEANUP_RE = _re.compile(
    r"\b(clean|cleanup|clear|purge)\s*(up|tasks?|old)?\b|remove\s+(old|past|duplicate)"
    r"|נקה\s*(לי)?\s*(את\s*)?(ה)?משימות|מחק\s*(את\s*)?(ה)?(כפולות|כפולים|ישנות|משימות\s*ישנות)"
    r"|לנקות\s*משימות", _re.IGNORECASE)

_BUS_RE = _re.compile(r"\bbus\b|אוטובוס", _re.IGNORECASE)
# Bare transport-mode words ARE a route request ("רכבת"/"אוטובוס"/"by car") —
# they mean "re-plan the trip this way", the reliable Google path, not the LLM.
_MODE_RE = _re.compile(r"\bbus\b|\btrain\b|\bcar\b|\bbike\b|אוטובוס|רכבת|רכב|אופ", _re.IGNORECASE)
# A short yes/from-home answer to a just-asked route question.
_AFFIRM_RE = _re.compile(r"^\s*(כן|בטח|יאללה|מהבית|בית|yes|sure|yep|ok|home|from home)\b", _re.IGNORECASE)
_BIKE_RE = _re.compile(r"\bbike|bicycle|cycl", _re.IGNORECASE)
_BIKE_RE_HE = _re.compile(r"אופני", _re.IGNORECASE)  # אופניים (not 'באופן')
_CAR_RE = _re.compile(r"\bcar|driv", _re.IGNORECASE)
# Lookaheads matter: 'אוטו' is a PREFIX of 'אוטובוס' (bus) and 'רכב' of 'רכבת'
# (train) — without them "איזה אוטובוס לקחת" planned a CAR route, and every
# train request did too.
_CAR_RE_HE = _re.compile(r"רכב(?!ת)|אוטו(?!בוס)|נהיג", _re.IGNORECASE)


def _digits_only(s: str) -> str:
    return "".join(ch for ch in str(s or "") if ch.isdigit())


# Hebrew stopwords + the word "task" itself — never counted as a match signal.
_STOP = {"את", "של", "זה", "זאת", "הזאת", "הזה", "משימה", "המשימה", "לי", "the",
         "this", "that", "task", "my", "a", "to", "for", "of", "please"}


def _norm_word(w: str) -> str:
    """Strip a Hebrew definite/prepositional prefix so 'הראיון' matches 'ראיון'
    and 'לראיון' matches 'ראיון'. Only for words long enough to keep a stem."""
    w = w.lower()
    if len(w) > 3 and w[0] in "הבלמשוכ":
        return w[1:]
    return w


def _match_score(query: str, text: str) -> int:
    """Meaningful-word overlap between a request and a task text, prefix-aware."""
    qs = {_norm_word(w) for w in _re.findall(r"[^\W_]+", query, _re.UNICODE)
          if len(w) > 1 and w.lower() not in _STOP and not _DELETE_RE.search(w)}
    ts = {_norm_word(w) for w in _re.findall(r"[^\W_]+", text, _re.UNICODE) if len(w) > 1}
    return len(qs & ts)


def _looks_like_a_list(content: str) -> bool:
    """Is this a batch of tasks rather than one instruction?

    A delete request is short and names one thing. A dump of tomorrow's work —
    several lines, or a run of dashes/bullets — is the opposite, and answering
    it with "which one should I delete?" is both wrong and alarming. Counting
    the lines is enough: nobody asks to delete a task across four lines."""
    lines = [l.strip() for l in (content or "").splitlines() if l.strip()]
    if len(lines) >= 3:
        return True
    bullets = _re.findall(r"(?:^|\n)\s*[-–•*]\s+\S", content or "")
    return len(bullets) >= 3


async def _try_delete(phone: str, content: str, lang: str) -> Optional[str]:
    """Delete/cancel the referenced task — but NEVER guess. Deletes only on a
    single confident match; otherwise lists the active tasks and asks which,
    so it can no longer wipe a random task."""
    if not _DELETE_RE.search(content):
        return None
    # A list of things to DO is never a request to delete one of them, however
    # a stray "cancel"/"drop" reads inside it.
    if _looks_like_a_list(content):
        return None
    he = lang == "he"
    tasks = [t for t in user_memory.tasks_for_phone(phone) if t.get("status") not in ("moved", "complete")]
    if not tasks:
        return "אין משימות פעילות למחוק 🙂" if he else "No active tasks to delete 🙂"
    scored = sorted(((_match_score(content, t.get("text", "")), t) for t in tasks),
                    key=lambda x: x[0], reverse=True)
    top_score = scored[0][0]
    winners = [t for s, t in scored if s == top_score and s > 0]
    # Exactly one clear match → delete it. Zero or a tie → ASK, never guess.
    if len(winners) != 1:
        lines = [f"{i + 1}) {t.get('text', '')}" for i, t in enumerate(tasks[:6])]
        ask = ("איזו משימה למחוק? כתבי את השם המדויק:\n" if he
               else "Which task should I delete? Reply with its exact name:\n")
        return ask + "\n".join(lines)
    target = winners[0]
    user_memory.update_task(phone, target["id"], {"status": "moved"})
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            await supabase_tasks.update_task(uid, target["id"], {"status": "moved"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("delete mirror skipped: %s", exc)
    return (f"נמחק ✓ {target.get('text', '')}" if he
            else f"Deleted ✓ {target.get('text', '')}")


def _pending_route(phone: str) -> bool:
    """Did our LAST message ask a route / from-home question? Then a short 'כן' /
    'מהבית' is the go-ahead to plan — not small talk. Looks at the last assistant
    turn only, so an old route chat can't hijack an unrelated 'yes'."""
    hist = conversation.get_history(phone)
    last = next((t.get("content", "") for t in reversed(hist) if t.get("role") == "assistant"), "")
    # Match the QUESTION forms only — not a statement like 'יציאה מהבית עד 10:09',
    # which was making a 'כן' about a prep plan get treated as a route go-ahead.
    return bool(_re.search(
        r"יוצא מביתך|יוצא מהבית\b|מאיפה תצא|מאיפה את יוצאת|how do you want to get|"
        r"from where|from home\?|share your location|רוצה שאחשב מסלול|pick a bus|which bus",
        last, _re.IGNORECASE))


_BARE_NUMBER_RE = _re.compile(r"\s*(?:yes|ok|כן|#|מס['\u05f3]?)?\s*(\d{1,2})\s*[.)]?\s*")


def _bare_number(content: str) -> Optional[int]:
    """The number, if the whole message is essentially just a pick ("3", "כן 3",
    "#3"). None for ordinary text, so real sentences are never hijacked."""
    m = _BARE_NUMBER_RE.fullmatch(content or "")
    return int(m.group(1)) if m else None


def _number_belongs_to(phone: str, content: str) -> Optional[str]:
    """Who owns a bare number reply — 'route', 'hr', or None.

    A bare "3" means nothing by itself; it belongs to whoever asked last. Lumi
    asks several numbered questions (bus options, job shortlists), so the asker
    is recorded when the question is SENT (session.set_pending_choice) and read
    back here. This used to string-match the English prose "Pick a bus" in the
    outgoing text, which silently never matched in Hebrew — so picking a bus
    tailored a CV instead. Language-independent by construction now."""
    number = _bare_number(content)
    if number is None:
        return None
    return session.choice_owner(phone, number)


# "תנדני"/"תנדנדי"/"נדנד" all share the נדנ stem; match it (the strict
# תנדנד missed the colloquial תנדני the user actually types).
_NUDGE_RE = _re.compile(r"תנדנ|נדנ|לנדנ|\bnudge\b|\bpush me\b", _re.IGNORECASE)

# Rotating motivational check-in lines (user-authored style: encourage + a
# little positive pressure). {task} filled per nudge; picked by slot index.
_NUDGE_LINES_HE = [
    "התחלת כבר? קשה להתחיל משימות קשות, אבל ברגע שמתחילים הכל קל יותר 💪",
    "אל תיגרר לסוף השבוע — מאמץ קטן עכשיו ותסיים בראש שקט 🎯",
    "כדאי להתחיל עם משימות ההגשה קודם — הן הכי חשובות 🥇",
    "עוד קצת ואתה שם. קדימה, אתה יודע לעשות את זה 🚀",
    "כל דקה של עבודה עכשיו זו דקה פחות של לחץ אחר כך ⏳",
]
_NUDGE_LINES_EN = [
    "Started yet? Hard tasks are hard to begin — but once you start it gets easy 💪",
    "Don't drag it to the weekend — a little push now and you're done 🎯",
    "Do the submission tasks first — they matter most 🥇",
    "Almost there. Come on, you've got this 🚀",
    "Every minute now is a minute less of stress later ⏳",
]


def _nudge_deadline(phone: str, subject: str) -> Optional[tuple[str, str]]:
    """(task_text, date) of an active task whose text overlaps the nudge
    subject and is due today or later — so the nudge can name the real
    deadline ('ההגשה ל-26.7'). None if no match."""
    from tz import today_il
    today = today_il().isoformat()
    words = {w for w in _re.findall(r"[^\W_]+", subject, _re.UNICODE)
             if len(w) > 1 and w.lower() not in _STOP}
    best = None
    for t in user_memory.tasks_for_phone(phone):
        if t.get("status") in ("moved", "complete"):
            continue
        d = str(t.get("date", ""))
        if d < today:
            continue
        text = str(t.get("text", ""))
        if any(_norm_word(w) in text.lower() for w in words):
            if best is None or d < best[1]:
                best = (text, d)
    return best


async def _try_nudge(phone: str, content: str, lang: str) -> Optional[str]:
    """'תנדני לי לעשות X היום' → schedule 2-3 real check-in reminders NOW,
    deterministically off the message's arrival time, each carrying a
    motivational line + the task's real deadline. Fully in Python — the LLM
    kept reusing stale times from history or skipping the tool entirely."""
    if not _NUDGE_RE.search(content):
        return None
    from tz import now_il
    now = now_il()
    slots = reminders.nudge_slots(now, max_slots=3)  # 2-3 check-ins, not a barrage
    if not slots:
        return None  # late evening — let the agent negotiate tomorrow
    he = lang == "he"
    subject = _NUDGE_RE.sub("", content).strip(" !.,לי ")
    subject = subject or ("המשימה שלך" if he else "your task")
    deadline = _nudge_deadline(phone, subject)
    task_label = deadline[0] if deadline else subject
    lines = _NUDGE_LINES_HE if he else _NUDGE_LINES_EN
    today = now.date().isoformat()

    scheduled = []
    for i, hhmm in enumerate(slots):
        check = (f"👊 התחלת את «{task_label}»? " if he else f"👊 Started «{task_label}»? ")
        text = check + lines[i % len(lines)]
        if reminders.schedule(phone, hhmm, text, day=today, dest_key=f"nudge:{today}"):
            scheduled.append(hhmm)
    if not scheduled:
        return None

    head = ("נדנוד הופעל ✓ אזכיר לך היום ב: " if he else "Nudge mode on ✓ I'll ping you today at: ")
    parts = [head + ", ".join(scheduled)]
    if deadline:
        from datetime import date as _date
        dl = deadline[1]
        try:
            dd = _date.fromisoformat(dl)
            dl = f"{dd.day}.{dd.month}"
        except ValueError:
            pass
        parts.append((f"📅 ההגשה של «{deadline[0]}» ל-{dl} — כדי להגיש בזמן, כדאי להתחיל עכשיו 💪"
                      if he else f"📅 «{deadline[0]}» is due {dl} — best to start now 💪"))
    parts.append("כשתסיים תגיד לי ואפסיק 😊" if he else "Tell me when you're done and I'll stop 😊")
    return "\n".join(parts)


# "תזכירי לי בעוד שעה" / "check on me in 90 minutes" — relative reminders.
_REL_REMIND_RE = _re.compile(
    r"(?:תזכיר|תתזכר|תזכרי|תבדק|תבדקי|נדנד|remind|check|ping)", _re.IGNORECASE)
_REL_DELTA_RE = _re.compile(
    r"(?:בעוד|עוד|in)\s*(\d+)?\s*(שע(?:ה|ות)|דק(?:ה|ות)|hours?|hrs?|minutes?|mins?)",
    _re.IGNORECASE)
# An explicit clock time: "13:00". Bare hours ("ב-13") stay out on purpose —
# they collide with dates ("ב-13.7") and prices.
_ABS_TIME_RE = _re.compile(r"(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])")
# A working RANGE ("בין 13:00 עד 17:00", "13:00-17:00") — those two times say
# when to WORK, not when to be pinged. Removed before times are collected.
_TIME_RANGE_RE = _re.compile(
    r"\d{1,2}:\d{2}\s*(?:עד|ועד|-|–|—|ל-|to|till|until)\s*\d{1,2}:\d{2}",
    _re.IGNORECASE)
# The model's own "✅ נבדוק ב 13:00" line — replaced by ours when we scheduled
# the real thing, so two check-in confirmations never ship together.
_HISTORY_CHECKIN_RE = _re.compile(
    r"(?:נבדוק|אבדוק|נזכיר|אזכיר|תזכורת)\b.*\d{1,2}:\d{2}"
    r"|\bI'?ll check\b.*\d{1,2}:\d{2}", _re.IGNORECASE)
# "למתי ההגשה של X?" / "when is X due" — a question, never a new task.
_DUE_QUERY_RE = _re.compile(
    r"(?:למתי|מתי).*(?:הגשה|דדליין|deadline|צריך|אמור)"
    r"|when.*(?:due|deadline)|what.*deadline", _re.IGNORECASE)


def _reminder_subject(phone: str, content: str, lang: str) -> str:
    """What a check-in reminder is ABOUT. Only TODAY-or-future active tasks are
    eligible (a stale July task must never be the subject — that's the bug where
    'remind me 17:30 to leave' for tonight's party got attached to an old class).
    Prefer today's tasks, then strongest word overlap, then the soonest hour."""
    from tz import today_il
    today = today_il().isoformat()
    tasks = [t for t in user_memory.tasks_for_phone(phone)
             if t.get("status") not in ("moved", "complete")
             and str(t.get("date", "")) >= today]
    if not tasks:
        return "המשימה שלך" if lang == "he" else "your task"
    # Conversation focus first: a 'remind me' right after planning a task is
    # about THAT task, not whatever else overlaps the words.
    active_id = session.get_active_task_id(phone)
    if active_id:
        focus = next((t for t in tasks if t.get("id") == active_id), None)
        if focus:
            return str(focus.get("text") or (lang == "he" and "המשימה שלך") or "your task")
    same_day = [t for t in tasks if str(t.get("date", "")) == today]
    pool = same_day or tasks
    scored = max(pool, key=lambda t: (_match_score(content, t.get("text", "")),
                                      -_date_time_key(t)))
    return str(scored.get("text") or pool[0].get("text", ""))


def _date_time_key(t: dict) -> float:
    """Sort key: earlier date+time = smaller. Used to prefer the soonest task."""
    d = str(t.get("date", "9999-12-31"))
    tm = str(t.get("fixed_time") or "23:59")[:5]
    try:
        return int(d.replace("-", "")) * 10000 + int(tm.replace(":", ""))
    except ValueError:
        return 9e12


def _checkin_text(subject: str, lang: str) -> str:
    return (f"👊 {subject} — התחלת? איך מתקדם?" if lang == "he"
            else f"👊 {subject} — started? how's it going?")


# "תעירי אותי ב-7 בבוקר" / "wake me at 7". The mirror of src/utils/wakeRequest.ts
# — the same instruction has to work in both places, because the phone alarm is
# armed by the APP and the request usually arrives over WhatsApp.
_WAKE_ASK_RE = _re.compile(
    r"wake me( up)?|set an alarm|alarm for|תעיר[יני]? אותי|להעיר אותי|תעורר[יי]? אותי|שעון מעורר|תעירי",
    _re.IGNORECASE)


def _wake_request(content: str) -> Optional[str]:
    """The hour she asked to be woken at (HH:MM), or None.

    Taken from the part of the sentence that does the ASKING: "תעירי אותי ב-7,
    הראיון ב-13:00" is 07:00 and never 13:00."""
    ask = _WAKE_ASK_RE.search(content or "")
    if not ask:
        return None
    tail = content[ask.start():]
    explicit = _re.search(r"(\d{1,2}):(\d{2})", tail)
    bare = _re.search(r"(?:\bat\b|\bfor\b|בשעה|ב-|ב\s|ב(?=\d))\s*(\d{1,2})(?!\d|:)", tail,
                      _re.IGNORECASE)
    e_at = explicit.start() if explicit else 10 ** 6
    b_at = bare.start() if bare else 10 ** 6
    if explicit and e_at <= b_at:
        h, m = int(explicit.group(1)), int(explicit.group(2))
        if h <= 23 and m <= 59:
            return f"{h:02d}:{m:02d}"
    if not bare:
        return None
    hour = int(bare.group(1))
    if hour > 23:
        return None
    evening = bool(_re.search(r"\bpm\b|tonight|evening|בערב|בלילה", tail, _re.IGNORECASE))
    morning = bool(_re.search(r"\bam\b|morning|בבוקר", tail, _re.IGNORECASE))
    if evening and not morning and hour < 12:
        hour += 12
    return f"{hour:02d}:00"


def _apply_wake_request(phone: str, content: str, tasks: list) -> Optional[str]:
    """Stamp an explicitly requested wake time onto the task the morning is
    about, so the app arms a REAL phone alarm for it.

    The app reads Task.alarmAt first when deciding an alarm, and until now
    nothing wrote it — over WhatsApp the request became a chat reminder, which
    pings but does not ring. Returns the hour it stamped, for the reply."""
    at = _wake_request(content)
    if not at:
        return None
    candidates = [t for t in (tasks or []) if t.get("id")]
    if not candidates:
        active = session.get_active_task_id(phone)
        candidates = [t for t in user_memory.tasks_for_phone(phone) if t.get("id") == active]
    if not candidates:
        return None
    # The earliest timed task of the batch — the one the morning is for.
    candidates.sort(key=lambda t: f"{t.get('date', '')} {t.get('fixed_time') or '99:99'}")
    target = candidates[0]
    user_memory.update_task(phone, target["id"], {"alarmAt": at, "alarmState": "planned"})
    return at


async def _try_relative_reminder(phone: str, content: str, lang: str) -> Optional[str]:
    """Check-in requests, scheduled in PYTHON off the message's arrival time —
    never by the model, which confirmed reminders it never created.

    Two shapes, both requiring a check/remind verb:
      relative — 'תזכירי לי בעוד שעה' / 'check on me in 90 minutes'
      absolute — 'תבדקי אותי ב 13:00 וב 14:00' (any number of times, max 4)

    A working RANGE in the message ('בין 13:00 עד 17:00 — תבדקי אותי ב 13:00')
    is stripped first: those hours say when to WORK, not when to be pinged.
    """
    if not _REL_REMIND_RE.search(content):
        return None
    from datetime import timedelta as _td2
    from tz import now_il
    now = now_il()
    he = lang == "he"
    subject = _reminder_subject(phone, content, lang)

    delta = _REL_DELTA_RE.search(content)
    if delta:
        qty = int(delta.group(1)) if delta.group(1) else 1
        minutes = qty * (60 if delta.group(2).lower().startswith(("שע", "hour", "hr")) else 1)
        if not 1 <= minutes <= 24 * 60:
            return None
        whens = [now + _td2(minutes=minutes)]
    else:
        # Only times stated AFTER the verb count — a message can open with the
        # work window ('בין 13:00 עד 17:00') and ask for pings later on.
        tail = content[_REL_REMIND_RE.search(content).start():]
        tail = _TIME_RANGE_RE.sub(" ", tail)
        hhmm = list(dict.fromkeys(f"{int(h):02d}:{m}" for h, m in _ABS_TIME_RE.findall(tail)))[:4]
        if not hhmm:
            return None
        whens = [now.replace(hour=int(t[:2]), minute=int(t[3:]), second=0, microsecond=0)
                 for t in hhmm]

    text = _checkin_text(subject, lang)
    scheduled, missed = [], []
    for when in whens:
        if reminders.schedule(phone, when.strftime("%H:%M"), text,
                              day=when.date().isoformat()):
            scheduled.append(when.strftime("%H:%M"))
        elif when <= now:
            missed.append(when.strftime("%H:%M"))
    if not scheduled:
        # Everything asked for is already in the past — say so honestly rather
        # than silently handing a doomed request to the model.
        if missed:
            return (f"⏰ {', '.join(missed)} כבר עבר — תגידי לי שעה אחרת ואזכיר 🙏" if he
                    else f"⏰ {', '.join(missed)} already passed — give me another time 🙏")
        return None
    head = (f"סגור ✓ אבדוק אותך ב-{', '.join(scheduled)} לגבי «{subject}» 👊" if he
            else f"Done ✓ I'll check in at {', '.join(scheduled)} about «{subject}» 👊")
    if missed:
        head += (f"\n({', '.join(missed)} כבר עבר)" if he
                 else f"\n({', '.join(missed)} already passed)")
    return head


async def _try_due_query(phone: str, content: str, lang: str) -> Optional[str]:
    """'למתי ההגשה של DDP?' → answer straight from the stored task. A question
    about an existing task must never create one or trigger the LLM."""
    if not _DUE_QUERY_RE.search(content):
        return None
    tasks = [t for t in user_memory.tasks_for_phone(phone)
             if t.get("status") not in ("moved", "complete")]
    if not tasks:
        return None
    scored = sorted(((_match_score(content, t.get("text", "")), t) for t in tasks),
                    key=lambda x: x[0], reverse=True)
    top, task = scored[0]
    if top == 0:
        return None  # no clear subject — let the agent ask
    when = task.get("deadline") or task.get("date") or ""
    try:
        from datetime import date as _d
        dd = _d.fromisoformat(str(when)[:10])
        when = f"{dd.day}.{dd.month}"
    except ValueError:
        pass
    he = lang == "he"
    line = (f"📅 «{task.get('text','')}» — ל-{when}" if he
            else f"📅 «{task.get('text','')}» — due {when}")
    if task.get("fixed_time"):
        line += f" ({str(task['fixed_time'])[:5]})"
    return line


def _override_task_date(task: dict, content: str) -> dict:      # noqa: D401
    """Thin alias — the implementation moved to agent_turn so both channels
    share it. Kept because the route fast-paths above still call it."""
    return agent_turn.override_task_date(task, content)


def _override_task_date_unused(task: dict, content: str) -> dict:
    """Force a task's date to the deterministically-resolved one when the user's
    message carries exactly ONE relative-date expression ('מחר', 'in 2 days',
    '27.7').

    The model skips calculate_date and invents dates — it wrote 24.7 for the day
    after 26.7, which stored the doctor appointment IN THE PAST, so every
    `date >= today` path (route planner, reminders, the app's day view) dropped
    it silently. Exactly-one-expression keeps multi-date day-planning messages
    ('tomorrow X, Thursday Y') on the model's per-task dates.
    """
    matches = _re.findall(_tz.REL_DATE_RE, content or "")
    if len(matches) != 1:
        return task
    resolved = _tz.resolve_date(matches[0])
    if not resolved or task.get("date") == resolved.isoformat():
        return task
    logger.warning("task date corrected %s -> %s (from %r)",
                   task.get("date"), resolved.isoformat(), matches[0])
    return {**task, "date": resolved.isoformat()}


_WALK_RE = _re.compile(r"\bwalk|on foot|by foot|ברגל|\bרגל\b|הליכה|ללכת", _re.IGNORECASE)


def _has_travel_mode(content: str) -> bool:
    """True if the message names HOW to travel (so we can plan); False means we
    should ask first instead of defaulting to a mode."""
    return bool(_MODE_RE.search(content) or _WALK_RE.search(content)
                or _CAR_RE.search(content) or _CAR_RE_HE.search(content)
                or _BIKE_RE_HE.search(content))


def _route_mode(content: str) -> tuple[str, Optional[str]]:
    """Which travel mode the message asks for -> (geo transport, format pref).
    Default is rail, because format_route_message then offers the bus options
    too and lets the user pick."""
    if _CAR_RE.search(content) or _CAR_RE_HE.search(content):
        return "car", None
    if _BIKE_RE.search(content) or _BIKE_RE_HE.search(content):
        return "bike", None
    if _WALK_RE.search(content):
        return "walk", None
    if _BUS_RE.search(content):
        return "bus", "bus"
    return "train", "rail"


def _ask_travel_mode(task: dict, lang: str) -> dict:
    """A 'how do you want to get there?' block — the 5 modes as tappable text —
    returned instead of planning when the user hasn't chosen a mode yet."""
    name = str(task.get("text", ""))[:40]
    if lang == "he":
        q = (f"איך תרצי להגיע ל«{name}»?\n"
             "🚌 אוטובוס · 🚆 רכבת · 🚲 אופניים · 🚶 רגל · 🚗 רכב\n"
             "כתבי את האמצעי ואחשב מסלול מדויק עם שעת יציאה.")
    else:
        q = (f"How do you want to get to “{name}”?\n"
             "🚌 bus · 🚆 train · 🚲 bike · 🚶 walk · 🚗 car\n"
             "Tell me the mode and I'll plan exact departure times.")
    return {"text": q, "departures": [], "ask_mode": True}


async def _route_for_task(phone: str, task: dict, content: str, lang: str,
                          origin: Optional[str] = None) -> Optional[dict]:
    """REAL Google route for ONE located + time-fixed task.

    `origin` is where the trip starts — the previous commitment when a message
    creates several trips, home otherwise. Routing every trip from home is what
    made a second appointment claim a departure time it could not possibly
    make: you are not at home at 20:00, you are at the 19:00 thing.

    Returns {text, departures} — the deterministic block the user sees — or None
    when this task simply isn't routable (no home / no address / no hour). On a
    routing FAILURE it returns an honest line instead of None, so the reply never
    falls back to the model inventing 'no transit routes found'.
    """
    prof = user_profile.get_profile(phone)
    home = origin or prof.get("homeAddress")
    loc = task.get("location")
    dest = loc if isinstance(loc, str) else ((loc or {}).get("address")
                                             or (loc or {}).get("displayName"))
    # No address in the message? She may have given one for this activity
    # before. "yoga class at 11:00" should not become a task with no place
    # just because she already told us where yoga is.
    recalled = ""
    if not dest:
        try:
            known = known_places.resolve(phone, task.get("text", ""))
        except Exception:  # noqa: BLE001 — recall must never block the reply
            known = None
        if known:
            dest = known["address"]
            task["location"] = dest
            recalled = known_places.recall_line(dest, lang)
    if not (home and dest and task.get("fixed_time")):
        return None
    # This task is now the conversation focus — so the mode reply ('from home, by
    # bus') and any 'remind me' that follows resolve to IT, not the soonest event.
    session.set_active_task(phone, task.get("id"), dest)
    # How does she get there? Three sources, in order of how much they know.
    assumed = ""
    if _has_travel_mode(content):
        # 1. She said so in this message — the strongest signal, and worth
        #    remembering so the next trip to this place needs no question.
        mode, pref = _route_mode(content)
        try:
            travel_prefs.remember(phone, mode, dest, task.get("category"))
        except Exception:  # noqa: BLE001 — learning must never block a route
            logger.debug("travel pref not recorded for %s", dest)
    else:
        # 2. She has told us before, for this place or this kind of place.
        #    Asking the first time is caution; asking the fifth is forgetting,
        #    and while we ask there is no route, no leave time and no alarm.
        learned = None
        try:
            learned = travel_prefs.preferred(phone, dest, task.get("category"))
        except Exception:  # noqa: BLE001
            learned = None
        if not learned:
            # 3. Nothing known — ask, rather than guess a leave time that is
            #    confidently wrong for someone who cycles.
            return _ask_travel_mode(task, lang)
        mode = learned
        pref = "bus" if learned == "bus" else ("rail" if learned == "train" else None)
        # Said out loud every time: a remembered mode that is wrong must cost
        # one correction, not a missed alarm.
        assumed = travel_prefs.assumption_line(learned, lang)
    # Interviews: plan to ARRIVE 30 min early (10:30 for an 11:00 interview) —
    # not just a "be early" note on a route that still targets the start time.
    is_interview = bool(_re.search(r"interview|ראיון", str(task.get("text", "")), _re.IGNORECASE))
    arrival = str(task["fixed_time"])[:5]
    if is_interview:
        h, m = int(arrival[:2]), int(arrival[3:5])
        total = (h * 60 + m - 30) % (24 * 60)
        arrival = f"{total // 60:02d}:{total % 60:02d}"
    result = await geo.plan_departure(
        destination=dest,
        arrival_hhmm=arrival,
        home_address=home,
        transport=mode,
        routine_minutes=prof.get("morningRoutineMinutes", 45),
        buffer_minutes=prof.get("wakeBufferMinutes", 10),
    )
    if not result.get("ok"):
        return {"text": (f"לא הצלחתי לתכנן מסלול ל«{dest}» 🙏 אפשר כתובת מדויקת יותר?"
                         if lang == "he" else
                         f"I couldn't plan a route to “{dest}” 🙏 Can you give a more exact address?"),
                "departures": []}
    plan = result["plan"]
    from tz import today_il
    plan["date"] = task.get("date") or today_il().isoformat()
    # Say WHERE this was planned from. The app decides whether to re-plan a
    # trip by comparing transitPlan.originAddress against the previous stop in
    # the day's chain; with the field absent it fell back to ASSUMING the plan
    # started at home. That assumption happens to be true here — the server
    # always routes from the profile's home address — but leaving it implicit
    # means the two brains agree by luck. Recording it makes the comparison a
    # fact, and lets the app correctly re-plan when the chain really does start
    # somewhere else.
    plan["originAddress"] = home
    # This activity happens HERE. Learned only once a route actually resolved,
    # so a typo'd address that Google could not find is never remembered as
    # where she does this. Google's resolved form is preferred over her typing
    # — it is what geocodes cleanly next time.
    try:
        known_places.remember(phone, task.get("text", ""),
                              plan.get("destResolved") or dest,
                              plan.get("lat"), plan.get("lng"))
    except Exception:  # noqa: BLE001 — learning is never worth a failed reply
        logger.debug("place not recorded for %s", dest)
    # Remember the choice + plan ON the task (session-like): survives restarts,
    # lets briefings show the leave time, and avoids re-asking the mode.
    if task.get("id"):
        try:
            user_memory.update_task(phone, task["id"], {"route": {
                "mode": mode, "modeLabel": plan.get("modeLabel"),
                "leaveHomeBy": plan.get("leaveHomeBy"), "wakeUpBy": plan.get("wakeUpBy"),
                "arriveBy": plan.get("arriveBy"), "routeText": plan.get("routeText"),
                "date": plan.get("date")}})
        except Exception:  # noqa: BLE001 — persistence is a bonus, never block the route
            logger.debug("route persist skipped for task %s", task.get("id"))
    is_interview = bool(_re.search(r"interview|ראיון", str(task.get("text", "")), _re.IGNORECASE))
    # How many numbered options got rendered — recorded by the caller as the open
    # "pick 1-N" question, so a bare number reply resolves to the ride and not to
    # an HR job pick. Counted here rather than parsed out of the translated text.
    option_count: list = []
    rendered_options: list = []
    if pref:  # transit → multi-option block (trains + "want buses too?")
        text = geo.format_route_message(plan, pref=pref, is_interview=is_interview,
                                        lang=lang, counter=option_count,
                                        out_options=rendered_options)
    else:  # car / bike → single direct line
        emoji = {"car": "🚗", "bike": "🚲", "walk": "🚶"}.get(mode, "🚲")
        if lang == "he":
            ride = {"car": "נסיעה", "bike": "רכיבה", "walk": "הליכה"}.get(mode, "רכיבה")
        else:
            ride = {"car": "drive", "bike": "ride", "walk": "walk"}.get(mode, "ride")
        text = (f"{emoji} {dest}\n"
                f"🚪 {'לצאת עד' if lang == 'he' else 'Leave by'} {plan.get('leaveHomeBy')} "
                f"({plan.get('travelMinutes')} {'דק׳ ' + ride if lang == 'he' else 'min ' + ride})\n"
                f"📍 {'הגעה עד' if lang == 'he' else 'Arrive by'} {plan.get('arriveBy')}")
    # Name the assumption when the mode came from memory rather than from this
    # message. Silent remembering is indistinguishable from guessing, and a
    # wrong guess here is a wrong wake-up time.
    for line in (recalled, assumed):
        if line:
            text = f"{line}\n{text}"
    return {
        "text": text,
        "departures": [plan],
        "optionCount": option_count[0] if option_count else 0,
        # The numbered rides themselves, plus the little of the plan a pick
        # needs to become a real departure (where to, which day, whether the
        # wake time applies). Stored with the pending choice so answering "2"
        # schedules THAT train instead of being handed to the model.
        "options": rendered_options,
        "planHead": {
            "destination": plan.get("destination"),
            "destResolved": plan.get("destResolved"),
            "date": plan.get("date"),
            "routineMinutes": plan.get("routineMinutes") or 0,
            "fromHome": bool(plan.get("fromHome")),
            "taskId": task.get("id"),
            "isInterview": is_interview,
        },
    }


async def _rechain_day(phone: str, dates: set, lang: str) -> int:
    """Re-plan EXISTING trips whose origin shifted, across the whole day.

    The per-message loop routes the trips a message creates. This is the other
    half of one brain: when a task is added, moved or completed, the LEAVE TIMES
    of the day's other trips change, because each starts where the previous one
    ended. daychain decides order and which legs are stale; this does the Google
    fetch and persistence for those, and nothing else — an unchanged origin is
    never re-fetched, so a message costs at most a few route calls, usually zero.

    Silent by design: it never asks how she travels. A trip is re-planned only
    when its mode is already known — from travel_prefs, learned earlier — so the
    day re-chains without a burst of "how will you get there?" questions.
    """
    prof = user_profile.get_profile(phone)
    home = prof.get("homeAddress")
    if not home:
        return 0
    tasks = user_memory.tasks_for_phone(phone)
    uid = None
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
    except Exception:  # noqa: BLE001
        uid = None
    replanned = 0
    for date in dates:
        for task, origin in daychain.day_chain(tasks, home, date):
            if not daychain.needs_replan(task, origin, home):
                continue
            mode = travel_prefs.preferred(phone, daychain.address_of(task),
                                          task.get("category"))
            if not mode:
                continue  # unknown mode — its own message flow will ask
            try:
                start = None if origin == home else origin
                result = await geo.plan_departure(
                    destination=daychain.address_of(task),
                    arrival_hhmm=str(task["fixed_time"])[:5],
                    home_address=home,
                    transport=mode,
                    routine_minutes=prof.get("morningRoutineMinutes", 45),
                    buffer_minutes=prof.get("wakeBufferMinutes", 10),
                    start_address=start,
                )
                if not result.get("ok"):
                    continue
                plan = result["plan"]
                plan["date"] = task.get("date")
                plan["originAddress"] = origin
                location = _location_from_departure(plan)
                user_memory.update_task(phone, task["id"], {"location": location})
                if uid:
                    await supabase_tasks.update_task(uid, task["id"], {"location": location})
                else:
                    supabase_tasks.queue_pending(phone, {**task, "location": location})
                replanned += 1
            except Exception as exc:  # noqa: BLE001 — one bad leg never blocks the rest
                logger.warning("re-chain leg failed for %s: %s", task.get("id"), exc)
    if replanned:
        logger.info("re-chained %d trip(s) across %s", replanned, sorted(dates))
    return replanned


_OPTION_PICK_RE = _re.compile(
    r"(?:^|\W)(?:option|opt|choice|אפשרות|אופציה|מספר)\s*#?\s*(\d{1,2})\b", _re.IGNORECASE)


def _picked_option(content: str) -> Optional[int]:
    """The ride she picked, from any of the ways people actually answer.

    "2" was the only form that ever worked, and only when the whole message was
    that digit. The real replies were "option 2", "אני רוצה את זה - Option 2:"
    (the quoted block pasted back), "רכבת אופציה 3" — every one of which fell
    through to the model. Matching the word "option/אפשרות" plus a number is
    unambiguous even inside a long quote, and the bare digit still counts."""
    named = _OPTION_PICK_RE.search(content or "")
    if named:
        return int(named.group(1))
    return _bare_number(content)


def _option_button_title(option: dict, index: int, lang: str) -> str:
    """A button caption that says WHICH ride — 20 characters, WhatsApp's cap.

    "Option 1 / 2 / 3" alone would make her scroll back up to see which train
    that was, so the departure time rides along: "אפשרות 2 · 10:51"."""
    when = option.get("departAt") or option.get("leaveBy") or ""
    label = f"{'אפשרות' if lang == 'he' else 'Option'} {index}"
    return f"{label} · {when}"[:20] if when else label


def _option_departure(option: dict, head: dict) -> dict:
    """Turn one rendered ride into a departure the reminder scheduler accepts.

    schedule_departures supersedes anything pending for the same destination and
    day, so scheduling the PICKED ride replaces the auto-scheduled fastest one
    rather than piling a second alarm on top."""
    leave_by = option.get("leaveBy") or ""
    routine = int(head.get("routineMinutes") or 0)
    return {
        "destination": head.get("destination"),
        "destResolved": head.get("destResolved"),
        "date": head.get("date"),
        "leaveHomeBy": leave_by,
        "wakeUpBy": (geo._sub_minutes(leave_by, routine)
                     if head.get("fromHome") and leave_by and routine else None),
        "arriveBy": option.get("arriveAt"),
        "travelMinutes": option.get("minutes"),
        "overviewPolyline": option.get("overviewPolyline"),
    }


def _confirm_pick_text(option: dict, head: dict, lang: str) -> str:
    """Short, factual confirmation of the ride she chose."""
    he = lang == "he"
    dep = _option_departure(option, head)
    legs = [l for l in (option.get("legs") or []) if (l.get("type") or "").lower() != "walk"]
    line = (legs[0].get("line") or "") if legs else ""
    ride = ("רכבת" if geo._vehicle_of(option) in ("train", "subway") else "אוטובוס") if he \
        else ("train" if geo._vehicle_of(option) in ("train", "subway") else "bus")
    parts = []
    if dep.get("wakeUpBy"):
        parts.append(f"⏰ {'להתעורר' if he else 'Wake'} {dep['wakeUpBy']}")
    if dep.get("leaveHomeBy"):
        parts.append(f"🚪 {'לצאת' if he else 'Leave'} {dep['leaveHomeBy']}")
    if option.get("departAt"):
        parts.append(f"{'🚆' if 'רכבת' in ride or ride == 'train' else '🚌'} {ride} {line} {option['departAt']}".strip())
    if dep.get("arriveBy"):
        parts.append(f"📍 {'הגעה' if he else 'Arrive'} {dep['arriveBy']}")
    head_line = ("✓ נקבע — " if he else "✓ Locked in — ") + " · ".join(parts)
    tail = ("\n⏰ תזכורות היקיצה והיציאה נשמרו." if he
            else "\nWake + leave reminders saved.")
    return head_line + tail


async def _confirm_route_pick(phone: str, number: int, lang: str) -> Optional[str]:
    """Honour "option 2" against the options we actually printed.

    Returns the confirmation text, or None when there is no open ride question
    (so every other numbered reply keeps its existing behaviour)."""
    choice = session.get_pending_choice(phone)
    if not choice or choice.get("owner") != "route":
        return None
    options = choice.get("options") or []
    head = choice.get("context") or {}
    if not (1 <= number <= len(options)):
        return None
    option = options[number - 1]
    dep = _option_departure(option, head)
    try:
        reminders.schedule_departures(phone, [dep], lang)
    except Exception as exc:  # noqa: BLE001 — a failed alarm must still confirm honestly
        logger.warning("pick reminders failed: %s", exc)
        return ("בחרתי את האפשרות, אבל לא הצלחתי לשמור תזכורת 🙏"
                if lang == "he" else
                "Picked that option, but I couldn't save the reminder 🙏")
    # Keep the chosen ride ON the task, so a briefing and the app show the
    # times she picked rather than the fastest option we defaulted to.
    if head.get("taskId"):
        try:
            user_memory.update_task(phone, head["taskId"], {"route": {
                "leaveHomeBy": dep.get("leaveHomeBy"), "wakeUpBy": dep.get("wakeUpBy"),
                "arriveBy": dep.get("arriveBy"), "date": dep.get("date"),
                "pickedOption": number}})
        except Exception:  # noqa: BLE001
            logger.debug("pick not persisted for task %s", head.get("taskId"))
    session.clear_pending_choice(phone)
    return _confirm_pick_text(option, head, lang)


async def _try_route(phone: str, content: str, lang: str) -> Optional[dict]:
    """Compute a REAL route for the referenced located+timed task, from home,
    deterministically (the LLM often skips the tool). Returns
    {text, departures} when handled, else None."""
    # Fire on an explicit route ask, a bare transport-mode word ("רכבת"), OR a
    # short affirmative right after we asked "from home / plan the route?" — the
    # confirmation turn ("כן"/"מהבית") carries no route keyword but IS the go-ahead,
    # and routing it to the LLM produced the empty "מסלול מומלץ:" reply.
    if not (_ROUTE_RE.search(content) or _MODE_RE.search(content)
            or (_AFFIRM_RE.search(content) and _pending_route(phone))):
        return None
    prof = user_profile.get_profile(phone)
    home = prof.get("homeAddress")
    if not home:
        return None  # no home → let the agent ask for it
    from tz import today_il
    today = today_il().isoformat()
    # Pick the referenced task: word-overlap, else the soonest upcoming
    # located+timed task.
    located = [t for t in user_memory.tasks_for_phone(phone)
               if t.get("status") not in ("moved", "complete")
               and (t.get("location") or "") and t.get("fixed_time")
               and str(t.get("date", "")) >= today]
    if not located:
        return None
    # Referenced task: Hebrew-aware word overlap, else the soonest one.
    located.sort(key=lambda t: (-_match_score(content, t.get("text", "")),
                                str(t.get("date")) + str(t.get("fixed_time"))))
    chosen = located[0]
    # Conversation focus wins when the message names no task: 'from home, by bus'
    # belongs to the interview we were just planning, not the soonest event.
    if _match_score(content, chosen.get("text", "")) == 0:
        active_id = session.get_active_task_id(phone)
        focus = next((t for t in located if t.get("id") == active_id), None) if active_id else None
        if focus:
            chosen = focus
    return await _route_for_task(phone, chosen, content, lang)


# Route lines the LLM might have written — stripped when we send our own block.
# Every route marker counts, not just emoji+clock pairs: the fabricated reply
# was '📍 מוצא: …' + 'טרם נמצאו נתיבי תחבורה ציבורית' + the guard's own
# 'רוצה שאחשב מסלול…?' offer, none of which carried a time and all of which
# survived the old pattern and shipped alongside the REAL route block.
_MODEL_ROUTE_RE = _re.compile(
    r"[🚶🚆🚄🚌🚇🚋🚗🚲🏠🚪⏰]"
    r"|^\s*📍"
    r"|(?:מוצא|יעד|לצאת|עזיבה|הגעה|להתעורר|לקום)\s*:?\s*"
    r"|טרם נמצאו|לא נמצאו.*(?:נתיב|מסלול)|נסה שוב מאוחר"
    r"|רוצה שאחשב מסלול"
    r"|\b(?:leave by|arrive by|wake up by|no (?:transit )?routes?)\b",
    _re.IGNORECASE | _re.MULTILINE)


def _direct_route_lines(plan: dict, lang: str) -> str:
    """Wake / leave / arrive lines for a NON-transit plan (car, bike, walk).
    format_route_message only covers transit alternatives, so without this a
    driver got the real reminders but no visible times."""
    he = lang == "he"
    dest = plan.get("destResolved") or plan.get("destination") or ""
    icon = {"car": "🚗", "bike": "🚲", "walk": "🚶"}.get(plan.get("transport"), "🚗")
    lines = [f"{icon} {dest}"]
    if plan.get("wakeUpBy"):
        lines.append(f"⏰ {'להתעורר עד' if he else 'Wake up by'} {plan['wakeUpBy']}")
    lines.append(
        f"🚪 {'לצאת עד' if he else 'Leave by'} {plan.get('leaveHomeBy')} "
        f"({plan.get('travelMinutes')} {'דק׳' if he else 'min'})")
    lines.append(f"📍 {'הגעה עד' if he else 'Arrive by'} {plan.get('arriveBy')}")
    lines.append("⏰ " + ("תזכורות יציאה נשמרו" if he else "Leave reminders saved"))
    return "\n".join(lines)

_URL_RE = _re.compile(r"https?://[^\s)\]>*]+")


async def _strip_dead_links(text: str, lang: str) -> str:
    """Verify every URL in an outgoing reply; drop lines whose link is dead.

    The LLM has no web access and used to invent LinkedIn job IDs — 'verified'
    links that 404. This is the URL twin of the route anti-fabrication guard:
    facts (here: working links) are checked deterministically, never trusted
    from the model. Search-page links it's allowed to build (linkedin.com/jobs/
    search?keywords=...) return 200 and pass. Best-effort: on checker failure
    the text goes through unchanged — never block a reply on this."""
    urls = list(dict.fromkeys(_URL_RE.findall(text)))[:6]
    if not urls:
        return text
    try:
        import httpx

        async def _alive(u: str) -> bool:
            # Redirects by hand: each hop must be public too (url_safety), or a
            # public link could bounce the request into the machine's network.
            try:
                async with httpx.AsyncClient(
                    timeout=6, follow_redirects=False,
                    headers={"User-Agent": "Mozilla/5.0 (compatible; LumiBot)"},
                ) as c:
                    for _hop in range(4):
                        if not await url_safety.is_public_url(u):
                            return False
                        r = await c.head(u)
                        if r.status_code >= 400 or r.status_code == 405:
                            r = await c.get(u)  # some sites reject HEAD
                        if r.is_redirect and r.headers.get("location"):
                            u = str(r.url.join(r.headers["location"]))
                            continue
                        return r.status_code < 400
                    return False
            except Exception:  # noqa: BLE001 — unreachable = dead
                return False

        checks = await asyncio.wait_for(
            asyncio.gather(*[_alive(u) for u in urls]), timeout=15)
        dead = {u for u, ok in zip(urls, checks) if not ok}
        if not dead:
            return text
        logger.warning("stripped %d dead link(s) from reply: %s", len(dead), sorted(dead))
        kept = [ln for ln in text.split("\n") if not any(u in ln for u in dead)]
        kept.append("⚠️ הסרתי קישורים שלא נפתחים" if lang == "he"
                    else "⚠️ I removed links that didn't resolve")
        return "\n".join(kept).strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("link verification skipped: %s", exc)
        return text


def _signature_ok(raw: bytes, header: str | None) -> bool:
    """Verify Meta's X-Hub-Signature-256 — but only when we are set up for it.

    OPT-IN BY DESIGN. The signature is keyed on the App Secret of a Meta
    *Business* account, which this product does not have; the WhatsApp side runs
    through a lightweight/personal gateway that signs nothing. Enforcing it
    today would reject every real message, so an unset WHATSAPP_APP_SECRET
    means "accept", exactly as before.

    Setting the secret (`fly secrets set WHATSAPP_APP_SECRET=...`) turns
    enforcement on with no code change — which is the whole point of writing it
    now rather than when the account exists. Phone LINKING never accepts an
    unsigned webhook (_link_proof_trusted).
    """
    if not config.WHATSAPP_APP_SECRET:
        return True
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(config.WHATSAPP_APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header[7:], expected)



def _link_proof_trusted() -> bool:
    """A phone-link code proves the number only if `from` is signed by Meta.

    _signature_ok accepts unsigned webhooks when the secret is unset, which is
    tolerable for chat but not for linking: the link is what grants an account a
    number's tasks and memory. So linking needs the secret, always.
    """
    return bool(config.WHATSAPP_APP_SECRET)


@app.post("/app/profile/routines")
async def app_profile_routines(request: Request):
    """What she told Meira about her week, for the phone's schedule.

    6.10, "why doesn't Meira take my routines into account?": the kickboxing she
    told Meira in the chat lives in the server's routinesNotes, and no phone
    code could read it — the Today screen planned around the app's Routines box
    alone. Read-only; the verified caller's own profile, never another's.
    Header: Authorization: Bearer <supabase token>. Returns {routinesNotes, hobbies}.
    """
    try:
        caller = await app_auth.identify(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)
    # The brain key, not the caller's phone: the agent saves under the account
    # id, and the routes reading the phone's record returned an empty week.
    prof = user_profile.get_profile(identity_keys.brain_key(caller)) or {}
    return {
        "routinesNotes": str(prof.get("routinesNotes") or "")[:4000],
        "hobbies": str(prof.get("hobbies") or "")[:2000],
    }


@app.post("/webhook/whatsapp")
async def whatsapp_webhook(request: Request):
    """Handle an inbound WhatsApp text message end-to-end."""
    # Read the raw bytes first: a signature is over what was sent, not over a
    # re-serialised parse of it. No-ops unless WHATSAPP_APP_SECRET is set.
    raw = await request.body()
    if not _signature_ok(raw, request.headers.get("x-hub-signature-256")):
        logger.warning("webhook rejected: bad or missing X-Hub-Signature-256")
        return JSONResponse({"status": "forbidden"}, status_code=403)

    # The ceiling that holds whether or not the signature is enforced. Each
    # message below runs a full ReAct turn on a 235B model, so an unsigned
    # webhook is not only a write primitive — it is a bill. The per-number
    # limit is applied after parsing; this one is the whole door, because
    # forged bodies each name a different number and would otherwise arrive as
    # an endless supply of fresh users.
    if not rate_limit.allow("wa:all", rate_limit.WEBHOOK_GLOBAL_LIMIT,
                            rate_limit.WEBHOOK_GLOBAL_WINDOW_S):
        logger.warning("webhook rate limit hit — %d/%gs exceeded",
                       rate_limit.WEBHOOK_GLOBAL_LIMIT, rate_limit.WEBHOOK_GLOBAL_WINDOW_S)
        return JSONResponse({"status": "rate_limited"}, status_code=429)

    try:
        body = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        return {"status": "ignored"}

    try:
        value = body["entry"][0]["changes"][0]["value"]
        messages = value.get("messages")
        if not messages:
            return {"status": "ignored"}  # status callbacks, etc.
        msg = messages[0]
    except (KeyError, IndexError, TypeError):
        return {"status": "ignored"}

    msg_id = msg.get("id")
    phone = msg.get("from")
    content = msg.get("text", {}).get("body", "")
    if not msg_id or not phone:
        return {"status": "ignored"}

    # Per-sender ceiling, above the whole-door one. A real person sends a few
    # dozen messages on a heavy day; past that it is a loop or a script, and
    # either way each one is a paid turn. Placed BEFORE the dedup so a flood of
    # distinct ids cannot walk past it.
    if not rate_limit.allow(f"wa:{phone}", rate_limit.WHATSAPP_LIMIT,
                            rate_limit.WHATSAPP_WINDOW_S):
        logger.warning("whatsapp rate limit hit for one sender")
        return JSONResponse({"status": "rate_limited"}, status_code=429)

    # Deduplicate: WhatsApp retries the same webhook up to 4× per message
    if msg_id in _seen_msg_ids:
        return {"status": "duplicate"}
    _seen_msg_ids.add(msg_id)
    _seen_msg_ids_order.append(msg_id)
    if len(_seen_msg_ids_order) > 200:
        _seen_msg_ids.discard(_seen_msg_ids_order.pop(0))

    # "קוד חיבור למאירה: 123456" — the app's WhatsApp-link proof (phone_links).
    # `phone` is Meta's signed `from`, so the number is proved by the transport.
    if msg.get("type") == "text" and phone_links.looks_like_code(content):
        await WhatsAppService.mark_as_read(msg_id)
        if not _link_proof_trusted():
            # Unsigned, `from` is whatever the sender wrote — linking on it would
            # hand any account any number's tasks and memory. Fail closed.
            logger.warning("SECURITY: phone link refused — WHATSAPP_APP_SECRET is not set")
            await WhatsAppService.send_message(
                phone, "חיבור הוואטסאפ לא זמין כרגע. נסי שוב מאוחר יותר 🙏")
            return JSONResponse({"status": "ok"})
        res = phone_links.confirm(phone, content)
        if res["ok"]:
            await phone_links.write_display_phone(res["userId"], supabase_tasks._digits(phone))  # noqa: SLF001
            try:
                await supabase_tasks.flush_pending(supabase_tasks._digits(phone))  # noqa: SLF001
            except Exception as exc:  # noqa: BLE001
                logger.warning("flush after link failed: %s", exc)
            text = "חובר ✓ מעכשיו מאירה בוואטסאפ ובאפליקציה זוכרת אותך כאחת."
        elif res["reason"] == "too_many_attempts":
            text = "יותר מדי ניסיונות היום. אפשר לנסות שוב מחר 🙏"
        else:
            text = "הקוד לא נכון או שפג תוקפו (10 דקות). אפשר לבקש קוד חדש באפליקציה 🙏"
        await WhatsAppService.send_message(phone, text)
        return JSONResponse({"status": "ok"})

    # A tapped button / list row. The reply carries the id WE set, so a ride
    # pick needs no parsing at all — this is the path that makes choosing an
    # option reliable, and it must run before anything else can reinterpret it.
    if msg.get("type") == "interactive":
        reply = ((msg.get("interactive") or {}).get("button_reply")
                 or (msg.get("interactive") or {}).get("list_reply") or {})
        picked_id = str(reply.get("id") or "")
        if picked_id.startswith("route:"):
            await WhatsAppService.mark_as_read(msg_id)
            try:
                lang_for_pick = user_profile.get_profile(phone).get("language") or "he"
                confirm = await _confirm_route_pick(
                    phone, int(picked_id.split(":", 1)[1]), lang_for_pick)
            except (ValueError, IndexError):
                confirm = None
            await WhatsAppService.send_message(
                phone,
                confirm or ("לא מצאתי את האפשרות הזו — אפשר לבקש מסלול שוב 🙏"
                            if (user_profile.get_profile(phone).get("language") or "he") == "he"
                            else "I couldn't find that option — ask me for the route again 🙏"),
            )
            return JSONResponse({"status": "ok"})
        # Any other button: treat its caption as if she had typed it.
        content = reply.get("title") or content

    # WhatsApp reply-to: the quoted message is context, the new text is the ask.
    if msg.get("context", {}).get("id"):
        content = f"(this message REPLIES to an earlier message in this chat — the instruction is the new text below) {content}".strip()

    # Voice note → Whisper transcription → treated exactly like typed text.
    if msg.get("type") == "audio" and (msg.get("audio") or {}).get("id"):
        audio_bytes = await WhatsAppService.download_media(msg["audio"]["id"])
        transcript = await stt.transcribe(audio_bytes) if audio_bytes else None
        if transcript:
            logger.info("voice note transcribed (%d chars)", len(transcript))
            content = transcript
        else:
            await WhatsAppService.mark_as_read(msg_id)
            await WhatsAppService.send_message(
                phone, "לא הצלחתי לשמוע את ההודעה הקולית 🙏 אפשר לכתוב לי?")
            return JSONResponse({"status": "ok"})

    # A photo (usually a screenshot). Images were not handled at all: `content`
    # is read from msg["text"]["body"], which an image message has no such
    # field for, so a screenshot with a caption arrived as an empty string and
    # the caption was silently lost. Keep the media id — a bug report wants it.
    image_media_id = None
    if msg.get("type") == "image" and (msg.get("image") or {}).get("id"):
        image_media_id = msg["image"]["id"]
        caption = (msg["image"].get("caption") or "").strip()
        if caption:
            content = caption
        elif not content:
            content = "(sent a photo with no caption)"

    # The user shared contact card(s) (📎 → Contact): remember name → number so
    # "write to אימוש happy birthday tomorrow" can schedule without re-asking.
    if msg.get("type") == "contacts" and msg.get("contacts"):
        saved = []
        for card in msg["contacts"]:
            nm = (card.get("name") or {}).get("formatted_name") or (card.get("name") or {}).get("first_name") or ""
            for p in card.get("phones", []) or []:
                num = p.get("wa_id") or p.get("phone") or ""
                if nm and num:
                    user_memory.save_contact(phone, nm, num)
                    saved.append(nm)
                    break
        if saved:
            content = f"(I shared contact card(s), now saved: {', '.join(saved)}) {content}".strip()

    # The user shared their location (📎 → Location): reverse-geocode it and feed
    # the address to the agent as their CURRENT start point.
    if msg.get("type") == "location" and msg.get("location"):
        loc = msg["location"]
        geo_loc = await geo.reverse_geocode(loc.get("latitude"), loc.get("longitude"))
        addr = (geo_loc or {}).get("formatted") or loc.get("name") or "the pin you sent"
        # Kept for privacy.CURRENT_TTL_S (30 min) only — then it reads as unknown
        # and the daily retention pass wipes it.
        user_profile.update_profile(phone, currentAddress=addr,
                                    currentLat=loc.get("latitude"), currentLng=loc.get("longitude"),
                                    currentAt=_tz.now_il().timestamp())
        content = f"(I'm sharing my current location: {addr}) {content}".strip()


    # ── A key pasted into the chat ─────────────────────────────────────────
    # Before ANYTHING stores or forwards the text: not the history, not the
    # DB, not the model. A Meira key is revoked on the spot. See secret_guard.
    _guard = secret_guard.handle(content, he=(user_profile.get_profile(phone).get("language") or "he") == "he")
    if _guard:
        await WhatsAppService.mark_as_read(msg_id)
        await WhatsAppService.send_message(phone, _guard)
        return JSONResponse({"status": "ok"})

    # ── Bug reports ────────────────────────────────────────────────────────
    # "באג בלומי: …" / "bug in lumi: …". Filed as a tracked record with an id
    # rather than answered conversationally, so it can be referred back to,
    # given a status, and closed. Handled before the agent runs: a bug report
    # is not a scheduling request and must not be parsed as one.
    bug_desc = bug_reports.detect(content or "")
    if bug_desc is not None:
        await WhatsAppService.mark_as_read(msg_id)
        if not bug_desc and not image_media_id:
            await WhatsAppService.send_message(
                phone, "מה הבאג? תארי לי במשפט (אפשר גם עם צילום מסך) 🐞")
            return JSONResponse({"status": "ok"})
        history = conversation.get_history(phone)
        rec = bug_reports.file_bug(
            phone, bug_desc or "(screenshot only)",
            image_id=image_media_id, context=history,
        )
        shot = " (עם צילום מסך)" if image_media_id else ""
        await WhatsAppService.send_message(
            phone,
            f"🐞 נרשם: {rec['id']}{shot}\n"
            f"״{(bug_desc or 'צילום מסך')[:80]}״\n"
            "אעדכן אותך כשיהיה תיקון. \"באגים\" מראה את הרשימה.",
        )
        return JSONResponse({"status": "ok"})

    # "בנה LUMI-3f2a" / "build LUMI-3f2a" — approve shipping a fix. The Mac
    # agent polls for this; it has no way to receive a WhatsApp reply itself.
    _build_ok = re.match(r"^\s*(?:בנה|בני|build)\s+(LUMI-[0-9a-f]{4})\s*$",
                         (content or ""), re.IGNORECASE)
    if _build_ok:
        await WhatsAppService.mark_as_read(msg_id)
        rec = bug_reports.request_build(_build_ok.group(1).upper())
        await WhatsAppService.send_message(
            phone,
            f"🔨 בונה גרסה עם התיקון של {rec['id']}. אשלח לינק כשיהיה מוכן."
            if rec else "לא מצאתי באג עם המזהה הזה 🤔")
        return JSONResponse({"status": "ok"})

    # "באגים" / "bugs" — the open list, with status.
    if re.match(r"^\s*(באגים|bugs)\s*$", (content or ""), re.IGNORECASE):
        await WhatsAppService.mark_as_read(msg_id)
        rows = bug_reports.list_for_phone(phone, open_only=True)
        if not rows:
            await WhatsAppService.send_message(phone, "אין באגים פתוחים ✨")
        else:
            lines = [f"{r['id']} · {r['status']} — {r['description'][:60]}" for r in rows[:10]]
            await WhatsAppService.send_message(phone, "🐞 באגים פתוחים:\n" + "\n".join(lines))
        return JSONResponse({"status": "ok"})

    # ── Task cleanup (delete duplicates + past-deadline) ────────────────────
    # "נקה משימות" / "מחק כפולים" / "clean tasks" / "remove old tasks".
    if _CLEANUP_RE.search((content or "")):
        await WhatsAppService.mark_as_read(msg_id)
        import user_memory as _um
        from tz import today_il
        res = _um.cleanup_tasks(phone, today_il().isoformat())
        he = (f"🧹 ניקיתי: {res['removed_past']} משימות שעבר זמנן, "
              f"{res['removed_dupes']} כפולות. נשארו {res['kept']}.")
        await WhatsAppService.send_message(phone, he)
        return JSONResponse({"status": "ok"})

    # A typed pick answering the ROUTE question ("2", "option 2", "אופציה 3").
    #
    # A bare number used to have two possible owners — a bus option or a job
    # from the HR shortlist — which is why `_number_belongs_to` exists at all.
    # With the job scout gone the route is the only thing that asks a numbered
    # question, but the owner check stays: it is what stopped a "1" meant for a
    # bus being read as something else, and the next numbered question that
    # gets added will need it again.
    #
    # This used to clear the pending choice and hand the message to the model
    # "to confirm the ride" — but the model never saw the timetable that was
    # printed deterministically, so it answered "לא הבנתי" and re-asked where
    # she was leaving from, over and over. The pick is resolved here, against
    # the options we stored when we printed them.
    _owner = _number_belongs_to(phone, content)
    _pick = _picked_option(content)
    if _pick is not None:
        # The stored profile language, not `lang` — that is resolved further
        # down, after the DB lookup this branch returns before reaching.
        _lang_hint = user_profile.get_profile(phone).get("language") or "he"
        _pick_reply = await _confirm_route_pick(phone, _pick, _lang_hint)
        if _pick_reply:
            await WhatsAppService.mark_as_read(msg_id)
            await WhatsAppService.send_message(phone, _pick_reply)
            return JSONResponse({"status": "ok"})
    if _owner == "route":
        session.clear_pending_choice(phone)

    await WhatsAppService.mark_as_read(msg_id)

    # Resolve (or create) the user, then run the personality-aware agent.
    user = None
    learned = None
    try:
        user = await DatabaseService.get_user_by_whatsapp(phone)
        if not user:
            user = await DatabaseService.create_user_from_whatsapp(phone)
        await DatabaseService.save_incoming_message(str(user["id"]), msg_id, phone, content)
        learned = await PersonalityLearningService.get_learned_personality(str(user["id"]))
    except Exception as exc:  # noqa: BLE001 — degrade gracefully without a DB
        logger.warning("DB step skipped: %s", exc)
        user = user or {"id": phone, "name": "User", "language": "en"}

    lang = (user or {}).get("language", "en")

    # Her yes / no to a message Meira drafted for someone else — code, first.
    confirmed = agent_turn.confirm_outgoing(
        str(user.get("id") or user.get("whatsapp_phone") or phone), content)
    if confirmed:
        await WhatsAppService.send_message(phone, confirmed)
        return JSONResponse({"status": "ok"})

    # ── Deterministic fast-paths (no LLM) for the things it got wrong ──
    # "When is X due?" — answered from stored data, never by the model.
    try:
        due_reply = await _try_due_query(phone, content, lang)
        if due_reply is not None:
            await WhatsAppService.send_message(phone, due_reply)
            return JSONResponse({"status": "ok"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("due-query fast-path failed: %s", exc)
    # "תזכירי לי בעוד שעה" / "תבדקי אותי ב-13:00" — check-ins scheduled here,
    # in Python. When the SAME message also carries a work window ('בין 13:00
    # עד 17:00'), the reminders are still set now but the message continues to
    # the agent, which owns saving that window onto the task — early-returning
    # would have silently dropped it.
    checkin_reply = None
    try:
        checkin_reply = await _try_relative_reminder(phone, content, lang)
        if checkin_reply is not None and not _TIME_RANGE_RE.search(content):
            await WhatsAppService.send_message(phone, checkin_reply)
            return JSONResponse({"status": "ok"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("relative-reminder fast-path failed: %s", exc)
        checkin_reply = None
    # Nudge: "תנדנדי לי" schedules real check-ins off the arrival time.
    try:
        nudge_reply = await _try_nudge(phone, content, lang)
        if nudge_reply is not None:
            await WhatsAppService.send_message(phone, nudge_reply)
            return JSONResponse({"status": "ok"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("nudge fast-path failed: %s", exc)
    # Delete: a clear "delete/תמחקי" cancels the referenced task, period.
    try:
        del_reply = await _try_delete(phone, content, lang)
        if del_reply is not None:
            await WhatsAppService.send_message(phone, del_reply)
            return JSONResponse({"status": "ok"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("delete fast-path failed: %s", exc)
    # Route: a clear "route/מסלול/recompute" computes REAL Google directions and
    # sends the deterministic block (+ map + reminders) — never the LLM's prose.
    try:
        route_res = await _try_route(phone, content, lang)
        if route_res is not None:
            deps = route_res.get("departures") or []
            if deps:                                   # empty = we're asking the mode
                reminders.schedule_departures(phone, deps, lang)
            # Numbered transit options were shown → a following bare number is a
            # ride choice; record the asker so HR doesn't tailor a CV instead,
            # and the OPTIONS THEMSELVES so the pick can be honoured without
            # asking the model to remember a timetable it never saw.
            # The timetable itself always goes as text: WhatsApp caps an
            # interactive message body at 1024 characters and three
            # door-to-door options are longer than that, so folding the block
            # into the buttons would just make the send fail.
            await WhatsAppService.send_message(phone, route_res["text"])
            if route_res.get("optionCount"):
                session.set_pending_choice(
                    phone, "route", route_res["optionCount"],
                    options=route_res.get("options") or [],
                    context=route_res.get("planHead") or {},
                )
                # …then the choice itself, as buttons. "Reply with a number" is
                # where this broke: every phrasing of the answer had to be
                # parsed, and the ones that were not went to the model, which
                # had never seen the timetable and re-asked the question. A
                # button reply carries the id we set — nothing to parse.
                await WhatsAppService.send_options(
                    phone,
                    ("איזו נסיעה מתאימה לך?" if lang == "he" else "Which ride works for you?"),
                    [
                        {"id": f"route:{i + 1}",
                         "title": _option_button_title(opt, i + 1, lang)}
                        for i, opt in enumerate(route_res.get("options") or [])
                    ],
                )
            dep = deps[0] if deps else None
            if dep and dep.get("overviewPolyline"):
                async def _map(d: dict, to: str) -> None:
                    try:
                        img = await geo.fetch_route_map(d)
                        if img:
                            await WhatsAppService.send_image_bytes(to, img, caption="🗺️")
                    except Exception:  # noqa: BLE001
                        pass
                asyncio.create_task(_map(dep, phone))
            return JSONResponse({"status": "ok"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("route fast-path failed: %s", exc)

    # Stamp the message with its arrival time (Israel): times in the history
    # are stale, and the system-prompt clock alone was ignored — anchoring
    # "now" inside THIS user turn is what the model actually reads.
    from tz import now_il as _now_il_fn
    stamped = f"[נשלח עכשיו ב-{_now_il_fn().strftime('%H:%M')}] {content}"

    # Read BEFORE the turn: afterwards the history's last reply is this one.
    answering = agent_turn.meira_just_asked(str(user.get("id") or user.get("whatsapp_phone") or phone))
    response = await handle_whatsapp_message(stamped, user, learned)

    # Persist whatever the turn created. This lives in agent_turn so the app
    # channel saves tasks through the SAME code — a second copy of "mint one id
    # across three stores, stamp provenance, flush the queue" is exactly where
    # the two channels would start to disagree again.
    tasks_to_save = await agent_turn.persist_agent_tasks(
        phone, content, response, channel="whatsapp")

    # "תעירי אותי ב-7 בבוקר" — an ALARM, not a chat reminder. The app arms the
    # real phone alarm off Task.alarmAt; over WhatsApp that field was never
    # written, so the answer was "תזכורת לקום ב-7:00 ✓" and nothing ever rang.
    woken_at = None
    try:
        woken_at = _apply_wake_request(phone, content, tasks_to_save)
    except Exception as exc:  # noqa: BLE001 — never block the reply
        logger.warning("wake request not applied: %s", exc)

    # Nothing saved and nothing updated, but the message named an hour and asked
    # for something? Create it from her own words. Three turns in a row the model
    # answered "✓ …" for a task it never created; guarding the wording only
    # taught it new wording. See server/task_rescue.py.
    if not tasks_to_save and not (response.get("updates") or []):
        try:
            tasks_to_save, _rescue_note = await agent_turn.rescue_turn(
                phone, content, channel="whatsapp", answering=answering)
            if _rescue_note:
                # Said in the same message, so the answer and what actually
                # happened never arrive separately.
                response["text"] = f"{response.get('text', '')}\n\n{_rescue_note}".strip()
        except Exception as exc:  # noqa: BLE001 — never block the reply
            logger.warning("task rescue skipped: %s", exc)
    # Schedule wake/leave WhatsApp reminders for any located appointments today.
    departures = response.get("departures")
    reply_extra = ""
    # AUTO-ROUTE: a task with an address AND an hour is a trip — it needs a real
    # route and real wake/leave alarms, whether or not the model bothered to call
    # plan_departure (it usually doesn't; it fabricates "no routes found" prose
    # instead). Plan it here from Google, deterministically, on creation.
    routed: list = []  # [(task, plan)] — every trip this message created
    if not departures:
        # One message can create several trips ("gym at 18:00 and a party at
        # 20:00"). This used to break after the FIRST task, so the second got no
        # route, no leave time and no alarm — and if the first one asked how she
        # would travel, the second was never even looked at.
        #
        # They are also a CHAIN: the 20:00 trip starts at the 18:00 place, not
        # at home. Sorted by clock time so the chain is built in the order it
        # will actually be walked.
        def _clock(t: dict) -> str:
            return str(t.get("fixed_time") or "99:99")[:5]

        prev_address = user_profile.get_profile(phone).get("homeAddress")
        for task in sorted(tasks_to_save, key=_clock):
            try:
                auto = await _route_for_task(phone, task, content, lang,
                                             origin=prev_address)
            except Exception as exc:  # noqa: BLE001 — never block the reply
                logger.warning("auto-route failed: %s", exc)
                continue
            if not auto:
                continue  # not a trip (no address, or no hour) — fine
            if auto["departures"]:
                routed.append((task, auto["departures"][0]))
                departures = departures + auto["departures"] if departures else list(auto["departures"])
                # The next trip starts where this one ends.
                nxt = task.get("location")
                prev_address = nxt if isinstance(nxt, str) else (
                    (nxt or {}).get("address") or prev_address)
            elif not reply_extra:
                # Keep the FIRST honest line (a mode question or a routing
                # failure) but keep going — the later trips may still be
                # routable, and silence about them is the worse failure.
                reply_extra = auto["text"]

    # Put the route ON the task, in the shape the app reads.
    #
    # Until now this plan only fed the reminder scheduler and the reply text —
    # exactly the gap _location_from_departure was written to close. The task
    # itself kept `location` as the bare address string the model extracted, so
    # the app saw no coordinates, no transitPlan, no leaveHomeBy and no
    # wakeUpBy, and had to re-plan the whole trip itself on next open. That is
    # why a task created over WhatsApp had no leave alarm until the app was
    # opened — and if it never was, no alarm at all.
    if routed:
        try:
            uid_for_route = await supabase_tasks.user_id_for_phone(phone)
        except Exception as exc:  # noqa: BLE001
            logger.warning("uid lookup for route persist failed: %s", exc)
            uid_for_route = None
        for task, plan in routed:
            if not task.get("id"):
                continue
            try:
                location = _location_from_departure(plan)
                user_memory.update_task(phone, task["id"], {"location": location})
                if uid_for_route:
                    await supabase_tasks.update_task(
                        uid_for_route, task["id"], {"location": location})
                    logger.info("route persisted onto task %s", task["id"])
                else:
                    supabase_tasks.queue_pending(phone, {**task, "location": location})
            except Exception as exc:  # noqa: BLE001 — the reply still stands
                logger.warning("route persist onto task failed: %s", exc)
    # One brain: after this message's own trips are planned, re-chain the rest
    # of the day. Adding, moving or completing a task shifts the leave times of
    # every later trip, because each starts where the previous one ended. Only
    # trips whose origin actually changed are re-fetched, so this is usually a
    # no-op and never a burst of route calls.
    try:
        touched_dates = {t.get("date") for t in tasks_to_save if t.get("date")}
        if touched_dates:
            await _rechain_day(phone, touched_dates, lang)
    except Exception as exc:  # noqa: BLE001 — re-chaining never blocks the reply
        logger.warning("day re-chain skipped: %s", exc)

    if departures:
        count = reminders.schedule_departures(phone, departures, lang)
        if count:
            logger.info("scheduled %d reminder(s) for %s", count, phone)

    # Whenever WE hold a real plan, the model's own route prose is noise at best
    # and fabrication at worst — strip it and render the route DETERMINISTICALLY.
    reply_text = response["text"]
    _pick_buttons: list = []
    if departures:
        kept = [ln for ln in reply_text.split("\n") if not _MODEL_ROUTE_RE.search(ln)]
        reply_text = "\n".join(kept).strip()
        dep = next((d for d in departures if d.get("alternatives")), departures[0])
        is_interview = bool(_re.search(
            r"interview|ראיון", str(dep.get("destination", "")), _re.IGNORECASE))
        if dep.get("alternatives"):  # transit → the multi-option picker block
            pref = "bus" if _BUS_RE.search(content) else "rail"
            _opts: list = []
            _rendered: list = []
            route_block = geo.format_route_message(
                dep, pref=pref, is_interview=is_interview, lang=lang, counter=_opts,
                out_options=_rendered)
            # This agent path renders the picker too — record the open question
            # here as well, WITH its options, or a pick after THIS block has
            # nothing to resolve against and falls through to the model (which
            # is the "לא הבנתי את התשובה" loop).
            if _opts and _opts[0]:
                session.set_pending_choice(
                    phone, "route", _opts[0], options=_rendered,
                    context={
                        "destination": dep.get("destination"),
                        "destResolved": dep.get("destResolved"),
                        "date": dep.get("date"),
                        "routineMinutes": dep.get("routineMinutes") or 0,
                        "fromHome": bool(dep.get("fromHome")),
                        "taskId": next((t.get("id") for t in tasks_to_save if t.get("id")), None),
                        "isInterview": is_interview,
                    },
                )
                _pick_buttons = [
                    {"id": f"route:{i + 1}", "title": _option_button_title(opt, i + 1, lang)}
                    for i, opt in enumerate(_rendered)
                ]
        else:  # car / bike → one wake/leave/arrive line, still from real data
            route_block = _direct_route_lines(dep, lang)
        reply_text = f"{reply_text}\n\n{route_block}" if reply_text else route_block
    elif reply_extra:
        reply_text = f"{response['text']}\n\n{reply_extra}".strip()

    # Check-ins were scheduled above (message also carried a work window). Drop
    # the model's own version of that confirmation — ours names the times that
    # REALLY got persisted.
    if checkin_reply:
        kept = [ln for ln in reply_text.split("\n") if not _HISTORY_CHECKIN_RE.search(ln)]
        reply_text = ("\n".join(kept).strip() + "\n" + checkin_reply).strip()

    # Dead-link guard: the model can't verify URLs — we do, and strip fakes.
    reply_text = await _strip_dead_links(reply_text, lang)

    # An explicit wake time was stamped on the task: say so in the words that
    # match what will actually happen — a phone alarm, not a chat ping.
    if woken_at:
        reply_text = (f"{reply_text}\n\n⏰ שעון מעורר ל-{woken_at} ✓" if lang == "he"
                      else f"{reply_text}\n\n⏰ Alarm set for {woken_at} ✓").strip()

    await WhatsAppService.send_message(phone, reply_text)

    # …and if that reply printed numbered rides, follow it with the buttons, so
    # picking one is a tap instead of a message that has to survive parsing.
    if _pick_buttons:
        await WhatsAppService.send_options(
            phone,
            ("איזו נסיעה מתאימה לך?" if lang == "he" else "Which ride works for you?"),
            _pick_buttons,
        )

    # Route planned this turn → follow the text with a map image (polyline +
    # start / stations / destination markers). Best-effort garnish, never blocks.
    map_dep = next((d for d in (departures or []) if d.get("overviewPolyline")), None)
    if map_dep:
        async def _send_route_map(dep: dict, to: str) -> None:
            try:
                img = await geo.fetch_route_map(dep)
                if img:
                    await WhatsAppService.send_image_bytes(
                        to, img, caption=f"🗺️ {dep.get('destResolved') or ''}".strip())
            except Exception as exc:  # noqa: BLE001
                logger.debug("route map skipped: %s", exc)
        asyncio.create_task(_send_route_map(map_dep, phone))

    # Judge evaluates every turn async — never blocks the reply.
    asyncio.create_task(judge_service.evaluate(
        content, response["text"], (tasks_to_save[0] if tasks_to_save else {})))

    return JSONResponse({"status": "ok"})
