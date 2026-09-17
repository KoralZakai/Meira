"""Registry of user-created agents (the "Lumi Agent Builder" store).

An agent is a ROW OF DATA, not a process: {name, emoji, soul (persona text),
schedule (weekdays + HH:MM Israel local), next_run}. agent_runner's poller
scans this store every minute and fires whatever is due — same flat-JSON,
survive-restarts design as reminders.py.

Design notes for AI agents / debugging:
- Storage: one JSON list in config.DATA_DIR/agents.json, ALL users together
  (the scheduler needs a cross-user scan; per-phone stores like user_memory
  can't give that cheaply). _load/_save mirror reminders.py exactly.
- `next_run` is PRECOMPUTED on every create/update/mark_ran by next_fire() —
  the poller never does schedule math, it only compares timestamps.
- `days` are Python weekday() ints, Mon=0..Sun=6 (same convention as
  lumi_agent.calculate_date). `time` is HH:MM Israel local; DST safety comes
  from attaching ZoneInfo IL per calendar date (like reminders.schedule).
- Templates are server-side constants; installing one = create_agent(template=...)
  which pre-fills every field. agent_runner keys its deterministic prefetch
  hooks off the `template` field.

Dependencies: config (DATA_DIR), tz (IL/now_il). Consumed by agent_runner
(due_agents/mark_ran), lumi_agent (create/list/update/delete tools) and
main.py (/agents REST endpoints).
"""
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, time as dtime
from typing import Optional

import config
import database_service
import secure_store
from tz import IL, now_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "agents.json")

MAX_AGENTS = 5          # per user — an agent run is an LLM call, cap the spend
SOUL_MAX_CHARS = 2000   # persona text cap

# Built-in agents users can install with one tap / one sentence.
# `soul` is the persona; the DETERMINISTIC data work (routes, wake math) is
# done by agent_runner's per-template prefetch hooks, not by this text.
TEMPLATES: dict[str, dict] = {
    "morning_planner": {
        "name": "Morning Planner",
        "emoji": "🌅",
        "soul": (
            "You are the user's upbeat morning planner. You receive today's "
            "facts: profile, tasks, and REAL precomputed routes. Write a short "
            "WhatsApp morning brief: greet by name, list today's schedule in "
            "time order with category emojis, paste any route lines VERBATIM, "
            "flag the day's single most important task, end with one short "
            "encouragement. Never invent times, stations or tasks."
        ),
        "schedule": {"days": [6, 0, 1, 2, 3], "time": "07:00"},  # Sun-Thu (IL week)
    },
    "smart_alarm": {
        "name": "Evening Planner",
        "emoji": "⏰",
        "soul": (
            "You are the user's evening planner and smart alarm. You receive "
            "tomorrow's tasks, PRECOMPUTED wake-up/bedtime times, and real "
            "routes. Write a short WhatsApp evening brief: 1) tomorrow's "
            "schedule in time order; 2) the given wake time and bedtime "
            "(in Hebrew always call the morning prep 'שגרת בוקר' — never "
            "'שחרית'); 3) paste route lines VERBATIM and state when to leave; "
            "4) one practical PREP tip per major task — for a job interview "
            "suggest researching the company and preparing questions, for an "
            "exam suggest reviewing notes, for a meeting suggest an agenda. "
            "Reminders are already scheduled — say so. Never recompute or "
            "change the given times; never invent tasks or routes."
        ),
        "schedule": {"days": [5, 6, 0, 1, 2], "time": "21:30"},  # eve before Sun-Thu
    },
    # "hr_job_search" (Job Scout) lived here until 2026-09-07. Removed with
    # hr_agent; a stored agent still carrying that template now runs through the
    # ordinary _compose path instead of a pipeline that no longer exists.
}


def _load() -> list:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: agent personas bound to a phone. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, [])


def _save(items) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, items)


def next_fire(days: list[int], hhmm: str, after: datetime) -> Optional[datetime]:
    """Next Israel-local datetime STRICTLY after `after` matching days+time.
    None when days is empty (a disabled schedule). DST-safe: tzinfo attached
    per calendar date, so 07:00 local stays 07:00 across transitions."""
    if not days:
        return None
    try:
        h, m = (int(x) for x in hhmm.split(":"))
    except (ValueError, AttributeError):
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):  # "25:99" parses as ints — reject here
        return None
    base = after.astimezone(IL).date()
    for d in range(8):  # 8 covers a today-past-time single-day week wrap
        day = base + timedelta(days=d)
        if day.weekday() in days:
            cand = datetime.combine(day, dtime(hour=h, minute=m), tzinfo=IL)
            if cand > after:
                return cand
    return None


def _recompute(agent: dict, after: Optional[datetime] = None) -> None:
    """Refresh agent['next_run'] from its schedule (None when disabled)."""
    if not agent.get("enabled"):
        agent["next_run"] = None
        return
    sched = agent.get("schedule") or {}
    nxt = next_fire(sched.get("days") or [], sched.get("time") or "", after or now_il())
    agent["next_run"] = nxt.isoformat() if nxt else None


def list_agents(phone: str) -> list:
    return [a for a in _load() if a.get("phone") == phone]


