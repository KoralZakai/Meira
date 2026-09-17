"""Executor for user-created agents (see agents_store.py for what an agent IS).

A 60s poller fires due agents. Each run is: deterministic PREFETCH of facts
(profile, memory, tasks — and for templates, precomputed routes / wake math)
→ ONE LLM completion that only PHRASES those facts in the agent's persona →
WhatsApp send. The agent LLM gets ZERO tools: every number, station and time
in its output already exists in the facts block, so it cannot invent routes
(same anti-fabrication invariant as lumi_agent) and cannot message anyone
but its owner.

Failure design: 1 transient retry → template agents fall back to sending the
raw facts block (always sendable), custom agents skip+log. mark_ran ALWAYS
advances next_run, so a broken agent can never hot-loop the poller.

Dependencies: agents_store (due_agents/mark_ran/TEMPLATES), user_profile +
user_memory (facts), geo.plan_departure (morning routes), reminders.schedule
(smart-alarm wake row), whatsapp_service (delivery), config (LLM creds),
tz. Started once in main.lifespan next to run_reminder_loop.
"""
import asyncio
import logging
import re
from datetime import datetime, timedelta, time as dtime
from typing import Optional

from openai import AsyncOpenAI, APIConnectionError, APITimeoutError

import agents_store
import config
import tavily_search
import model_router
import geo
import llm_usage
import reminders
import user_memory
import user_profile
from tz import IL, now_il, today_il
from whatsapp_service import WhatsAppService

logger = logging.getLogger(__name__)

_POLL_SECONDS = 60
GRACE_MINUTES = 30      # overdue past this (deploy/downtime) → skip, don't send stale brief
_MAX_ROUTE_CALLS = 3    # bound Google Directions work inside a poller tick
_ROUTE_TIMEOUT_S = 10
_OUTPUT_MAX_CHARS = 1200

# Same fabrication guard as lumi_agent: transit-emoji/time lines are only legal
# when we prefetched real route facts this run.
_ROUTE_LINE_RE = re.compile(
    r"[🚶🚆🚄🚌🚇🚋🚗🚲]|(?:לצאת|עזיבה|הגעה|leave|arrive|wake|קימה|להתעורר).*\d{1,2}:\d{2}")

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _client


def _is_transient(exc: Exception) -> bool:
    if isinstance(exc, (APIConnectionError, APITimeoutError)):
        return True
    msg = str(exc).lower()
    return "rate limit" in msg or "503" in msg or "overloaded" in msg


def _sub_minutes(hhmm: str, minutes: int) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = (h * 60 + m - minutes) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def _today_tasks(phone: str, day: str) -> list:
    """Active tasks for one date, fixed-timed first — memory store only (the
    runner must stay cheap; Supabase mirrors the same rows anyway)."""
    rows = [t for t in user_memory.tasks_for_phone(phone)
            if t.get("date") == day and t.get("status") not in ("moved", "complete")]
    rows.sort(key=lambda t: (t.get("fixed_time") is None, t.get("fixed_time") or ""))
    return rows


def _upcoming_tasks(phone: str, start: str, days: int = 7) -> list:
    """Active tasks in the next `days` days AFTER `start` (exclusive), sorted by
    date then time. Lets a briefing surface an interview tomorrow / a party on
    Tuesday instead of only what falls on the exact day."""
    from datetime import date as _date, timedelta
    y, m, d = (int(x) for x in start.split("-"))
    s = _date(y, m, d)
    window = {(s + timedelta(days=i)).isoformat() for i in range(1, days + 1)}
    rows = [t for t in user_memory.tasks_for_phone(phone)
            if t.get("date") in window and t.get("status") not in ("moved", "complete")]
    rows.sort(key=lambda t: (t.get("date") or "", t.get("fixed_time") is None,
                             t.get("fixed_time") or ""))
    return rows


def _upcoming_lines(rows: list) -> str:
    lines = []
    for t in rows:
        when = t.get("fixed_time") or "flexible"
        loc = t.get("location")
        loc_s = loc if isinstance(loc, str) else \
            ((loc or {}).get("displayName") or (loc or {}).get("address") or "")
        lines.append(f"- {t.get('date', '')} {when} · {t.get('text', '')}"
                     + (f" @ {loc_s}" if loc_s else ""))
    return "\n".join(lines)


