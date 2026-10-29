"""Per-person AI spend limits — one heavy user cannot run up the bill.

LLM_MONTHLY_BUDGET_USD caps the whole server; this caps each PERSON, so a
single enthusiastic tester cannot spend everyone's month. Priced in dollars
with llm_usage.PRICES, not raw tokens: a nano token costs a fifth of a super
token, and "tokens" would punish exactly the cheap calls we want to keep.

Who is paying is a ContextVar, set at every entry that serves a person:
  agent_turn.run_turn         app chat, MCP
  lumi_agent.handle_whatsapp_message   WhatsApp (and run_turn's inner call)
  app_auth.require_caller     every /app/* route (understand, extraction, briefs…)
  agent_runner._run_agent     her scheduled personal agents
llm_usage.record() charges whoever is current. Asyncio tasks copy the context,
so background work started inside a request is charged to the same person.

Levels, per day AND per month (whichever is worse):
  ok     — normal
  soft   — past USER_LLM_SOFT_PCT: every call for this person runs on the
           small tier (model_router). Cheaper, still answers.
  over   — past 100%: the chat/agent turn is NOT run; she gets one short line
           saying so and when it resets (rule 1: a refusal names its reason).
           Planning, routes, alarms and alerts are code, not model calls —
           they keep working.

Config (Fly secrets; 0 = no limit):
  USER_LLM_DAILY_USD    default 0.15   (~15 chat turns on the medium tier)
  USER_LLM_MONTHLY_USD  default 1.50
  USER_LLM_EXEMPT       comma-separated person keys with no limit (the owner)
  USER_AI_DAILY_REQUESTS default 10 — requests a day that use the AI, per
                        person, for EVERYONE incl. the free seats (7.10, Koral:
                        "up to 10 LLM calls a day"). One chat message, one mic
                        command, one brief = one request, however many model
                        calls it takes. Enforced at the transport (ai_gate) and
                        told to her at the chat entries. 0 = no limit.
  USER_LLM_FREE_SEATS   default 20 — the first N people to use Meira have NO
                        limit and are never moved to the small tier (7.10, the
                        tester month: "don't try to save"). Seats go by first
                        use; person #N+1 onwards gets the limits above, so a
                        link that spreads cannot drain the prepaid balance.
"""
from __future__ import annotations

import contextvars
import logging
import os
import re
from datetime import timedelta
from typing import Optional

import config
import secure_store
from tz import now_il, today_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "llm_usage_people.json")
_KEEP_DAYS = 40

_current: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("llm_person", default=None)
# The request being served: {"person", "counted"}. Shared (a dict, not a value)
# by everything the request spawns, so the judge that runs after a turn does
# not count as a second request.
_request: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("llm_request", default=None)


def _num(name: str, default: str) -> float:
    try:
        return max(0.0, float(os.getenv(name, default) or 0))
    except ValueError:
        logger.warning("user_quota: %s is not a number, using %s", name, default)
        return float(default)


def daily_limit() -> float:
    return _num("USER_LLM_DAILY_USD", "0.15")


def monthly_limit() -> float:
    return _num("USER_LLM_MONTHLY_USD", "1.50")


def daily_requests() -> int:
    return int(_num("USER_AI_DAILY_REQUESTS", "10"))


def free_seats() -> int:
    return int(_num("USER_LLM_FREE_SEATS", "20"))


_FIRST = "_first"   # inside a person's row: when they first used Meira (never pruned)


def _days(row: dict) -> dict:
    return {d: v for d, v in (row or {}).items() if not d.startswith("_")}


def _seated(person: str, data: Optional[dict] = None) -> bool:
    """One of the first USER_LLM_FREE_SEATS people to use Meira?"""
    n = free_seats()
    if n <= 0:
        return False
    data = _load() if data is None else data
    def first(p: str) -> str:
        row = data.get(p) or {}
        return row.get(_FIRST) or min(_days(row) or {"9999": 0})
    order = sorted(data, key=lambda p: (first(p), p))
    if person not in data:
        return len(order) < n          # a newcomer still gets a seat while seats are left
    return order.index(person) < n


def _exempt() -> set[str]:
    return {k.strip() for k in os.getenv("USER_LLM_EXEMPT", "").split(",") if k.strip()}


# ── who is paying ────────────────────────────────────────────────────────────

