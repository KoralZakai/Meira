"""env — the sandbox every offline suite runs inside.

`offline_session()` is a context manager that, for its duration:

  * replaces ai_gate.client() with a FakeClient (the model seam) and empties
    every module-level client cache that was built from the real one;
  * answers EVERY outbound httpx request from ExternalSim and blocks the rest
    (httpx.AsyncHTTPTransport.handle_async_request is replaced; the in-process
    ASGITransport the load test uses is a different class and is unaffected);
  * wraps Tool.ainvoke, secure_store.read_json/write_json and llm_usage's file
    I/O so each request's Trace records tool time, storage time and faults;
  * lifts the per-person AI allowance (env vars) — the fake model spends no
    money, and a 50-request ramp from one test user would otherwise be
    refused by user_quota exactly as a real over-eager user would be;
  * points the agent's retry backoff at 10 ms instead of ~5 s.

Everything is restored on exit, so test_evals.py can run suites inside the
normal pytest process without leaking into the other 1100 tests.

`bootstrap_data_dir()` is for the CLI only: the server's JSON stores resolve
their paths from DATA_DIR at IMPORT time, so it must run before the first
server import. Under pytest, tests/conftest.py already did that.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Optional
from unittest import mock

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(SERVER_DIR)


def bootstrap_data_dir() -> str:
    """Give this process its own DATA_DIR before any server module is imported."""
    if SERVER_DIR not in sys.path:
        sys.path.insert(0, SERVER_DIR)
    # On Fly DATA_DIR is /data — her REAL stores. An eval never runs there: run
    # live on the server (20.10) and it would have written test accounts into
    # production; it stopped only because the stores are encrypted.
    if not os.environ.get("DATA_DIR") or os.path.abspath(os.environ["DATA_DIR"]) == "/data":
        os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="meira-evals-")
    return os.environ["DATA_DIR"]


def blank_secrets_env(keep: tuple = ()) -> None:
    """No real credential may be loaded from .env into config, except those in
    `keep` (live mode keeps only the model key). An EMPTY value already in the
    environment stops load_dotenv() from filling it."""
    for name in tuple(n for n in ("NEBIUS_API_KEY", "EXPO_PUBLIC_NEBIUS_API_KEY", "SUPABASE_URL",
                 "SUPABASE_SERVICE_ROLE_KEY", "TAVILY_API_KEY", "GOOGLE_MAPS_API_KEY",
                 "EXPO_PUBLIC_GOOGLE_MAPS_API_KEY", "GOOGLE_SEARCH_API_KEY", "GOOGLE_CSE_ID",
                 "EMBED_MODEL", "WHATSAPP_API_TOKEN", "GROQ_API_KEY", "LUMI_DATA_KEY",
                 "DATABASE_URL", "ADMIN_TOKEN", "WHATSAPP_APP_SECRET") if n not in keep):
        os.environ[name] = ""


@dataclass
class Session:
    model: object
    sim: object
    module_names: tuple = ()


def _timed_storage(original, trace_mod):
    """Wrap a SYNC storage function so its wall time lands in the Trace."""
    def wrapper(*args, **kwargs):
        t0 = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            dt = time.perf_counter() - t0
            trace = trace_mod.CURRENT.get()
            if trace is not None:
                trace.storage_s += dt
                trace.storage_calls += 1
            trace_mod.StorageStats.seconds += dt
            trace_mod.StorageStats.calls += 1
    wrapper.__wrapped__ = original
    return wrapper


@contextlib.contextmanager
def offline_session(model=None, sim=None, supabase: bool = False, backoff_s: float = 0.01):
    """See the module docstring. Yields a Session(model, sim)."""
    if SERVER_DIR not in sys.path:
        sys.path.insert(0, SERVER_DIR)
    from evals import fakes, guards, trace as trace_mod
    import ai_gate
    import config
    import llm_usage
    import lumi_agent
    import react_loop
    import secure_store
    import task_extract
    import judge_service

    model = model or fakes.FakeModel()
    sim = sim or fakes.ExternalSim()

    # ---- instrumented tool execution --------------------------------------
    original_ainvoke = react_loop.Tool.ainvoke

    async def ainvoke(self, args):
        trace = trace_mod.CURRENT.get()
        t0 = time.perf_counter()
        raised = False
        ok = True
        tool_token = trace_mod.CURRENT_TOOL.set(self.name)
        try:
            fault = (trace.tool_faults.get(self.name) if trace is not None else None)
            if fault:
                key = ("tool", self.name)
                if trace.fault_counts.get(key, 0) < int(fault.get("times", 1)):
                    trace.fault_counts[key] = trace.fault_counts.get(key, 0) + 1
                    mode = fault.get("mode", "raise")
                    if mode == "raise":
                        raise RuntimeError(f"injected failure in {self.name}")
                    if mode == "hang":
                        await asyncio.sleep(float(fault.get("hang_s", 30)))
                    if mode == "slow":
                        await asyncio.sleep(float(fault.get("delay_s", 1)))
            result = await original_ainvoke(self, args)
            ok = guards.tool_succeeded(result)
            return result
        except BaseException:
            raised, ok = True, False
            raise
        finally:
            trace_mod.CURRENT_TOOL.reset(tool_token)
            if trace is not None:
                ext_s = sum(ev["latency_s"] for ev in trace.ext_events if ev.get("tool") == self.name)
                trace.tool_events.append({
                    "name": self.name, "ms": (time.perf_counter() - t0) * 1000,
                    "ok": ok, "raised": raised, "ext_s": ext_s})

    # ---- the network -------------------------------------------------------
    async def handle_async_request(self, request):
        return await sim.handle(request)

    # ---- agent retry backoff ----------------------------------------------
    real_create = lumi_agent.create_react_agent

    def fast_create(*a, **kw):
        agent = real_create(*a, **kw)
        agent.backoff_s = backoff_s
        return agent

    overrides = {
        "LLM_API_KEY": "offline-eval-not-a-key",
        "SUPABASE_URL": "https://offline-eval.supabase.invalid" if supabase else "",
        "SUPABASE_SERVICE_ROLE_KEY": "offline-eval" if supabase else "",
        "EMBED_MODEL": "",
        "TAVILY_API_KEY": "offline-eval",
        "GOOGLE_MAPS_API_KEY": "offline-eval",
    }
    # Unlimited allowances: the fake model spends nothing (user_quota / ai_gate).
    env = {"USER_AI_DAILY_REQUESTS": "0", "USER_LLM_DAILY_USD": "0",
           "USER_LLM_MONTHLY_USD": "0", "TOKEN_FACTORY_BALANCE_USD": "",
           "TOKEN_FACTORY_BALANCE_DATE": ""}

    saved_clients = (dict(lumi_agent._llm_by_model), dict(lumi_agent._retry_llm_by_model),
                     lumi_agent._raw_client, task_extract._client, judge_service._client)
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.multiple(config, **overrides))
        stack.enter_context(mock.patch.dict(os.environ, env))
        stack.enter_context(mock.patch.object(
            ai_gate, "client", lambda *a, **k: fakes.FakeClient(model)))
        stack.enter_context(mock.patch.object(react_loop.Tool, "ainvoke", ainvoke))
        stack.enter_context(mock.patch(
            "httpx.AsyncHTTPTransport.handle_async_request", handle_async_request))
        stack.enter_context(mock.patch.object(lumi_agent, "create_react_agent", fast_create))
        stack.enter_context(mock.patch.object(
            secure_store, "read_json", _timed_storage(secure_store.read_json, trace_mod)))
        stack.enter_context(mock.patch.object(
            secure_store, "write_json", _timed_storage(secure_store.write_json, trace_mod)))
        stack.enter_context(mock.patch.object(
            llm_usage, "_load", _timed_storage(llm_usage._load, trace_mod)))
        stack.enter_context(mock.patch.object(
            llm_usage, "_save", _timed_storage(llm_usage._save, trace_mod)))
        lumi_agent._llm_by_model.clear()
        lumi_agent._retry_llm_by_model.clear()
        lumi_agent._raw_client = None
        task_extract._client = None
        judge_service._client = None
        try:
            yield Session(model, sim)
        finally:
            lumi_agent._llm_by_model.clear()
            lumi_agent._retry_llm_by_model.clear()
            lumi_agent._llm_by_model.update(saved_clients[0])
            lumi_agent._retry_llm_by_model.update(saved_clients[1])
            lumi_agent._raw_client = saved_clients[2]
            task_extract._client = saved_clients[3]
            judge_service._client = saved_clients[4]