def _task_lines(rows: list) -> str:
    lines = []
    for t in rows:
        when = t.get("fixed_time") or "flexible"
        loc = t.get("location")
        loc_s = loc if isinstance(loc, str) else \
            ((loc or {}).get("displayName") or (loc or {}).get("address") or "")
        lines.append(f"- {when} · {t.get('text', '')}" + (f" @ {loc_s}" if loc_s else ""))
    return "\n".join(lines) if lines else "(no tasks saved)"


def _profile_block(prof: dict) -> str:
    bits = []
    if prof.get("name"):
        bits.append(f"Name: {prof['name']}")
    if prof.get("transportType"):
        bits.append(f"Usual transport: {prof['transportType']}")
    if prof.get("morningRoutineMinutes"):
        bits.append(f"Morning routine: {prof['morningRoutineMinutes']} min")
    return "\n".join(bits)


async def _watch_facts(agent: dict) -> str:
    """What the world did since this agent last ran.

    An agent without this can only re-phrase facts we already hold — which is
    why a "news agent" was a personality with nothing to report. `watch` is a
    search query stored on the agent; one news search, last 7 days, and the
    headlines go in as facts with their links.

    Returns "" on anything unusual (no watch, search down, nothing recent).
    An agent that fires with no news must simply not mention news, never
    apologise for a missing tool.
    """
    query = (agent.get("watch") or "").strip()
    if not query or not tavily_search.is_configured():
        return ""
    res = await tavily_search.search(query, max_results=4, topic="news", days=7)
    if not res.get("ok") or not res.get("results"):
        return ""
    lines = "\n".join(
        f"- {r['title']} ({r['link']})\n  {(r['snippet'] or '')[:300]}"
        for r in res["results"])
    return ("LIVE — what happened in the last 7 days on "
            f"'{query}'. State ONLY these, with the link, or say nothing:\n" + lines)


def _default_facts(phone: str, prof: dict) -> str:
    """Facts every agent gets: profile + distilled memory + today's tasks."""
    today = today_il().isoformat()
    parts = [f"Date: {today}", _profile_block(prof)]
    mem = user_memory.format_for_prompt(phone)
    if mem:
        parts.append(mem)
    parts.append("TODAY'S TASKS:\n" + _task_lines(_today_tasks(phone, today)))
    upcoming = _upcoming_tasks(phone, today, days=7)
    if upcoming:
        parts.append("UPCOMING (next 7 days) — mention what's soon, esp. "
                     "interviews/deadlines, and offer to prep:\n" + _upcoming_lines(upcoming))
    return "\n\n".join(p for p in parts if p)


async def _morning_facts(phone: str, prof: dict) -> tuple[str, bool]:
    """Default facts + REAL routes for today's located+timed tasks.
    Returns (facts, has_route) — has_route gates the output strip-guard."""
    facts = _default_facts(phone, prof)
    home = prof.get("homeAddress")
    if not home:
        return facts, False
    today = today_il().isoformat()
    located = [t for t in _today_tasks(phone, today)
               if t.get("fixed_time") and t.get("location")][:_MAX_ROUTE_CALLS]
    routes = []
    for t in located:
        loc = t["location"]
        dest = loc if isinstance(loc, str) else \
            (loc.get("address") or loc.get("displayName"))
        if not dest:
            continue
        try:
            res = await asyncio.wait_for(
                geo.plan_departure(
                    destination=dest,
                    arrival_hhmm=str(t["fixed_time"])[:5],
                    home_address=home,
                    transport=prof.get("transportType") or "car",
                    routine_minutes=prof.get("morningRoutineMinutes", 45),
                    buffer_minutes=prof.get("wakeBufferMinutes", 10),
                ),
                timeout=_ROUTE_TIMEOUT_S,
            )
            plan = res.get("plan") if res.get("ok") else None
            if plan and plan.get("routeText"):
                routes.append(f"ROUTE for '{t.get('text', '')}' (paste VERBATIM):\n"
                              f"{plan['routeText']}")
        except Exception as exc:  # noqa: BLE001 — a dead route never kills the brief
            logger.warning("morning route for %s failed: %s", dest, exc)
    if routes:
        return facts + "\n\n" + "\n\n".join(routes), True
    return facts + "\n\n(couldn't fetch live routes — don't invent any)", False


