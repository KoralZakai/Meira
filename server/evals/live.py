"""live — the harness for runs that spend real money (--live, weekly, never CI).

Three guarantees, because this is the one place the evals touch a paid API:

1. A HARD DOLLAR CAP. Every model call goes through `TimedClient`, which counts
   the provider's own usage numbers against `llm_usage.PRICES` (an unknown model
   is priced at the dearest known one, exactly as ai_gate does — err towards
   stopping) and REFUSES the next call once the cap is reached. A turn cannot
   overshoot by more than the one call that was already in flight.
2. NOTHING TOUCHES PRODUCTION. The CLI blanks every credential except the model
   key before the server is imported (env.blank_secrets_env) and `preflight`
   refuses to start if Supabase or WhatsApp credentials are somehow present.
   State lives in a temp DATA_DIR. Google and Tavily are unset, so route and
   search tools degrade honestly — which is itself something the questions test.
3. THE KEY IS NEVER PRINTED OR WRITTEN. It is read from the environment by the
   server's own config; the report records only that it was present.

The traces collected here are reused by performance (tokens/sec) and cost
(real tokens per request), so one small live run feeds three rows of the matrix.
"""
from __future__ import annotations

import contextlib
import os
import time
from dataclasses import dataclass, field
from typing import Optional
from unittest import mock

from evals import trace as trace_mod

#: Default hard cap for one live run, USD.
DEFAULT_BUDGET_USD = 0.20


class BudgetExceeded(RuntimeError):
    """The live run reached its dollar cap; no further model call is made."""


def price_usd(model: Optional[str], tokens_in: int, tokens_out: int) -> float:
    """Estimated USD for one call. Unknown model -> the dearest known price."""
    import llm_usage
    price = llm_usage.price_of(model) or max(llm_usage.PRICES.values(), key=lambda p: p[0] + p[1])
    return (tokens_in * price[0] + tokens_out * price[1]) / 1_000_000


@dataclass
class Budget:
    limit_usd: float = DEFAULT_BUDGET_USD
    spent_usd: float = 0.0
    calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    by_model: dict = field(default_factory=dict)

    def add(self, model: Optional[str], tin: int, tout: int) -> None:
        self.spent_usd += price_usd(model, tin, tout)
        self.calls += 1
        self.tokens_in += tin
        self.tokens_out += tout
        row = self.by_model.setdefault(str(model), {"in": 0, "out": 0, "calls": 0})
        row["in"] += tin
        row["out"] += tout
        row["calls"] += 1

    @property
    def exhausted(self) -> bool:
        return self.spent_usd >= self.limit_usd


class _Completions:
    def __init__(self, real, budget: Budget):
        self._real, self._budget = real, budget

    async def create(self, **kw):
        if self._budget.exhausted:
            raise BudgetExceeded(
                f"live eval budget ${self._budget.limit_usd:.2f} reached "
                f"(spent ${self._budget.spent_usd:.4f}) — call not made")
        t0 = time.perf_counter()
        response = await self._real.chat.completions.create(**kw)
        latency = time.perf_counter() - t0
        usage = getattr(response, "usage", None)
        tin = int(getattr(usage, "prompt_tokens", 0) or 0)
        tout = int(getattr(usage, "completion_tokens", 0) or 0)
        model = getattr(response, "model", None) or kw.get("model")
        self._budget.add(model, tin, tout)
        trace = trace_mod.CURRENT.get()
        if trace is not None:
            trace.model_events.append({"latency_s": latency, "tokens_in": tin, "tokens_out": tout,
                                       "fault": None, "model": model})
        return response


class TimedClient:
    """Wraps the REAL ai_gate client: same call, plus timing and the dollar cap."""

    def __init__(self, real, budget: Budget):
        self.chat = type("Chat", (), {})()
        self.chat.completions = _Completions(real, budget)
        self._real = real

    def __getattr__(self, name):
        return getattr(self._real, name)


@dataclass
class LiveRun:
    """Everything one live run learned; read by performance.run_live / cost.run_live."""
    budget: Budget = field(default_factory=Budget)
    outcomes: list = field(default_factory=list)       # harness.Outcome, one per question
    started: float = field(default_factory=time.time)
    reason_not_run: str = ""


#: Filled by live_accuracy.run(); None until a live run has happened this process.
LAST: Optional[LiveRun] = None


def preflight() -> str:
    """'' when a live run may start, else the reason it may not (shown in the report)."""
    import config
    if not (config.LLM_API_KEY or os.environ.get("NEBIUS_API_KEY")):
        return "NEBIUS_API_KEY is not set in the environment — no model to evaluate"
    leaked = [name for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WHATSAPP_API_TOKEN")
              if getattr(config, name, "")]
    if leaked:
        return (f"refusing to run live: {', '.join(leaked)} is set — the live evals must never "
                "be able to touch production data (run via `python -m evals --live`, which "
                "blanks them before import)")
    return ""


@contextlib.contextmanager
def live_session(budget: Budget):
    """Real model, capped; everything else offline-safe. Mirrors env.offline_session
    for the parts that must not reach the network (Google, Tavily, Supabase are unset)."""
    import ai_gate
    import config
    import judge_service
    import lumi_agent
    import react_loop
    import task_extract
    from evals import guards
    real_client = ai_gate.client

    def client(*a, **k):
        return TimedClient(real_client(*a, **k), budget)

    original_ainvoke = react_loop.Tool.ainvoke

    async def ainvoke(self, args):
        trace = trace_mod.CURRENT.get()
        t0 = time.perf_counter()
        ok, raised = True, False
        try:
            result = await original_ainvoke(self, args)
            ok = guards.tool_succeeded(result)
            return result
        except BaseException:
            ok, raised = False, True
            raise
        finally:
            if trace is not None:
                trace.tool_events.append({"name": self.name, "ms": (time.perf_counter() - t0) * 1000,
                                          "ok": ok, "raised": raised})

    env = {"USER_AI_DAILY_REQUESTS": "0", "USER_LLM_DAILY_USD": "0", "USER_LLM_MONTHLY_USD": "0",
           "TOKEN_FACTORY_BALANCE_USD": "", "TOKEN_FACTORY_BALANCE_DATE": ""}
    saved = (dict(lumi_agent._llm_by_model), dict(lumi_agent._retry_llm_by_model),
             lumi_agent._raw_client, task_extract._client, judge_service._client)
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ, env))
        stack.enter_context(mock.patch.object(ai_gate, "client", client))
        stack.enter_context(mock.patch.object(react_loop.Tool, "ainvoke", ainvoke))
        stack.enter_context(mock.patch.multiple(
            config, SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY="", EMBED_MODEL=""))
        lumi_agent._llm_by_model.clear()
        lumi_agent._retry_llm_by_model.clear()
        lumi_agent._raw_client = None
        task_extract._client = None
        judge_service._client = None
        try:
            yield
        finally:
            lumi_agent._llm_by_model.clear()
            lumi_agent._retry_llm_by_model.clear()
            lumi_agent._llm_by_model.update(saved[0])
            lumi_agent._retry_llm_by_model.update(saved[1])
            lumi_agent._raw_client, task_extract._client, judge_service._client = saved[2:]