def get_agent(phone: str, agent_id: str) -> Optional[dict]:
    return next((a for a in _load()
                 if a.get("phone") == phone and a.get("id") == agent_id), None)


def create_agent(
    phone: str,
    *,
    name: Optional[str] = None,
    soul: Optional[str] = None,
    days: Optional[list] = None,
    time: Optional[str] = None,
    emoji: str = "🤖",
    template: Optional[str] = None,
    watch: Optional[str] = None,
    created_via: str = "app",
) -> dict:
    """Create (or install a template) agent. Returns the agent dict, or
    {'error': ...} — 'limit' at the per-user cap, 'invalid' on bad input."""
    items = _load()
    mine = [a for a in items if a.get("phone") == phone]
    if len(mine) >= MAX_AGENTS:
        return {"error": "limit", "max": MAX_AGENTS}

    tpl = TEMPLATES.get(template or "")
    if template and not tpl:
        return {"error": "invalid", "message": f"unknown template '{template}'"}
    if tpl:
        # One template instance per user — installing twice edits nothing.
        if any(a.get("template") == template for a in mine):
            return {"error": "invalid", "message": "template already installed"}
        name = name or tpl["name"]
        emoji = tpl["emoji"]
        soul = soul or tpl["soul"]
        days = days if days is not None else tpl["schedule"]["days"]
        time = time or tpl["schedule"]["time"]

    days = [d for d in (days or []) if isinstance(d, int) and 0 <= d <= 6]
    if not (name and soul and days and time):
        return {"error": "invalid",
                "message": "need name, soul, days (0=Mon..6=Sun) and time (HH:MM)"}
    if next_fire(days, time, now_il()) is None:
        return {"error": "invalid", "message": f"bad time '{time}' — use HH:MM"}

    agent = {
        "id": f"ag_{uuid.uuid4().hex[:8]}",
        "phone": phone,
        "name": str(name)[:60],
        "emoji": emoji,
        "soul": str(soul)[:SOUL_MAX_CHARS],
        "template": template,
        # A live search query this agent re-runs each time it fires. Without
        # one an agent can only phrase facts we already hold, which is why a
        # "news agent" used to be a personality with nothing to report.
        "watch": (str(watch)[:200] or None) if watch else None,
        "schedule": {"days": sorted(set(days)), "time": time},
        "enabled": True,
        "created_via": created_via,
        "next_run": None,
        "last_run": None,
        "run_count": 0,
    }
    _recompute(agent)
    items.append(agent)
    _save(items)
    database_service.shadow_write(database_service.save_agent(phone, agent))
    logger.info("agent created %s (%s) for %s next_run=%s",
                agent["id"], agent["name"], phone, agent["next_run"])
    return agent


def update_agent(phone: str, agent_id: str, patch: dict) -> Optional[dict]:
    """Patch name/emoji/soul/enabled/days/time/watch; recomputes next_run. None if missing."""
    items = _load()
    agent = next((a for a in items
                  if a.get("phone") == phone and a.get("id") == agent_id), None)
    if not agent:
        return None
    for k in ("name", "emoji", "enabled"):
        if k in patch and patch[k] is not None:
            agent[k] = patch[k]
    if patch.get("soul") is not None:
        agent["soul"] = str(patch["soul"])[:SOUL_MAX_CHARS]
    if "watch" in patch:
        # Empty string clears it — "stop following that" must be expressible.
        agent["watch"] = (str(patch["watch"])[:200] or None) if patch["watch"] else None
    sched = agent.setdefault("schedule", {})
    if patch.get("days") is not None:
        sched["days"] = sorted({d for d in patch["days"]
                                if isinstance(d, int) and 0 <= d <= 6})
    if patch.get("time") is not None:
        sched["time"] = patch["time"]
    _recompute(agent)
    _save(items)
    database_service.shadow_write(database_service.save_agent(phone, agent))
    return agent


def delete_agent(phone: str, agent_id: str) -> bool:
    items = _load()
    kept = [a for a in items
            if not (a.get("phone") == phone and a.get("id") == agent_id)]
    if len(kept) == len(items):
        return False
    _save(kept)
    database_service.shadow_write(database_service.delete_agent(agent_id))
    return True


def due_agents(now: datetime) -> list[dict]:
    """Enabled agents whose next_run has arrived (oldest first)."""
    due = []
    for a in _load():
        nr = a.get("next_run")
        if not (a.get("enabled") and nr):
            continue
        try:
            if datetime.fromisoformat(nr) <= now:
                due.append(a)
        except ValueError:
            logger.warning("agent %s has bad next_run %r", a.get("id"), nr)
    due.sort(key=lambda a: a["next_run"])
    return due


def mark_ran(agent_id: str, now: datetime) -> None:
    """Stamp last_run/run_count and advance next_run past `now`. ALWAYS called
    after a fire attempt (success, fallback or skip) so a broken agent can
    never hot-loop the poller."""
    items = _load()
    agent = next((a for a in items if a.get("id") == agent_id), None)
    if not agent:
        return
    agent["last_run"] = now.isoformat()
    agent["run_count"] = int(agent.get("run_count") or 0) + 1
    _recompute(agent, after=now)
    _save(items)