def _task_dest(t: dict) -> Optional[str]:
    loc = t.get("location")
    return loc if isinstance(loc, str) else \
        ((loc or {}).get("address") or (loc or {}).get("displayName"))


async def _alarm_facts(phone: str, prof: dict, agent_id: str) -> tuple[str, bool]:
    """Tomorrow, fully planned the evening before: task list, precomputed
    wake + bedtime off the FIRST appointment, real routes for every located
    task (bounded), and SCHEDULED wake + leave reminders (idempotent per
    agent+day via reminders' dup keys). Returns (facts, has_route)."""
    tomorrow = (today_il() + timedelta(days=1)).isoformat()
    all_rows = _today_tasks(phone, tomorrow)
    fixed = [t for t in all_rows if t.get("fixed_time")]
    if not fixed:
        return (f"Date: {today_il().isoformat()}\nTomorrow ({tomorrow}) has no "
                "fixed-time appointments. Tasks (if any):\n"
                + _task_lines(all_rows)
                + "\nSuggest a normal night; no alarm set."), False

    routine = prof.get("morningRoutineMinutes", 45)
    buffer_min = prof.get("wakeBufferMinutes", 10)
    home = prof.get("homeAddress")

    # Real routes for tomorrow's located+timed tasks (first one drives the wake).
    plans: dict[str, dict] = {}  # task id -> plan
    if home:
        for t in [t for t in fixed if _task_dest(t)][:_MAX_ROUTE_CALLS]:
            try:
                res = await asyncio.wait_for(
                    geo.plan_departure(
                        destination=_task_dest(t), arrival_hhmm=str(t["fixed_time"])[:5],
                        home_address=home,
                        transport=prof.get("transportType") or "car",
                        routine_minutes=routine, buffer_minutes=buffer_min,
                    ),
                    timeout=_ROUTE_TIMEOUT_S,
                )
                if res.get("ok"):
                    plans[str(t.get("id"))] = res["plan"]
            except Exception as exc:  # noqa: BLE001
                logger.warning("evening route for %s failed: %s", _task_dest(t), exc)

    first = fixed[0]
    first_hhmm = str(first["fixed_time"])[:5]
    first_plan = plans.get(str(first.get("id")))
    travel = int((first_plan or {}).get("travelMinutes") or 0)
    wake = _sub_minutes(first_hhmm, travel + routine + buffer_min)
    bedtime = _sub_minutes(wake, 8 * 60)
    reminders.schedule(
        phone, wake, f"⏰ קימה! {first.get('text', '')} ב-{first_hhmm}",
        day=tomorrow, dest_key=f"agent:{agent_id}")

    # A leave-home nudge per planned task ("מתי לצאת מהבית").
    route_blocks = []
    for t in fixed:
        plan = plans.get(str(t.get("id")))
        if not plan:
            continue
        leave = plan.get("leaveHomeBy")
        if leave:
            reminders.schedule(
                phone, leave, f"🚪 לצאת עכשיו! {t.get('text', '')} ב-{str(t['fixed_time'])[:5]}",
                day=tomorrow, dest_key=f"agent:{agent_id}:leave:{t.get('id')}")
        if plan.get("routeText"):
            route_blocks.append(
                f"ROUTE for '{t.get('text', '')}' (paste VERBATIM):\n{plan['routeText']}")

    facts = (
        f"Tomorrow ({tomorrow}) schedule:\n{_task_lines(all_rows)}\n\n"
        f"PRECOMPUTED (state these, never change them):\n"
        f"- Wake up: {wake} (first: {first.get('text', '')} at {first_hhmm}; "
        f"travel {travel} min + routine {routine} min + buffer {buffer_min} min)\n"
        f"- Recommended bedtime tonight: {bedtime} (8h sleep)\n"
        f"- Wake + leave reminders: scheduled"
        + ("\n\n" + "\n\n".join(route_blocks) if route_blocks else "")
    )
    return facts, bool(route_blocks)