def person_of(key: object) -> Optional[str]:
    """The one key a person is charged under — the same resolver the stores use,
    so her WhatsApp number and her app account share ONE allowance."""
    if not key:
        return None
    try:
        import identity_keys
        return identity_keys.canonical(key) or str(key)
    except Exception as exc:  # noqa: BLE001 — never lose the charge over a lookup
        logger.warning("user_quota: canonical(%s) failed: %s", key, exc)
        return str(key)


def set_person(key: object, new_request: bool = False) -> Optional[str]:
    """Mark who the calls from here on are for. Returns the resolved key.

    Within one request (require_caller → run_turn → handle_whatsapp_message all
    name the same person) the request is kept, so it counts once. A long-lived
    loop serving many requests (agent_runner) passes new_request=True."""
    person = person_of(key)
    if person:
        _current.set(person)
        held = _request.get()
        if new_request or not held or held.get("person") != person:
            _request.set({"person": person, "counted": False})
    return person


def current() -> Optional[str]:
    return _current.get()


def free_request() -> None:
    """This request spends none of today's requests — the first meeting
    (8.10, Koral: onboarding must not use up a new user's day; ~10 answers
    against 15 a day). Its dollars are still charged to her, and the
    balance stop (ai_gate.closed) still applies to it like to everything."""
    person = current()
    if person:
        _request.set({"person": person, "counted": True})


# ── the ledger ───────────────────────────────────────────────────────────────

def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _today_row(data: dict, person: str) -> dict:
    """This person's row for today, pruned, with _first stamped."""
    day = today_il().isoformat()
    cutoff = (today_il() - timedelta(days=_KEEP_DAYS)).isoformat()
    # {person: {day: row}} — keyed by person first, so account_deletion's
    # generic purge (drop the person's top-level key) erases it.
    old = data.get(person) or {}
    days = {d: v for d, v in _days(old).items() if d >= cutoff}
    # A timestamp, not a date: two testers who start on the same day must
    # still get seats in the order they arrived, not alphabetically.
    days[_FIRST] = old.get(_FIRST) or min(_days(old) or {now_il().isoformat(): 0})
    data[person] = days
    return days.setdefault(day, {"usd": 0.0, "in": 0, "out": 0, "calls": 0})


def _counted_now(person: str) -> bool:
    held = _request.get()
    return bool(held and held.get("person") == person and held.get("counted"))


def requests_today(person: str) -> int:
    days = _days(_load().get(person) or {})
    return int((days.get(today_il().isoformat()) or {}).get("requests", 0))


def admit() -> Optional[str]:
    """Called by ai_gate before EVERY model call. The first call of a request
    spends one of today's requests; later calls of the same request are free.
    Returns 'requests' when today's are used up, else None."""
    person = current()
    limit = daily_requests()
    if not person or limit <= 0 or person in _exempt() or _counted_now(person):
        return None
    try:
        data = _load()
        row = _today_row(data, person)
        used = int(row.get("requests", 0))
        if used >= limit:
            return "requests"
        row["requests"] = used + 1
        _save(data)
    except Exception as exc:  # noqa: BLE001 — the balance stop still backs this
        logger.warning("user_quota: request count failed, letting the call through: %s", exc)
        return None
    held = _request.get()
    if held and held.get("person") == person:
        held["counted"] = True
    else:
        _request.set({"person": person, "counted": True})
    return None


def charge(model: Optional[str], tokens_in: int, tokens_out: int) -> None:
    """Add one call to the current person's day. Best-effort — never raises."""
    person = current()
    if not person or not (tokens_in or tokens_out):
        return
    try:
        import llm_usage
        cost = llm_usage._cost(int(tokens_in), int(tokens_out), model or config.LLM_MODEL)
        data = _load()
        row = _today_row(data, person)
        row["usd"] = round(row["usd"] + cost, 6)
        row["in"] += int(tokens_in)
        row["out"] += int(tokens_out)
        row["calls"] += 1
        _save(data)
    except Exception as exc:  # noqa: BLE001 — accounting must never break a reply
        logger.warning("user_quota: charge failed: %s", exc)


def spent(person: str) -> tuple[float, float]:
    """(today, this month) in USD for this person."""
    days = _days(_load().get(person) or {})
    today = today_il().isoformat()
    month = today[:7]
    day_usd = float((days.get(today) or {}).get("usd", 0.0))
    month_usd = sum(float(row.get("usd", 0.0)) for d, row in days.items() if d[:7] == month)
    return day_usd, month_usd


