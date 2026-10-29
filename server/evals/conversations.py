"""conversations — golden multi-turn conversations through the REAL run_turn (29.10).

    python -m evals.conversations          # the report
    pytest tests/test_conversations.py     # the gate

Each case (datasets/conversations.jsonl) is a world (her tasks) and turns.
Every turn runs agent_turn.run_turn end to end against an in-memory world:
her tasks, profile, memory and session are real Python objects; the
understanding MODEL is a deterministic stand-in (title + day words → one add,
the only thing it is asked for in these cases); the AGENT is a spy that only
counts that it was reached — a turn the code should answer must not reach it.

Measured per turn and summed:
  temporal / intent accuracy   frame.read vs the case's `frame`
  scheduling accuracy          created tasks: count, dates, status
  conflict detection           a closed day booked = fail
  context retention            `blocks` days really closed after the turn
  unnecessary agent / tool use the agent reached when `agent: false`
  unnecessary clarification    a question back when the case says none is needed
  response correctness         `says` all present, `not_says` none present
  latency                      wall time of run_turn (no network: code cost only)
Cost: every case runs with 0 model calls except where the agent is reached —
counted as `agent_calls` (each is one paid turn live).
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import os
import time
import uuid
from datetime import datetime
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.path.join(_HERE, "datasets", "conversations.jsonl")
NOW = "2026-10-29T10:00"


def load(path: str = DATASET) -> list:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class World:
    def __init__(self, tasks: list):
        self.tasks = []
        for t in tasks:
            self.add(dict(t))
        self.profile: dict = {"language": "en", "name": "Koral"}
        self.insights: list = []
        self.history: list = []
        self.session: dict = {}
        self.agent_calls = 0
        self.created: list = []

    def add(self, t: dict) -> dict:
        t.setdefault("id", uuid.uuid4().hex[:8])
        t.setdefault("status", "pending")
        if "durationMinutes" in t and "duration_minutes" not in t:
            t["duration_minutes"] = t["durationMinutes"]
        self.tasks.append(t)
        return t


def _patches(w: World, now: datetime):
    import agent_turn
    import conversation
    import session
    import supabase_tasks
    import task_store
    import tz
    import understand
    import user_memory
    import user_profile
    import past_log
    import frame

    async def fetch(phone, a=None, b=None, include_location=False):
        return [copy.deepcopy(t) for t in w.tasks
                if (not a or str(t.get("date"))[:10] >= a) and (not b or str(t.get("date"))[:10] <= b)], "supabase"

    async def her_days(phone, days=14):
        today = now.date().isoformat()
        return [copy.deepcopy(t) for t in w.tasks if str(t.get("date") or today)[:10] >= today
                and t.get("status") in ("pending", "partial", None)]

    def mem_add(phone, task, trust_status=False):
        t = w.add(dict(task))
        w.created.append(t)
        return t

    def mem_update(phone, tid, patch):
        for t in w.tasks:
            if str(t["id"]) == str(tid):
                t.update(patch)
                return t
        return None

    async def patch_task(phone, tid, patch):
        return mem_update(phone, tid, patch) is not None

    def get_profile(key):
        return dict(w.profile)

    def update_profile(key, replace_routines=False, **fields):
        w.profile.update({k: v for k, v in fields.items() if v is not None})
        return dict(w.profile)

    async def fake_understand(message, history=None, day=None, now_hhmm=None, today=None, about=""):
        fr = frame.read(message, now.date())
        kinds = past_log.kinds_in(message)
        if fr.get("intent") in (frame.SCHEDULING_ACTION, None) and kinds and fr.get("days"):
            title = {"זומבה": "Zumba"}.get(kinds[0], kinds[0]) if not any("֐" <= c <= "׿" for c in message) else kinds[0]
            expr = next((w_ for w_ in ("next monday", "monday", "ביום שני הבא", "tuesday") if w_ in message.lower()), None)
            return {"understood": message, "kind": "do", "ask": None, "lookup": None,
                    "actions": [{"do": "add", "title": title, "date_expression": expr or fr["days"][0],
                                 "start": "18:00", "duration_minutes": 60}]}
        return {"understood": message, "kind": "question" if "?" in message else "chat",
                "actions": [], "ask": None, "lookup": None}

    async def agent(content, user, learned, here=None, tier=None):
        w.agent_calls += 1
        return {"type": "reply", "text": "(agent)", "tasks": [], "departures": []}

    def sget(name):
        return lambda phone, *a: w.session.get(name)

    def set_choice(phone, owner, count, options=None, context=None):
        w.session["choice"] = {"owner": owner, "count": count, "options": options, "context": context}

    clock = mock.MagicMock(return_value=now)
    return [
        mock.patch.object(task_store, "fetch_tasks_with_source", fetch),
        mock.patch.object(agent_turn, "_her_days", her_days),
        mock.patch.object(agent_turn, "_patch_task", patch_task),
        mock.patch.object(agent_turn, "handle_whatsapp_message", agent),
        mock.patch.object(understand, "understand", fake_understand),
        mock.patch.object(user_memory, "add_task", mem_add),
        mock.patch.object(user_memory, "update_task", mem_update),
        mock.patch.object(user_memory, "tasks_for_phone", lambda p: copy.deepcopy(w.tasks)),
        mock.patch.object(user_memory, "add_insight", lambda p, k, v: w.insights.append((k, v))),
        mock.patch.object(user_memory, "format_for_prompt", lambda p: ""),
        mock.patch.object(user_profile, "get_profile", get_profile),
        mock.patch.object(user_profile, "update_profile", update_profile),
        mock.patch.object(supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value=None)),
        mock.patch.object(supabase_tasks, "queue_pending", lambda *a, **k: None),
        mock.patch.object(conversation, "get_history", lambda k: list(w.history)),
        mock.patch.object(conversation, "append", lambda k, u, a: w.history.extend(
            [{"role": "user", "content": u}, {"role": "assistant", "content": a}])),
        mock.patch.object(session, "get_pending_choice", sget("choice")),
        mock.patch.object(session, "set_pending_choice", set_choice),
        mock.patch.object(session, "clear_pending_choice", lambda p: w.session.pop("choice", None)),
        mock.patch.object(session, "get_last_saved", lambda p: list(w.session.get("last_saved") or [])),
        mock.patch.object(session, "set_last_saved", lambda p, ids: w.session.update(last_saved=list(ids))),
        mock.patch.object(session, "get_state", lambda p: dict(w.session.get("state") or {})),
        mock.patch.object(session, "set_state", lambda p, st: w.session.update(state=dict(st))),
        mock.patch.object(session, "set_active_task", lambda *a, **k: None),
        mock.patch.object(tz, "now_il", clock),
        mock.patch.object(tz, "today_il", lambda: now.date()),
        mock.patch.object(agent_turn._quota, "blocked_reply", lambda *a, **k: None),
        mock.patch.object(agent_turn, "sync_app_profile", lambda *a, **k: None),
    ]


def run_case(case: dict) -> dict:
    import agent_turn
    import frame
    import tz
    now = datetime.fromisoformat(case.get("now") or NOW).replace(tzinfo=tz.IL)
    w = World(case.get("given", {}).get("tasks") or [])
    results = []
    with contextlib.ExitStack() as stack:
        for p in _patches(w, now):
            stack.enter_context(p)
        for i, turn in enumerate(case["turns"]):
            before_created, before_agent = len(w.created), w.agent_calls
            snapshot = {t["id"]: (t.get("date"), t.get("status")) for t in w.tasks}
            fr = frame.read(turn["user"], now.date(), after_meira=i > 0)
            t0 = time.perf_counter()
            out = asyncio.new_event_loop().run_until_complete(agent_turn.run_turn(
                "972500000000", turn["user"], {"id": "u1", "language": "en"}, channel="app"))
            ms = (time.perf_counter() - t0) * 1000
            text = str(out.get("text") or "")
            created = w.created[before_created:]
            r = {"case": case["id"], "turn": i, "user": turn["user"], "reply": text, "ms": ms, "checks": {}}
            c = r["checks"]
            exp = turn.get("frame") or {}
            if exp:
                c["temporal"] = all(fr.get(k) == v for k, v in exp.items() if k == "time")
                c["intent"] = all(fr.get(k) == v for k, v in exp.items() if k != "time")
            if "creates" in turn:
                c["scheduling"] = len(created) == turn["creates"] and \
                    (not turn.get("created_dates") or [t["date"] for t in created] == turn["created_dates"]) and \
                    (not turn.get("created_status") or all(t.get("status") == turn["created_status"] for t in created))
            if turn.get("moves"):
                c["scheduling"] = c.get("scheduling", True) and all(
                    any(t.get("text") == title and t.get("date") == d for t in w.tasks)
                    for title, d in turn["moves"].items())
            closed = {e.get("day") for e in (w.profile.get("availability") or [])}
            if turn.get("blocks"):
                c["context_retention"] = set(turn["blocks"]) <= closed
            if case.get("area") == "conflict":
                c["conflict"] = not any(str(t.get("date")) in closed or
                                        any("חופש" in str(x.get("text")) and x.get("date") == t.get("date")
                                            for x in w.tasks) for t in created)
            if turn.get("agent") is False:
                c["no_unneeded_agent"] = w.agent_calls == before_agent
            if "says" in turn or "not_says" in turn:
                low = text.lower()
                c["response"] = all(s.lower() in low for s in turn.get("says") or []) and \
                    not any(s.lower() in low for s in turn.get("not_says") or [])
            asks_back = text.rstrip().endswith("?")
            wanted_q = any(s.endswith("?") or s in ("1)", "another day", "יום אחר") for s in turn.get("says") or [])
            if not wanted_q and turn.get("creates", 0) and asks_back:
                c["no_unneeded_question"] = False
            elif turn.get("creates", 0):
                c["no_unneeded_question"] = True
            r["agent_calls"] = w.agent_calls - before_agent
            r["changed"] = {k: v for k, v in {t["id"]: (t.get("date"), t.get("status")) for t in w.tasks}.items()
                            if snapshot.get(k) != v}
            results.append(r)
    return {"case": case["id"], "turns": results}


def report(cases: list) -> dict:
    turns = [t for c in cases for t in c["turns"]]
    metrics: dict = {}
    for t in turns:
        for k, ok in t["checks"].items():
            m = metrics.setdefault(k, [0, 0])
            m[0] += int(bool(ok))
            m[1] += 1
    out = {k: {"pass": a, "of": b, "rate": round(a / b, 3)} for k, (a, b) in sorted(metrics.items())}
    out["_agent_calls"] = sum(t["agent_calls"] for t in turns)
    out["_turns"] = len(turns)
    out["_ms_p50"] = round(sorted(t["ms"] for t in turns)[len(turns) // 2], 1) if turns else 0
    out["_failures"] = [f"{t['case']}#{t['turn']} {t['user']!r} → {t['reply']!r} ✗{[k for k, v in t['checks'].items() if not v]}"
                        for t in turns if not all(t["checks"].values())]
    return out


def main() -> None:
    cases = [run_case(c) for c in load()]
    rep = report(cases)
    for k, v in rep.items():
        if k == "_failures":
            continue
        print(f"{k:24} {v}")
    for f in rep["_failures"]:
        print("FAIL", f)


if __name__ == "__main__":
    main()
