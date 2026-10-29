"""harness — run one simulated request through the REAL turn code.

`run_request` calls agent_turn.run_turn — the same function POST /agent/chat and
the WhatsApp webhook call — with the fake model (evals.fakes) answering where
Nebius would, and returns an Outcome carrying the reply plus the Trace of
everything that happened on the way.

It does NOT stub the tools, the guards, the persistence or the rescue paths:
those are what is being measured.
"""
from __future__ import annotations

import asyncio
import itertools
import time
from dataclasses import dataclass, field
from typing import Optional

from evals import trace as trace_mod
from evals.trace import Trace

_COUNTER = itertools.count(1)

#: Fixed "today" for suites that need reproducible dates is NOT applied to agent
#: turns (the agent reads the real clock); scenarios therefore build dates
#: relative to tz.today_il() at run time.


def new_user(tag: str = "u", language: str = "he") -> dict:
    """A fresh eval person with a complete profile (so no onboarding side-calls
    run) under a phone number that cannot be real (972550… + counter)."""
    import user_profile
    n = next(_COUNTER)
    phone = f"972550{int(time.time()) % 10_000_000:07d}{n:03d}"
    user_profile.update_profile(
        phone, name="Dana", language=language, homeAddress="דיזנגוף 100, תל אביב",
        transportType="bus", morningRoutineMinutes=30, hobbies="יוגה",
        defaultWakeTime="07:00", sleepTime="23:00", onboarded=True, routineVerified=True)
    return {"id": phone, "whatsapp_phone": phone, "name": "Dana", "language": language,
            "_tag": tag}


@dataclass
class Outcome:
    content: str
    user: dict
    result: Optional[dict] = None
    error: Optional[str] = None
    timed_out: bool = False
    trace: Trace = field(default_factory=Trace)

    @property
    def returned(self) -> bool:
        """The call came back with a dict (even an apologetic one)."""
        return self.result is not None

    @property
    def text(self) -> str:
        return str((self.result or {}).get("text") or "")

    @property
    def saved_tasks(self) -> list:
        return list((self.result or {}).get("tasks") or [])

    @property
    def is_error_reply(self) -> bool:
        """The turn answered with the agent's own failure apology (type=error)."""
        return (self.result or {}).get("type") == "error"

    def action_succeeded(self) -> bool:
        """Did an ACTION tool really do something this turn (the production
        guard's own question), or did any task get persisted?"""
        from evals import guards
        ran = any(e["name"] in guards.ACTION_TOOLS and e["ok"] for e in self.trace.tool_events)
        return ran or bool(self.saved_tasks)


async def run_request(model, content: str, user: Optional[dict] = None, scenario=None,
                      tool_faults: Optional[dict] = None, timeout_s: Optional[float] = None,
                      channel: str = "app", mode: Optional[str] = None) -> Outcome:
    """One turn. Never raises: a crash is an Outcome with `error` set."""
    import agent_turn
    user = user or new_user()
    trace = Trace(name=getattr(scenario, "name", "") or content[:30])
    trace.tool_faults = dict(tool_faults or {})
    out = Outcome(content=content, user=user, trace=trace)
    trace_token = trace_mod.CURRENT.set(trace)
    scen_token = trace_mod.SCENARIO.set(scenario)
    try:
        coro = agent_turn.run_turn(user["whatsapp_phone"], content, user, None,
                                   channel=channel, mode=mode)
        out.result = await (asyncio.wait_for(coro, timeout_s) if timeout_s else coro)
    except asyncio.TimeoutError:
        out.timed_out = True
        out.error = f"timed out after {timeout_s}s"
    except Exception as exc:  # noqa: BLE001 — a crash is a result
        out.error = f"{type(exc).__name__}: {str(exc)[:200]}"
    finally:
        trace.done()
        trace_mod.CURRENT.reset(trace_token)
        trace_mod.SCENARIO.reset(scen_token)
    return out


# ── the standard scenarios ──────────────────────────────────────────────────

def _tomorrow() -> str:
    from datetime import timedelta
    from tz import today_il
    return (today_il() + timedelta(days=1)).isoformat()


def standard_scenarios() -> dict:
    """Scripted turns of the shapes real people send. Dates are relative to the
    real clock, because the agent's own date guards read it."""
    from evals.fakes import Scenario
    tm = _tomorrow()
    from tz import today_il
    today = today_il().isoformat()

    def S(name, key, rounds, side=None):
        return Scenario(name=name, note=key, rounds=rounds, side_json=side)

    return {
        "save_gym": S("save_gym", "אימון בחדר כושר מחר ב-18:00", [
            {"calls": [("infer_task_details", {"task_text": "אימון בחדר כושר", "category": "gym",
                                                "fixed_time": "18:00", "date": tm})]},
            {"text": "✓ נשמר: אימון מחר ב-18:00"}]),
        "save_two": S("save_two", "יוגה ב-9 ואז פגישה עם דני ב-14:00", [
            {"calls": [("infer_task_details", {"task_text": "יוגה", "fixed_time": "09:00", "date": today}),
                       ("infer_task_details", {"task_text": "פגישה עם דני", "fixed_time": "14:00",
                                                "date": today})]},
            {"text": "✓ הוספתי 2 משימות להיום"}]),
        "save_located": S("save_located", "ראיון עבודה במר גרופ מחר ב-10:00", [
            {"calls": [("calculate_date", {"expression": "מחר"})]},
            {"calls": [("infer_task_details", {"task_text": "ראיון עבודה", "category": "interview",
                                                "fixed_time": "10:00", "date": tm,
                                                "location": "מר גרופ"})]},
            {"calls": [("plan_departure", {"destination": "מר גרופ", "arrival_time": "10:00",
                                            "task_date": tm})]},
            {"text": "✓ נשמר. לצאת ב-08:40 🚌"}]),
        "reminder": S("reminder", "תזכירי לי להתקשר לאמא", [
            {"calls": [("set_reminder", {"text": "להתקשר לאמא", "time": "23:59"})]},
            {"text": "✓ תוזכרי ב-23:59"}]),
        "ask_day": S("ask_day", "מה יש לי היום?", [
            {"calls": [("get_my_tasks", {"date_from": today, "date_to": today})]},
            {"text": "היום אין לך משימות 👍"}]),
        "ask_free": S("ask_free", "יש לי זמן לפגישה של שעה מחר?", [
            {"calls": [("check_availability", {"date": tm, "minutes": 60})]},
            {"text": "כן, מחר יש מקום 👍"}]),
        "search_web": S("search_web", "מה שעות הפתיחה של הדואר?", [
            {"calls": [("web_search", {"query": "שעות פתיחה דואר ישראל"})]},
            {"text": "בדרך כלל 08:00-18:00."}]),
        "find_place": S("find_place", "איפה בית המרקחת הכי קרוב?", [
            {"calls": [("find_place", {"query": "בית מרקחת"})]},
            {"text": "מצאתי: בית מרקחת #1 🙂"}]),
        "chat": S("chat", "תודה רבה!", [{"text": "בכיף 🙂"}]),
    }
