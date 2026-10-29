"""mcp_server — Meira as an MCP server: any AI assistant can ask about her day.

Claude, ChatGPT, Cursor — anything that speaks the Model Context Protocol —
can connect to `POST /mcp` and ask "what's on my day?", "do I have time for a
2-hour meeting in Haifa on Tuesday?" or "add a dentist at 16:00 tomorrow in
Ibn Gabirol 30". Meira answers with the same brain the app and WhatsApp use:
the same tasks, the same encrypted memory, the same deterministic route and
clash code. A task added from Claude lands in Supabase, the phone pulls it,
and the phone routes it and sets the wake alarm like any other.

Two doors were already one brain (app + WhatsApp). This is the third door,
and the first that is not ours: Meira stops being an app and becomes the
location-aware layer other agents call.

PROTOCOL. MCP "Streamable HTTP" (spec 2025-06-18), stateless: every POST is a
JSON-RPC message or batch, answered with application/json. No session id, no
server-initiated stream (GET → 405), which the spec allows and which suits a
256 MB machine that sleeps. Hand-written rather than the `mcp` SDK: it is
~5 methods of JSON-RPC, and the SDK would pull starlette/anyio/pydantic
settings into a process that has 21 MB of headroom.

AUTH. `Authorization: Bearer meira_mcp_…` — a personal token she creates in
the app (Menu → AI assistants), shown ONCE, stored here only as a SHA-256,
revocable. A Supabase access token is accepted too (it expires in an hour,
fine for testing). Identity always comes from the token, never from a tool
argument — the same rule as app_auth.storage_key_for.

TOOLS are a curated subset, written for an outside model that knows nothing
about Meira: plain English descriptions, no internal prompt rules. Most wrap
the agent's own tools (lumi_agent._make_tools), so there is one
implementation of "check availability", not two. `ask_meira` is the escape
hatch: a full agent turn, for anything the others do not cover.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import time
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

import app_auth
import config
import identity_keys
import rate_limit
import secure_store

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp"])

_PATH = os.path.join(config.DATA_DIR, "mcp_tokens.json")
TOKEN_PREFIX = "meira_mcp_"
MAX_TOKENS_PER_USER = 5
SUPPORTED_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
MCP_LIMIT, MCP_WINDOW_S = 60, 60.0

SERVER_INFO = {"name": "meira", "title": "Meira — local-aware personal secretary", "version": "1.0.0"}

INSTRUCTIONS = (
    "Meira is the user's personal secretary. She knows the user's calendar, tasks, home, "
    "usual transport and routines, and computes real travel times (Google Directions) — "
    "use her for anything about the user's schedule, when to leave, whether something fits, "
    "or adding/moving appointments. Dates may be given as YYYY-MM-DD or in words "
    "('tomorrow', 'next Tuesday', 'מחר'). Times are HH:MM, Israel time. Answer the user "
    "briefly; Meira's results are facts, not suggestions to rephrase."
)


# ── personal tokens ─────────────────────────────────────────────────────────
# {user_key: [{hash, label, created, last_used, userId, phone}]} — the shape
# account_deletion walks, so deleting the account revokes every token.

def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(caller: dict, label: str = "") -> dict:
    """A new personal token for this verified caller. The plaintext is returned
    once and never stored."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    store = _load()
    mine = store.setdefault(caller["key"], [])
    mine.append({
        "hash": _hash(token),
        "label": (label or "AI assistant")[:40],
        "created": time.time(),
        "last_used": None,
        "userId": caller.get("userId"),
        "phone": caller.get("phone"),
    })
    # Oldest go first: five live tokens is plenty for one person.
    store[caller["key"]] = mine[-MAX_TOKENS_PER_USER:]
    _save(store)
    return {"token": token, "label": mine[-1]["label"], "created": mine[-1]["created"]}


def list_tokens(key: str) -> list:
    return [{"label": t.get("label"), "created": t.get("created"), "last_used": t.get("last_used"),
             "id": t["hash"][:10]} for t in _load().get(key, [])]


def revoke_tokens(key: str, token_id: Optional[str] = None) -> int:
    store = _load()
    mine = store.get(key, [])
    kept = [t for t in mine if token_id and not t["hash"].startswith(token_id)]
    store[key] = kept
    if not kept:
        store.pop(key, None)
    _save(store)
    return len(mine) - len(kept)