def state(person: Optional[str] = None) -> dict:
    """{'level': 'ok'|'soft'|'over', 'period': 'balance'|'requests'|'day'|'month'|None, …}."""
    person = person or current()
    try:
        import ai_gate
        if ai_gate.closed():      # the prepaid balance is physical: no exemption
            return {"level": "over", "period": "balance"}
    except Exception as exc:  # noqa: BLE001 — the transport still enforces it
        logger.warning("user_quota: balance check failed: %s", exc)
    if not person or person in _exempt():
        return {"level": "ok", "period": None, "exempt": bool(person)}
    limit = daily_requests()
    if limit > 0 and not _counted_now(person):
        try:
            used = requests_today(person)
        except Exception as exc:  # noqa: BLE001
            logger.warning("user_quota: request count unreadable: %s", exc)
            used = 0
        if used >= limit:
            return {"level": "over", "period": "requests",
                    "requests_today": used, "requests_limit": limit}
    try:
        if _seated(person):
            return {"level": "ok", "period": None, "seat": True}
    except Exception as exc:  # noqa: BLE001 — fall through to the normal limits
        logger.warning("user_quota: seat check failed: %s", exc)
    try:
        day_usd, month_usd = spent(person)
    except Exception as exc:  # noqa: BLE001 — an unreadable ledger must not lock her out
        logger.warning("user_quota: ledger unreadable, not limiting: %s", exc)
        return {"level": "ok", "period": None, "error": str(exc)}
    soft = config.LLM_BUDGET_SOFT_PCT
    worst, period = 0.0, None
    for used, limit, name in ((day_usd, daily_limit(), "day"), (month_usd, monthly_limit(), "month")):
        if limit > 0 and used / limit > worst:
            worst, period = used / limit, name
    level = "over" if worst >= 1.0 else ("soft" if worst >= soft else "ok")
    return {"level": level, "period": period, "used_pct": round(worst * 100),
            "today_usd": round(day_usd, 4), "month_usd": round(month_usd, 4),
            "daily_limit_usd": daily_limit(), "monthly_limit_usd": monthly_limit()}


def tier_ceiling() -> Optional[str]:
    """For model_router: the highest tier the current person may use, or None."""
    st = state()
    if st["level"] in ("soft", "over"):
        import model_router
        return model_router.SMALL
    return None


def blocked_reply(person: Optional[str], content: str = "", language: str = "") -> Optional[str]:
    """The one line she gets instead of a turn when over the limit, else None."""
    st = state(person)
    if st["level"] != "over":
        return None
    he = language == "he" or bool(re.search(r"[֐-׿]", content or ""))
    logger.warning("user_quota: %s is over the %s limit (%s%%) — turn not run",
                   person, st["period"], st.get("used_pct"))
    if st["period"] == "balance":
        return ("הצ׳אט עם מאירה מושהה כרגע 🙏 התכנון, המסלולים וההתראות ממשיכים לעבוד כרגיל.") if he else (
                "Chat with Meira is paused right now 🙏 Your plan, routes and alerts keep working.")
    if st["period"] == "requests":
        n = st.get("requests_limit", daily_requests())
        return (f"הגעת ל-{n} הפניות היומיות למאירה 🙏 התכנון, המסלולים וההתראות ממשיכים לעבוד. "
                "נמשיך מחר.") if he else (
                f"You've used today's {n} requests to Meira 🙏 Your plan, routes and alerts keep "
                "working. Back tomorrow.")
    if st["period"] == "month":
        return ("הגעת למכסת השיחה החודשית עם מאירה 🙏 התכנון, המסלולים וההתראות ממשיכים לעבוד כרגיל. "
                "השיחה חוזרת ב-1 לחודש.") if he else (
                "You've reached this month's chat limit with Meira 🙏 Your plan, routes and alerts "
                "keep working. Chat is back on the 1st.")
    return ("הגעת למכסת השיחה היומית עם מאירה 🙏 התכנון, המסלולים וההתראות ממשיכים לעבוד כרגיל. "
            "נמשיך מחר.") if he else (
            "You've reached today's chat limit with Meira 🙏 Your plan, routes and alerts keep "
            "working. Back tomorrow.")


def top(n: int = 10) -> list[dict]:
    """The heaviest people this month — for the admin /usage view."""
    month = today_il().isoformat()[:7]
    totals: dict[str, float] = {}
    for person, days in _load().items():
        totals[person] = sum(float(row.get("usd", 0.0)) for d, row in _days(days).items() if d[:7] == month)
    ranked = sorted(((p, u) for p, u in totals.items() if u > 0), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"person": p, "month_usd": round(u, 4), "requests_today": requests_today(p),
             "level": state(p)["level"]} for p, u in ranked]