async def _compose(agent: dict, facts: str, language: str) -> Optional[str]:
    """The single LLM call: persona phrases the facts. None on failure."""
    lang_name = "Hebrew" if language == "he" else "English"
    system = (
        f"{agent.get('soul', '')}\n\n"
        f"HARD RULES: Reply ONLY in {lang_name}. Max 8 short WhatsApp lines. "
        "Use ONLY the facts given — never invent tasks, times, stations or "
        "routes. Route lines marked VERBATIM must be pasted unchanged. "
        "This is a one-way morning message: no questions that need an answer."
    )
    _model = model_router.pick("agent", prompt_chars=len(system) + len(facts))
    last_exc: Optional[Exception] = None
    for attempt in range(2):  # 1 try + 1 transient retry
        try:
            resp = await _get_client().chat.completions.create(
                model=_model,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": facts}],
                max_tokens=400,
                temperature=0.4,
            )
            u = getattr(resp, "usage", None)
            if u:
                llm_usage.record("agent", u.prompt_tokens or 0, u.completion_tokens or 0, _model)
            text = (resp.choices[0].message.content or "").strip()
            return text or None
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if not _is_transient(exc):
                break
            await asyncio.sleep(1.5)
    logger.error("agent %s compose failed: %s", agent.get("id"), last_exc)
    return None


async def _run_agent(agent: dict) -> None:
    # The hr_job_search template used to be intercepted here and handed to its
    # own multi-result pipeline. That agent is gone; a stored agent still
    # carrying the old template now falls through to the normal _compose path
    # rather than crashing the poller on a missing module.
    phone = agent["phone"]
    prof = user_profile.get_profile(phone)
    language = prof.get("language") or "he"
    template = agent.get("template")

    has_route = False
    if template == "morning_planner":
        facts, has_route = await _morning_facts(phone, prof)
    elif template == "smart_alarm":
        facts, _routes = await _alarm_facts(phone, prof, agent["id"])
        has_route = True  # wake/bedtime/leave times in output are precomputed — legal
    else:
        facts = _default_facts(phone, prof)

    # Whatever this agent watches, appended for EVERY kind — a morning planner
    # that also follows one topic is a perfectly ordinary thing to want.
    watched = await _watch_facts(agent)
    if watched:
        facts = f"{facts}\n\n{watched}"

    text = await _compose(agent, facts, language)
    if not text:
        if template:
            text = facts  # templates: raw facts still beat silence
        else:
            logger.warning("custom agent %s produced nothing — skipped", agent["id"])
            return
    if not has_route:
        # No prefetched routes → any transit/time line is invented. Strip.
        kept = [ln for ln in text.split("\n") if not _ROUTE_LINE_RE.search(ln)]
        if len(kept) < len(text.split("\n")):
            logger.warning("agent %s: stripped invented route-looking line(s)", agent["id"])
        text = "\n".join(kept).strip() or text[:200]
    text = f"{agent.get('emoji', '🤖')} {agent.get('name', 'Agent')}\n{text}"[:_OUTPUT_MAX_CHARS]
    await WhatsAppService.send_message(phone, text)
    logger.info("agent %s (%s) fired for %s", agent["id"], agent.get("name"), phone)


async def run_due(now: Optional[datetime] = None) -> int:
    """Fire every due agent once. Testable core of the loop. Returns #fired."""
    now = now or now_il()
    fired = 0
    for agent in agents_store.due_agents(now):
        try:
            overdue_min = (now - datetime.fromisoformat(agent["next_run"])).total_seconds() / 60
            if overdue_min > GRACE_MINUTES:
                logger.warning("agent %s overdue %.0f min — skipping stale run",
                               agent["id"], overdue_min)
            else:
                await _run_agent(agent)
                fired += 1
        except Exception as exc:  # noqa: BLE001 — one agent's crash never stops the rest
            logger.error("agent %s run failed: %s", agent.get("id"), exc)
        finally:
            agents_store.mark_ran(agent["id"], now)  # ALWAYS advance — no hot-loop
    return fired


async def run_agent_loop() -> None:
    """60s poller. Same never-die design as reminders.run_reminder_loop."""
    logger.info("agent runner started")
    while True:
        try:
            await run_due()
        except Exception as exc:  # noqa: BLE001
            logger.error("agent loop tick failed: %s", exc)
        await asyncio.sleep(_POLL_SECONDS)
