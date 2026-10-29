"""scalability — what happens at 10x, and which part gives way first.

Three measurements and one inspection, all offline, all under 60 seconds.

1. CONCURRENCY RAMP. The real FastAPI app (main.app) is driven IN-PROCESS over
   httpx.ASGITransport — the real routing, auth dependency, rate limiter,
   run_turn, tools, guards and JSON stores — with the fake model (300 ms/call)
   and simulated outside APIs. Concurrency 1, 5, 10, 50 virtual users, each
   sending a few requests in a row. Per step: throughput, p50/p95/p99, error
   rate, event-loop lag, CPU seconds per request.

2. BOTTLENECK BREAKDOWN. Every request carries a Trace, so its wall time splits
   into model / outside API / JSON-store I/O / "ours" (code and queueing). The
   model and outside APIs are WAITING, not working: they cost latency, not
   capacity. What limits throughput is the CPU the server burns per request
   and the event loop it burns it on.

3. STORAGE GROWTH. Every turn reads and rewrites WHOLE JSON files that hold
   EVERY user (conversations.json, user_memory.json…) — synchronously, on the
   event loop. This seeds the stores with 100 and 1 000 users' worth of data
   and times the same operations, to show how a per-request cost grows with
   the number of people.

4. SCALE-OUT INSPECTION. Whether more instances can be added is a question
   about the repo, not a load number: read from fly.toml and the modules.

Limits that would throttle, from rate_limit.py, are listed with the throughput
they imply. The Fly proxy's own concurrency limit (hard_limit in fly.toml) is
NOT simulated: above it the proxy queues or sheds, so the c=50 step is what the
app would do if the proxy let all 50 through.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
import time
from statistics import mean

from evals import harness
from evals import metrics as M
from evals.env import REPO_ROOT, SERVER_DIR, offline_session
from evals.fakes import ExternalSim, FakeModel
from evals.result import metric, ok
from evals.trace import CURRENT, Trace

ROW = "Scalability"
STEPS = (1, 5, 10, 50)
REQUESTS_PER_USER = 3
STORAGE_SIZES = (100, 1000)
MODEL_LATENCY_S = 0.3

#: Request mix of a real day, as shares of 20 requests.
MIX = ["save_gym", "ask_day", "save_two", "chat", "reminder", "ask_free", "save_located",
       "save_gym", "ask_day", "search_web", "save_two", "chat", "ask_free", "find_place",
       "save_gym", "ask_day", "reminder", "save_located", "chat", "ask_free"]


def _auth_patch(main_mod):
    from unittest import mock
    import app_auth

    async def fake_verify(authorization):
        token = (authorization or "").split(" ", 1)[-1].strip()
        if not token:
            raise app_auth.AuthError("missing bearer token")
        return {"userId": token, "email": f"{token}@eval.invalid"}

    async def fake_phone(user_id):
        return None

    return mock.patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


class _LoopLag:
    """Samples how late the event loop runs a 10 ms timer: a saturated loop is late."""

    def __init__(self):
        self.samples: list = []
        self._stop = False

    async def run(self):
        while not self._stop:
            t0 = time.perf_counter()
            await asyncio.sleep(0.01)
            self.samples.append(max(0.0, time.perf_counter() - t0 - 0.01))

    def stop(self):
        self._stop = True


async def _step(client, scenarios: dict, concurrency: int, offset: int) -> dict:
    import rate_limit
    import user_profile
    rate_limit.reset()
    users = [f"9725508{offset + i:06d}" for i in range(concurrency)]
    for uid in users:
        user_profile.update_profile(
            uid, name="Dana", language="he", homeAddress="דיזנגוף 100, תל אביב", transportType="bus",
            morningRoutineMinutes=30, hobbies="יוגה", defaultWakeTime="07:00", sleepTime="23:00",
            onboarded=True, routineVerified=True)
    names = list(scenarios)
    results: list = []
    lag = _LoopLag()
    lag_task = asyncio.create_task(lag.run())
    cpu0, t0 = time.process_time(), time.perf_counter()

    async def virtual_user(index: int, uid: str):
        for n in range(REQUESTS_PER_USER):
            name = MIX[(index * REQUESTS_PER_USER + n) % len(MIX)]
            scenario = scenarios[name]
            trace = Trace(name=name)
            token = CURRENT.set(trace)
            started = time.perf_counter()
            status, error, reply_type = 0, None, None
            try:
                response = await client.post("/agent/chat", json={"message": scenario.note},
                                             headers={"Authorization": f"Bearer {uid}"})
                status = response.status_code
                body = response.json() if status == 200 else {}
                reply_type = body.get("type")
            except Exception as exc:  # noqa: BLE001 — a crash is a result
                error = f"{type(exc).__name__}: {str(exc)[:100]}"
            finally:
                trace.done()
                CURRENT.reset(token)
            failed = bool(error) or status != 200 or reply_type == "error"
            results.append({"name": name, "wall_s": time.perf_counter() - started, "failed": failed,
                            "status": status, "error": error, "trace": trace})

    await asyncio.gather(*[virtual_user(i, uid) for i, uid in enumerate(users)])
    seconds, cpu = time.perf_counter() - t0, time.process_time() - cpu0
    lag.stop()
    await lag_task
    n = len(results)
    walls = [r["wall_s"] for r in results]
    parts = [r["trace"].breakdown() for r in results]
    total_wall = sum(p["wall"] for p in parts) or 1.0
    return {
        "concurrency": concurrency, "requests": n, "seconds": seconds,
        "throughput_rps": n / seconds, "latency": M.latency_summary(walls),
        "error_rate": M.rate(sum(r["failed"] for r in results), n),
        "errors": [{"input": r["name"], "expected": "200 + a reply",
                    "got": r["error"] or f"HTTP {r['status']}"} for r in results if r["failed"]][:5],
        "loop_lag_p95_ms": M.percentile(lag.samples, 95) * 1000 if lag.samples else 0.0,
        "cpu_ms_per_request": cpu / n * 1000,
        "cpu_utilisation": cpu / seconds,
        "share": {k: sum(p[k] for p in parts) / total_wall for k in ("model", "external", "storage", "ours")},
        "mean_ms": {k: mean(p[k] for p in parts) * 1000 for k in ("wall", "model", "external", "storage", "ours")},
    }


def _seed_stores(n_users: int) -> None:
    """Fill the big JSON stores as if `n_users` people had been using Meira."""
    import conversation
    import user_memory
    convo = conversation._load()
    mem = user_memory._load()
    text = "יש לי פגישה עם דני מחר ב-14:00 ואחר כך אימון בחדר כושר ב-18:00 — תזכירי לי "
    for i in range(n_users):
        phone = f"9725509{i:06d}"
        convo[phone] = [{"role": "user" if j % 2 == 0 else "assistant", "content": text,
                         "ts": "2026-10-15T09:00"} for j in range(30)]
        mem[phone] = {"tasks": [{"id": f"t{i}-{j}", "text": f"משימה {j}", "category": "general",
                                 "priority": "need_to", "duration_minutes": 30, "fixed_time": None,
                                 "date": "2026-10-16", "status": "pending"} for j in range(30)],
                      "behaviors": [], "preferences": [], "routines": [], "contacts": []}
    conversation._save(convo)
    user_memory._save(mem)


def _storage_growth() -> dict:
    """p95 ms of the per-turn store operations, with the stores at several sizes."""
    import conversation
    import user_memory
    rows = []
    for size in (0,) + STORAGE_SIZES:
        if size:
            _seed_stores(size)
        probe = "972550999" + f"{size:04d}"
        ops = []
        for k in range(12):
            t0 = time.perf_counter()
            conversation.append(probe, f"hello {k}", "hi")
            conversation.get_history(probe)
            user_memory.add_task(probe, {"text": f"probe {k}", "date": "2026-10-16", "fixed_time": "10:00"})
            ops.append(time.perf_counter() - t0)
        rows.append({
            "users_in_store": size, "turn_store_ms_p50": M.percentile(ops, 50) * 1000,
            "turn_store_ms_p95": M.percentile(ops, 95) * 1000,
            "conversations_kb": os.path.getsize(conversation._PATH) / 1024,
            "user_memory_kb": os.path.getsize(user_memory._PATH) / 1024})
    return {"rows": rows}


def _scale_out_inspection() -> dict:
    """Facts about whether a second machine could serve traffic, read from the repo."""
    facts: dict = {"blockers": [], "checks": []}
    toml_path = os.path.join(REPO_ROOT, "fly.toml")
    toml = open(toml_path, encoding="utf-8").read() if os.path.exists(toml_path) else ""
    code = re.sub(r"(?m)^\s*#.*$", "", toml)       # comments describe history, not config
    cpus = re.search(r"cpus\s*=\s*(\d+)", code)
    mem = re.search(r"memory_mb\s*=\s*(\d+)", code)
    hard = re.search(r"hard_limit\s*=\s*(\d+)", code)
    soft = re.search(r"soft_limit\s*=\s*(\d+)", code)
    facts["machine"] = {"cpus": int(cpus.group(1)) if cpus else None,
                        "memory_mb": int(mem.group(1)) if mem else None,
                        "proxy_hard_limit": int(hard.group(1)) if hard else None,
                        "proxy_soft_limit": int(soft.group(1)) if soft else None,
                        "min_machines_running": (re.search(r"min_machines_running\s*=\s*(\d+)", code) or [None, None])[1]}
    local_stores = []
    for name in sorted(os.listdir(SERVER_DIR)):
        if name.endswith(".py"):
            src = open(os.path.join(SERVER_DIR, name), encoding="utf-8", errors="ignore").read()
            if re.search(r"_PATH\s*=\s*os\.path\.join\(config\.DATA_DIR", src):
                local_stores.append(name)
    has_mount = "[[mounts]]" in code
    facts["local_json_stores"] = local_stores
    checks = [
        ("state_not_on_local_disk", not (has_mount and local_stores),
         f"{len(local_stores)} modules keep their store as a JSON file under DATA_DIR"
         + (" on the single Fly volume 'lumi_data' (a volume attaches to one machine)" if has_mount else "")),
    ]
    main_src = open(os.path.join(SERVER_DIR, "main.py"), encoding="utf-8").read()
    loops = re.findall(r"asyncio\.create_task\((\w+\.run_\w+)\(\)\)", main_src)
    checks.append(("background_loops_safe_to_duplicate", not loops,
                   f"lifespan starts {len(loops)} in-process loops ({', '.join(loops)}) — a second machine "
                   "would run each again (double reminders)"))
    rl_src = open(os.path.join(SERVER_DIR, "rate_limit.py"), encoding="utf-8").read()
    checks.append(("rate_limit_shared_across_machines",
                   bool(re.search(r"(?m)^\s*(?:import|from)\s+(?:redis|aioredis)", rl_src)),
                   "rate_limit.py counts in an in-process dict: N machines multiply every ceiling by N"))
    checks.append(("fits_one_proxy_limit_at_10x", False if not hard else int(hard.group(1)) >= 50,
                   f"Fly proxy hard_limit = {hard.group(1) if hard else 'unset'} concurrent requests "
                   f"(the ramp's top step is {max(STEPS)}); above it the proxy queues or sheds"))
    facts["checks"] = [{"name": n, "ok": bool(ok_), "why": why} for n, ok_, why in checks]
    facts["blockers"] = [c for c in facts["checks"] if not c["ok"]]
    return facts


def _limits_note(max_rps: float) -> list:
    """rate_limit.py's ceilings. 'global' ones cap a door's TOTAL throughput; the
    per-identity ones only ever stop a single caller."""
    import rate_limit as rl
    items = [("POST /agent/chat per account", rl.CHAT_LIMIT, rl.CHAT_WINDOW_S, "per-identity"),
             ("POST /webhook/whatsapp per phone", rl.WHATSAPP_LIMIT, rl.WHATSAPP_WINDOW_S, "per-identity"),
             ("POST /webhook/whatsapp, whole webhook", rl.WEBHOOK_GLOBAL_LIMIT, rl.WEBHOOK_GLOBAL_WINDOW_S, "global"),
             ("STT per account", rl.STT_LIMIT, rl.STT_WINDOW_S, "per-identity"),
             ("TTS per account", rl.TTS_LIMIT, rl.TTS_WINDOW_S, "per-identity")]
    return [{"limit": label, "per": f"{limit}/{int(window)}s", "rps": limit / window, "scope": scope,
             "caps_total_throughput_below_cpu_ceiling": scope == "global" and limit / window < max_rps}
            for label, limit, window, scope in items]


def _people_at_peak(cpu_s: float, store_s_per_user: float, per_user_peak_rps: float) -> int:
    """Largest U with  U * r * (cpu + s*U) <= 1.

    Both the load (U people) and the cost of each request (the stores hold U
    people's data and every turn rewrites them) grow with U. Solve
    s r U^2 + cpu r U - 1 = 0 for the positive root."""
    a, b = store_s_per_user * per_user_peak_rps, cpu_s * per_user_peak_rps
    if a <= 0:
        return int(1 / b) if b > 0 else 10 ** 9
    return int((-b + (b * b + 4 * a) ** 0.5) / (2 * a))


def run() -> dict:
    model = FakeModel(latency_s=MODEL_LATENCY_S, side_latency_s=0.15)
    sim = ExternalSim()
    main_mod = importlib.import_module("main")          # import cost is not part of the ramp
    import httpx
    started_all = time.perf_counter()
    with offline_session(model, sim), _auth_patch(main_mod):
        scenarios = harness.standard_scenarios()
        model.by_text = [(sc.note, sc) for sc in scenarios.values()]

        async def ramp():
            steps = []
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_mod.app),
                                         base_url="http://eval", timeout=120) as client:
                offset = 0
                for c in STEPS:
                    steps.append(await _step(client, scenarios, c, offset))
                    offset += c
            return steps

        steps = asyncio.run(ramp())
        storage = _storage_growth()
    scale_out = _scale_out_inspection()

    by_c = {s["concurrency"]: s for s in steps}
    top, low, mid = by_c[max(STEPS)], by_c[min(STEPS)], by_c[5]
    cpu_ms = mean(s["cpu_ms_per_request"] for s in steps if s["requests"] >= 5)
    ceiling_rps = 1000.0 / cpu_ms if cpu_ms else float("inf")
    p95_ratio = top["latency"]["p95_ms"] / mid["latency"]["p95_ms"]
    thr_ratio = top["throughput_rps"] / mid["throughput_rps"]
    rows = storage["rows"]
    growth = (rows[-1]["turn_store_ms_p95"] - rows[0]["turn_store_ms_p95"]) / (rows[-1]["users_in_store"] / 1000)

    # What 10x means in people: the per-person allowance is 15 requests a day
    # (fly.toml USER_AI_DAILY_REQUESTS); assume the busiest hour carries 10% of a day.
    daily_requests, peak_share = 15, 0.10
    peak_rps_per_user = daily_requests * peak_share / 3600
    store_s_per_user = max(0.0, (rows[-1]["turn_store_ms_p50"] - rows[0]["turn_store_ms_p50"])
                           / 1000 / rows[-1]["users_in_store"])
    users_by_cpu = _people_at_peak(cpu_ms / 1000, store_s_per_user, peak_rps_per_user)
    free_seats = 20
    bottleneck = (
        "our CPU / event loop" if top["cpu_utilisation"] >= 0.8 or top["loop_lag_p95_ms"] > 100
        else "none reached: the ramp is I/O-bound (model + outside APIs wait; they cost latency, not capacity)")

    how = (f"main.app over ASGITransport; fake model {int(MODEL_LATENCY_S * 1000)} ms/call; steps "
           f"{'/'.join(map(str, STEPS))} virtual users x {REQUESTS_PER_USER} requests; "
           f"total ramp {time.perf_counter() - started_all:.0f} s")
    metrics = [
        metric("scalability.error_rate_at_10x", f"Error rate at {max(STEPS)} concurrent", top["error_rate"],
               "ratio", how, top["errors"], {"steps": steps}),
        metric("scalability.p95_ratio_10x", f"p95 at {max(STEPS)} vs 5 concurrent (10x step)", p95_ratio, "x",
               "1.0 = perfectly I/O-bound (latency unchanged); 10 = fully CPU-bound (latency scales with load)",
               [], {"p95_ms": {c: by_c[c]["latency"]["p95_ms"] for c in STEPS}}),
        metric("scalability.throughput_ratio_10x", f"Throughput at {max(STEPS)} vs 5 concurrent",
               thr_ratio, "x", "ideal 10.0 for a 10x increase in concurrency", [],
               {"rps": {c: by_c[c]["throughput_rps"] for c in STEPS}}),
        metric("scalability.cpu_ms_per_request", "CPU time per request", cpu_ms, "ms",
               "process CPU seconds / requests, averaged over the steps (user + system)", [],
               {"per_step": {c: by_c[c]["cpu_ms_per_request"] for c in STEPS}}),
        metric("scalability.single_core_ceiling_rps", "One-core ceiling (empty stores)", ceiling_rps, "req/s",
               f"1 / CPU-per-request. fly.toml gives this app {scale_out['machine']['cpus']} shared vCPU, so "
               "this is the most one machine can serve while the stores are small", [], {}),
        metric("scalability.people_at_peak", "People one machine serves at peak", users_by_cpu, "count",
               f"solves  U * r * (cpu + s*U) = 1  with r = {daily_requests} requests/person/day, busiest hour = "
               f"{int(peak_share * 100)}% of a day, cpu = {cpu_ms:.0f} ms, s = {store_s_per_user * 1000:.3f} ms of "
               "store time per stored person (the stores serialise requests, so cost per request grows with U)",
               [], {"store_ms_per_user": store_s_per_user * 1000}),
        metric("scalability.loop_lag_p95_ms", f"Event-loop lag p95 at {max(STEPS)} concurrent",
               top["loop_lag_p95_ms"], "ms", "how late a 10 ms timer fires; the JSON stores are synchronous "
               "file I/O on this loop", [], {}),
        metric("scalability.storage_ms_per_1000_users", "Per-turn store cost per 1 000 users stored", growth,
               "ms", "conversation.append + get_history + user_memory.add_task, with the stores seeded at "
               + " / ".join(str(r["users_in_store"]) for r in rows) + " users",
               [], {"rows": rows}),
        metric("scalability.store_ceiling_rps", f"Turns/s the stores allow at {rows[-1]['users_in_store']} users",
               1000.0 / rows[-1]["turn_store_ms_p50"], "req/s",
               "1 / median per-turn store time at that size. The store calls are synchronous, so they "
               "serialise ALL requests on the event loop; a real turn does more store I/O than this probe, "
               "so this is an upper bound", [], {"rows": rows}),
        metric("scalability.scale_out_blockers", "Things that stop a 2nd instance", len(scale_out["blockers"]),
               "count", "read from fly.toml and the modules; each is listed with why",
               [{"input": b["name"], "expected": "OK", "got": "BLOCKER", "note": b["why"]}
                for b in scale_out["blockers"]], scale_out),
    ]
    details = {"steps": steps, "bottleneck": bottleneck, "storage": storage, "scale_out": scale_out,
               "rate_limits": _limits_note(ceiling_rps),
               "capacity_model": {"people_at_peak": users_by_cpu,
                                  "free_seats_today": free_seats,
                                  "assumptions": f"{daily_requests} requests/person/day, "
                                                 f"{int(peak_share * 100)}% of a day's traffic in the busiest hour"}}
    return ok("scalability", ROW, metrics, details)
