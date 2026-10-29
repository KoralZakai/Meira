"""trace — a per-request ledger of where the time and the calls went.

One Trace per simulated request, held in a ContextVar so everything the request
spawns (asyncio.gather over parallel tool calls included — child tasks copy the
context, and the Trace is a shared mutable object) writes into the same ledger.

It records, for ONE request:
  * every tool call: name, wall ms, whether it succeeded, whether it raised
  * every model call: nominal latency, tokens in/out, whether it was a fault
  * every external API call: service, endpoint, nominal latency, status
  * time spent blocked in the JSON stores (secure_store read/write)

`breakdown()` turns those into the bottleneck split the scalability report
prints: model / external API / storage / "our code and queueing" (what is left
of the wall time). The model and external figures are the NOMINAL simulated
latencies, so they mean "what the network would have cost"; the remainder is
what the machine added on top, and it is the number that grows when the event
loop saturates.
"""
from __future__ import annotations

import contextvars
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Trace:
    name: str = ""
    started: float = field(default_factory=time.perf_counter)
    finished: Optional[float] = None
    tool_events: list = field(default_factory=list)       # {name, ms, ok, raised}
    tool_faults: dict = field(default_factory=dict)       # tool name -> {"mode","times","hang_s"}
    fault_counts: dict = field(default_factory=dict)      # per-request fault counters
    model_events: list = field(default_factory=list)      # {latency_s, tokens_in, tokens_out, fault}
    ext_events: list = field(default_factory=list)        # {service, endpoint, latency_s, status}
    storage_s: float = 0.0
    storage_calls: int = 0

    def done(self) -> "Trace":
        self.finished = time.perf_counter()
        return self

    @property
    def wall_s(self) -> float:
        return (self.finished or time.perf_counter()) - self.started

    @property
    def model_s(self) -> float:
        return sum(e["latency_s"] for e in self.model_events)

    @property
    def external_s(self) -> float:
        return sum(e["latency_s"] for e in self.ext_events)

    @property
    def tokens_in(self) -> int:
        return sum(e["tokens_in"] for e in self.model_events if not e.get("fault"))

    @property
    def tokens_out(self) -> int:
        return sum(e["tokens_out"] for e in self.model_events if not e.get("fault"))

    def breakdown(self) -> dict:
        """Seconds per bucket; `ours` is what the other three do not explain."""
        wall = self.wall_s
        model, ext, store = self.model_s, self.external_s, self.storage_s
        # Parallel tool calls overlap, so the nominal sum can exceed the wall
        # time; the remainder is clamped rather than reported negative.
        ours = max(0.0, wall - model - ext - store)
        return {"wall": wall, "model": model, "external": ext, "storage": store, "ours": ours}


CURRENT: contextvars.ContextVar[Optional[Trace]] = contextvars.ContextVar(
    "eval_trace", default=None)

#: The tool currently executing in this task (set by the instrumented Tool.ainvoke),
#: so an outside call can say which tool caused it.
CURRENT_TOOL: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "eval_tool", default=None)

#: Scenario override for the fake model, set by the harness for a single turn.
SCENARIO: contextvars.ContextVar = contextvars.ContextVar("eval_scenario", default=None)


class StorageStats:
    """Process-wide storage totals, for work done outside any request (seeding)."""
    seconds = 0.0
    calls = 0

    @classmethod
    def reset(cls) -> None:
        cls.seconds, cls.calls = 0.0, 0