def revoke_token_value(token: str) -> int:
    """Revoke one token by its plaintext, whoever owns it — for a key that has
    leaked (secret_guard found it pasted into a chat). Returns 0 or 1."""
    h = _hash(token)
    store = _load()
    for key, rows in list(store.items()):
        kept = [r for r in rows if r.get("hash") != h]
        if len(kept) != len(rows):
            if kept:
                store[key] = kept
            else:
                store.pop(key, None)
            _save(store)
            return 1
    return 0


def _caller_for_token(token: str) -> Optional[dict]:
    h = _hash(token)
    store = _load()
    for key, rows in store.items():
        for row in rows:
            if secrets.compare_digest(row.get("hash", ""), h):
                # last_used, at most once a minute — a write per call is waste.
                if not row.get("last_used") or time.time() - row["last_used"] > 60:
                    row["last_used"] = time.time()
                    try:
                        _save(store)
                    except Exception as exc:  # noqa: BLE001 — bookkeeping never blocks a call
                        logger.warning("mcp token last_used not saved: %s", exc)
                return {"key": key, "userId": row.get("userId"), "phone": row.get("phone"),
                        "email": None, "via": "mcp_token"}
    return None


async def authenticate(authorization: Optional[str]) -> dict:
    """Bearer meira_mcp_… → the caller that minted it; else a Supabase token.
    Raises app_auth.AuthError. Fails closed."""
    token = app_auth._bearer(authorization)   # noqa: SLF001 — one parser for both kinds
    if token.startswith(TOKEN_PREFIX):
        caller = _caller_for_token(token)
        if not caller:
            raise app_auth.AuthError("unknown or revoked Meira token")
        return caller
    caller = await app_auth.identify(authorization)
    return {**caller, "via": "supabase"}


# ── tools ───────────────────────────────────────────────────────────────────

def _obj(props: dict, required: list | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


_DATE = {"type": "string", "description": "YYYY-MM-DD, or words: 'today', 'tomorrow', 'next Tuesday', 'מחר'."}
_TIME = {"type": "string", "description": "HH:MM, 24-hour, Israel time."}

TOOLS: list[dict] = [
    {
        "name": "get_my_day",
        "title": "Get my day",
        "description": "The user's day in order: every task and appointment with its time and place; for each "
                       "one she travels to, when to leave (leave_by), how long and how — or no_leave_reason when "
                       "there is none; ONE wake_by for the day; and the clashes, each with a kind: 'travel' (two "
                       "places too far apart for the gap: late_by, arrive_at, ask_for, and a faster option when "
                       "there is one), 'overlap' (her own movable work on an appointment: moves_to), 'spatial' or "
                       "'double' (two appointments at once). Say the clashes; never invent their fixes.",
        "inputSchema": _obj({"date": _DATE}),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "check_availability",
        "title": "Does it fit?",
        "description": "Can something of N minutes fit on a date — optionally at a place and a start time? "
                       "Accounts for real travel time from whatever comes before and to whatever comes after. "
                       "Returns a verdict (fits | clash | no_travel_time | no_window), the reason, and free windows.",
        "inputSchema": _obj({
            "date": _DATE,
            "minutes": {"type": "integer", "minimum": 5, "maximum": 720},
            "place": {"type": "string", "description": "Where it would happen (name or address)."},
            "start_time": _TIME,
        }, ["date", "minutes"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "plan_journey",
        "title": "When do I leave?",
        "description": "Door-to-door plan to be somewhere by a given time: travel minutes, leave-by and wake-up "
                       "times, by the user's usual transport (or the one given), with bus/train alternatives. "
                       "Today's trips start where the user is; other days start at home.",
        "inputSchema": _obj({
            "destination": {"type": "string"},
            "arrive_by": _TIME,
            "date": _DATE,
            "transport": {"type": "string", "enum": ["bus", "train", "car", "walk", "bike"]},
            "start_address": {"type": "string", "description": "Only if the trip does not start at home / here."},
        }, ["destination", "arrive_by"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "add_task",
        "title": "Add to my day",
        "description": "Add a task or appointment to the user's day. Meira fills what is missing from her memory "
                       "(the usual place and hour for this activity), saves it to every device, reports any clash "
                       "it creates, and — when it has a place and a time — plans the journey. Her phone then sets "
                       "the leave-home reminder and wake alarm. Check the result's `clashes` and tell the user.",
        "inputSchema": _obj({
            "text": {"type": "string", "description": "What it is, in the user's words ('Dentist', 'Coffee with Dana')."},
            "date": _DATE,
            "time": _TIME,
            "duration_minutes": {"type": "integer", "minimum": 5, "maximum": 720},
            "location": {"type": "string", "description": "Place name or address as the user said it; not a guessed street."},
        }, ["text"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
    },
    {
        "name": "find_task",
        "title": "Find a task",
        "description": "Find the user's existing tasks by words (Hebrew or English). Use before update_task.",
        "inputSchema": _obj({"query": {"type": "string"}}, ["query"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "update_task",
        "title": "Change a task",
        "description": "Change an existing task by id (from find_task or get_my_day). Pass only what changes. "
                       "Done → status 'complete'. Cancel → status 'moved'.",
        "inputSchema": _obj({
            "task_id": {"type": "string"},
            "text": {"type": "string"},
            "date": _DATE,
            "time": _TIME,
            "duration_minutes": {"type": "integer", "minimum": 5, "maximum": 720},
            "status": {"type": "string", "enum": ["pending", "complete", "moved"]},
        }, ["task_id"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
    },
    {
        "name": "prepare_me",
        "title": "Prepare me",
        "description": "Live-researched preparation for a task (Tavily): songs to practise for karaoke, what to "
                       "bring to a clinic, what a course covers. Every item cites a web source. Returns "
                       "reason 'nothing_to_prepare' for tasks where the web adds nothing.",
        "inputSchema": _obj({"task_id": {"type": "string"}, "text": {"type": "string"}}),
        "annotations": {"readOnlyHint": True, "openWorldHint": True},
    },
    {
        "name": "ask_meira",
        "title": "Ask Meira",
        "description": "Say anything to Meira in natural language (Hebrew or English) — she runs her full agent: "
                       "plans a whole day from one sentence, moves several things at once, remembers preferences. "
                       "Use when no other tool fits. Returns her reply and anything she saved.",
        "inputSchema": _obj({"message": {"type": "string"}}, ["message"]),
        "annotations": {"readOnlyHint": False, "openWorldHint": True},
    },
]

_TOOL_NAMES = {t["name"] for t in TOOLS}


def _resolve_date(value: Optional[str]) -> str:
    """Any date words → YYYY-MM-DD, through the ONE parser the agent uses."""
    from tz import today_il, resolve_date_at as resolve_date
    today = today_il()
    if not value or str(value).strip().lower() in ("today", "היום"):
        return today.isoformat()
    s = str(value).strip()
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return s
    d = resolve_date(s, today)
    if not d:
        raise ValueError(f"could not read the date {value!r} — use YYYY-MM-DD")
    return d.isoformat() if hasattr(d, "isoformat") else str(d)


def _hhmm(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    s = str(value).strip().replace(".", ":")
    parts = s.split(":")
    try:
        h, m = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    except ValueError as exc:
        raise ValueError(f"time {value!r} is not HH:MM") from exc
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ValueError(f"time {value!r} is not HH:MM")
    return f"{h:02d}:{m:02d}"


def _agent_key(user: dict, caller: dict) -> str:
    """The key the agent's tools — and the profile they read — are filed under."""
    return str(user.get("id") or user.get("whatsapp_phone") or caller["key"])


async def _agent_tools(caller: dict, content: str = "") -> tuple[dict, dict]:
    import agent_turn
    from lumi_agent import _make_tools
    user, _ = await agent_turn.user_for_caller(caller)
    tools = _make_tools(_agent_key(user, caller), content, wa_phone=str(user.get("whatsapp_phone") or "") or None)
    return {t.name: t for t in tools}, user


_JOURNEY_KEYS = ("transport", "modeLabel", "startKind", "startResolved", "destResolved", "travelMinutes",
                 "leaveHomeBy", "leaveBy", "wakeUpBy", "arriveActual", "arriveAt", "routeText", "needsConfirm")


def _journey(p: dict) -> dict:
    """A plan without the polyline and coordinates: what a person would read."""
    return {k: p[k] for k in _JOURNEY_KEYS if p.get(k) not in (None, "", [])}


async def _get_my_day(caller: dict, args: dict) -> dict:
    """The day, stated — see day_plan. It used to echo only what the phone had
    synced, so the evening before a busy day it had one leave time and no
    clashes (29.9 → 30.9)."""
    import day_plan
    import task_store
    import user_profile
    from tz import today_il, now_il
    date = _resolve_date(args.get("date"))
    rows = await task_store.fetch_task_rows(caller["key"], date, date, include_location=True)
    now = now_il().strftime("%H:%M") if date == today_il().isoformat() else None
    profile: dict = {}
    plan_leg = None
    if day_plan.unrouted(rows):
        # Only now is it worth resolving who she is: a leg needs routing.
        tools, user = await _agent_tools(caller)
        profile = user_profile.get_profile(_agent_key(user, caller)) or {}
        plan_leg = day_plan.agent_plan_leg(tools["plan_departure"], profile)
    plan = await day_plan.plan_day(
        rows, date=date, home=profile.get("homeAddress"), plan_leg=plan_leg,
        routine_minutes=profile.get("morningRoutineMinutes") or 45, now=now)
    clash_keys = ("kind", "first", "second", "overlap_minutes", "travel_shortfall_minutes",
                  "travel_minutes", "arrive_at", "late_by", "ask_for", "faster",
                  "work", "fixed", "moves_to")
    return {
        "date": date,
        "wake_by": plan["wake_by"],
        **({"wake_reason": plan["wake_reason"]} if plan["wake_reason"] else {}),
        "tasks": plan["events"],
        "done": sum(1 for r in rows if r.get("status") == "complete"),
        "clashes": [{"question": p["question_en"], **{k: p[k] for k in clash_keys if p.get(k) is not None}}
                    for p in plan["problems"]],
        "note": "leave_by comes from the phone's live route (source 'phone') or was routed just now "
                "(source 'meira'); an event without one says why (no_leave_reason). wake_by is the "
                "one alarm for the day. flexible = her own work, no fixed hour or journey.",
    }


async def _add_task(caller: dict, args: dict) -> dict:
    import agent_turn
    text = str(args.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    date = _resolve_date(args.get("date"))
    time_ = _hhmm(args.get("time"))
    tools, _ = await _agent_tools(caller, text)
    inferred = await tools["infer_task_details"].ainvoke({
        "task_text": text, "date": date, "fixed_time": time_,
        "location": args.get("location") or None,
        **({"duration_minutes": int(args["duration_minutes"])} if args.get("duration_minutes") else {}),
    })
    if not isinstance(inferred, dict) or not inferred.get("text"):
        return {"ok": False, "reason": "could_not_understand", "detail": inferred}
    saved = await agent_turn.persist_agent_tasks(caller["key"], text, {"tasks": [inferred]}, channel="mcp")
    await _mirror_to_account(caller, saved)
    task = saved[0] if saved else inferred
    out: dict[str, Any] = {
        "ok": bool(saved),
        "task": {k: task.get(k) for k in ("id", "text", "date", "fixed_time", "duration_minutes",
                                          "category", "priority", "location") if task.get(k)},
        "filled_from_memory": inferred.get("recalled") or None,
        "clashes": inferred.get("collisions") or inferred.get("clashes") or [],
    }
    # Does it fit the day, travel between her meetings included (28.10)? When not,
    # she is asked — keep it, or the nearest hour that fits (update_task moves it).
    if saved:
        try:
            note, _ = await agent_turn.fit_note(caller["key"], saved, he=False)
            if note:
                out["does_not_fit"] = note
                out["ask_her"] = "Tell her it does not fit and ask: keep it anyway, or move it (update_task)?"
        except Exception as exc:  # noqa: BLE001 — the task is saved; the check is said to have failed
            logger.warning("mcp add_task: fit check failed: %s", exc)
            out["does_not_fit"] = f"could not check whether it fits: {type(exc).__name__}"
    where = task.get("location")
    where = where.get("address") if isinstance(where, dict) else where
    if where and task.get("fixed_time"):
        try:
            plan = await tools["plan_departure"].ainvoke({
                "destination": where, "arrival_time": task["fixed_time"], "task_date": task.get("date") or date})
            if isinstance(plan, dict) and plan.get("ok") is not False:
                p = plan.get("plan") or {}
                out["journey"] = _journey(p)
            else:
                out["journey"] = {"unavailable": (plan or {}).get("message") or (plan or {}).get("need") or "no route"}
        except Exception as exc:  # noqa: BLE001 — the task is saved; the route is a bonus
            logger.warning("mcp add_task: journey failed: %s", exc)
            out["journey"] = {"unavailable": f"route failed: {type(exc).__name__}"}
    out["phone"] = "Saved. Her phone plans the live route, leave-home reminder and wake alarm on its next sync."
    return out


async def _mirror_to_account(caller: dict, saved: list) -> None:
    """A token knows its Supabase user id; make sure the rows reach it even
    when the brain is keyed by a phone the tasks table cannot map."""
    uid = caller.get("userId")
    if not uid or not saved:
        return
    import supabase_tasks
    for t in saved:
        try:
            await supabase_tasks.upsert_task(uid, t)
        except Exception as exc:  # noqa: BLE001
            logger.warning("mcp: supabase mirror failed for one task: %s", exc)


async def _update_task(caller: dict, args: dict) -> dict:
    tools, _ = await _agent_tools(caller)
    patch = {"task_id": str(args.get("task_id") or "")}
    if args.get("text"):
        patch["text"] = args["text"]
    if args.get("date"):
        patch["date"] = _resolve_date(args["date"])
    if args.get("time"):
        patch["fixed_time"] = _hhmm(args["time"])
    if args.get("duration_minutes"):
        patch["duration_minutes"] = int(args["duration_minutes"])
    if args.get("status"):
        patch["status"] = args["status"]
    result = await tools["update_task"].ainvoke(patch)
    if isinstance(result, dict) and result.get("ok") and caller.get("userId"):
        import supabase_tasks
        fields = {k: v for k, v in patch.items() if k != "task_id"}
        try:
            await supabase_tasks.update_task(caller["userId"], patch["task_id"], fields)
        except Exception as exc:  # noqa: BLE001
            logger.warning("mcp update mirror failed: %s", exc)
    return result


async def _prepare_me(caller: dict, args: dict) -> dict:
    import task_prep
    task: dict = {}
    if args.get("task_id"):
        import task_store
        rows = await task_store.fetch_task_rows(caller["key"], include_location=True)
        task = next((r for r in rows if str(r.get("id")) == str(args["task_id"])), {})
        if not task:
            return {"ok": False, "reason": "no_such_task"}
        loc = task.get("location")
        task = {"id": task.get("id"), "text": task.get("text"), "category": task.get("category"),
                "date": task.get("date"), "time": task.get("fixed_time"),
                "location": loc.get("address") if isinstance(loc, dict) else loc}
    elif args.get("text"):
        task = {"text": str(args["text"])}
    else:
        raise ValueError("pass task_id or text")
    out = await task_prep.build(task, identity_keys.brain_key(caller))
    keep = ("ok", "reason", "why", "kind", "headline_en", "items_en", "sources")
    return {k: out.get(k) for k in keep if out.get(k) is not None}


async def _ask_meira(caller: dict, args: dict) -> dict:
    import agent_turn
    message = str(args.get("message") or "").strip()
    if not message:
        raise ValueError("message is required")
    import secret_guard
    blocked = secret_guard.handle(message, he=False)
    if blocked:
        return {"ok": False, "reason": "message_contained_a_key", "reply": blocked}
    user, learned = await agent_turn.user_for_caller(caller)
    result = await agent_turn.run_turn(caller["key"], message, user, learned, channel="mcp")
    saved = result.get("tasks") or []
    await _mirror_to_account(caller, saved)
    return {
        "reply": result.get("text", ""),
        "saved": [{k: t.get(k) for k in ("id", "text", "date", "fixed_time") if t.get(k)} for t in saved],
        "departures": result.get("departures") or [],
    }


async def call_tool(caller: dict, name: str, args: dict) -> Any:
    if name not in _TOOL_NAMES:
        raise KeyError(name)
    args = args or {}
    if name == "get_my_day":
        return await _get_my_day(caller, args)
    if name == "add_task":
        return await _add_task(caller, args)
    if name == "update_task":
        return await _update_task(caller, args)
    if name == "prepare_me":
        return await _prepare_me(caller, args)
    if name == "ask_meira":
        return await _ask_meira(caller, args)
    tools, _ = await _agent_tools(caller)
    if name == "check_availability":
        return await tools["check_availability"].ainvoke({
            "date": _resolve_date(args.get("date")), "minutes": int(args.get("minutes") or 60),
            **({"place": args["place"]} if args.get("place") else {}),
            **({"start_time": _hhmm(args["start_time"])} if args.get("start_time") else {}),
        })
    if name == "plan_journey":
        res = await tools["plan_departure"].ainvoke({
            "destination": args.get("destination"), "arrival_time": _hhmm(args.get("arrive_by")),
            "task_date": _resolve_date(args.get("date")),
            **({"transport": args["transport"]} if args.get("transport") else {}),
            **({"start_address": args["start_address"]} if args.get("start_address") else {}),
        })
        if isinstance(res, dict) and isinstance(res.get("plan"), dict):
            return {"ok": True, "date": res.get("task_date"), "is_today": res.get("is_today"),
                    **_journey(res["plan"]),
                    "alternatives": [_journey(a) for a in res["plan"].get("alternatives") or []]}
        return res
    if name == "find_task":
        return await tools["find_task"].ainvoke({"query": str(args.get("query") or "")})
    raise KeyError(name)


# ── JSON-RPC ────────────────────────────────────────────────────────────────

def _err(id_: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _ok(id_: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


async def handle_message(caller: dict, msg: Any) -> Optional[dict]:
    """One JSON-RPC message → its response, or None for a notification."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return _err(msg.get("id") if isinstance(msg, dict) else None, -32600, "invalid request")
    method, id_ = msg["method"], msg.get("id")
    is_notification = "id" not in msg
    params = msg.get("params") or {}

    if method == "initialize":
        asked = str(params.get("protocolVersion") or "")
        version = asked if asked in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0]
        return _ok(id_, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        })
    if is_notification:
        return None   # notifications/initialized, cancelled, … — nothing to say
    if method == "ping":
        return _ok(id_, {})
    if method == "tools/list":
        return _ok(id_, {"tools": TOOLS})
    if method == "tools/call":
        name = str(params.get("name") or "")
        if name not in _TOOL_NAMES:
            return _err(id_, -32602, f"unknown tool: {name}")
        started = time.time()
        try:
            data = await call_tool(caller, name, params.get("arguments") or {})
            is_error = isinstance(data, dict) and data.get("ok") is False and name != "prepare_me"
        except ValueError as exc:
            data, is_error = {"error": str(exc)}, True
        except Exception as exc:  # noqa: BLE001 — a tool failure is a result the model can read
            logger.exception("mcp tool %s failed", name)
            data, is_error = {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}, True
        # Rule 2: every call leaves a line, at warn, with how it went.
        logger.warning("mcp %s via %s → %s in %d ms", name, caller.get("via"),
                       "error" if is_error else "ok", int((time.time() - started) * 1000))
        text = json.dumps(data, ensure_ascii=False, default=str)
        result: dict = {"content": [{"type": "text", "text": text}], "isError": is_error}
        if isinstance(data, dict):
            result["structuredContent"] = data
        return _ok(id_, result)
    return _err(id_, -32601, f"method not found: {method}")


def _unauthorized(detail: str) -> JSONResponse:
    return JSONResponse(
        {"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": f"unauthorized: {detail}"}},
        status_code=401,
        headers={"WWW-Authenticate": 'Bearer realm="meira", error="invalid_token"'},
    )


@router.post("/mcp")
async def mcp_post(request: Request):
    try:
        caller = await authenticate(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return _unauthorized(str(exc))
    if not rate_limit.allow(f"mcp:{caller['key']}", MCP_LIMIT, MCP_WINDOW_S):
        return JSONResponse(_err(None, -32000, "too many requests"), status_code=429,
                            headers={"Retry-After": str(int(MCP_WINDOW_S))})
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(_err(None, -32700, "parse error"), status_code=400)

    if isinstance(body, list):
        if not body:
            return JSONResponse(_err(None, -32600, "empty batch"), status_code=400)
        out = [r for r in [await handle_message(caller, m) for m in body] if r is not None]
        return JSONResponse(out) if out else Response(status_code=202)
    resp = await handle_message(caller, body)
    return JSONResponse(resp) if resp is not None else Response(status_code=202)


@router.get("/mcp")
async def mcp_get():
    # Stateless server: no server-initiated stream. The spec's answer is 405.
    return Response(status_code=405, headers={"Allow": "POST"})


@router.delete("/mcp")
async def mcp_delete():
    return Response(status_code=405, headers={"Allow": "POST"})


# ── token management, for the app (Supabase-authenticated) ─────────────────

@router.post("/app/mcp/token")
async def create_token(request: Request):
    try:
        caller = await app_auth.identify(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — a label is optional
        body = {}
    issued = issue_token(caller, str((body or {}).get("label") or ""))
    base = str(request.base_url).rstrip("/").replace("http://", "https://")
    return {**issued, "url": f"{base}/mcp"}


@router.get("/app/mcp/tokens")
async def get_tokens(request: Request):
    try:
        caller = await app_auth.identify(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)
    return {"tokens": list_tokens(caller["key"])}


@router.delete("/app/mcp/token")
async def delete_tokens(request: Request, id: Optional[str] = None):
    try:
        caller = await app_auth.identify(request.headers.get("authorization"))
    except app_auth.AuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=401)
    return {"revoked": revoke_tokens(caller["key"], id)}
