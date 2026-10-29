"""fakes — a scripted model and a simulated outside world.

THE MODEL SEAM. Every Nebius client in this codebase is built by
ai_gate.client() (tests/test_ai_gate.py fails on any other construction), so
replacing that ONE function replaces the model for the agent loop
(react_loop.ChatOpenAI), the understanding step, task_extract, profile
extraction and the judge. `FakeClient` answers the same
`chat.completions.create(...)` call and returns OpenAI-shaped objects.

SCRIPTED, NOT SMART. A Scenario lists what the "model" does on each round of a
turn: call these tools, then say this. The point of the offline evals is not to
test the model (it is not there) but everything AROUND it — the tools, the
guards, the persistence, the retries, the latency we add — against known model
behaviour, including the model behaving badly.

    Scenario("save-gym", rounds=[
        {"calls": [("infer_task_details", {"task_text": "gym", "date": "2026-10-16"})]},
        {"text": "✓ נשמר, מחר ב-18:00"},
    ])

A round may carry a `fault` ({"kind": "timeout"|"overloaded"|"auth", "times": n})
that is raised n times BEFORE the round answers (n >= 4 outlasts the loop's
retries), and a call's arguments may be a raw string to simulate malformed JSON.

TOKENS are estimated from the real request (chars / 4, tool schemas included),
so the 18 KB system prompt costs what it costs. Marked "estimated" wherever
reported; a live run uses the provider's own usage counts instead.

THE OUTSIDE WORLD. `ExternalSim` answers every outbound httpx request the
server makes (Google geocode / directions / places, Tavily, Supabase) with a
canned, plausible payload after a simulated latency, counts it per service,
and can be told to fail: Google REQUEST_DENIED, an HTTP 403, ZERO_RESULTS, a
timeout, a 500. A request to any other host is BLOCKED and recorded — the
offline evals cannot reach the network by accident.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Optional

import httpx

from evals.trace import CURRENT, CURRENT_TOOL, SCENARIO


# ── scenarios ───────────────────────────────────────────────────────────────

@dataclass
class Scenario:
    name: str
    rounds: list                       # [{"calls": [(tool, args)], "text": str, "fault": {...}}]
    side_json: Optional[dict] = None   # what the understanding step answers
    note: str = ""


DEFAULT_SIDE = {"understood": "", "kind": "chat", "actions": [], "ask": None}

#: Model faults that return bad TEXT instead of raising (the call itself succeeds).
SOFT_FAULTS = {"empty": "", "garbage": "אאאאאאאאאאאאאאאאאאאאאאאאאאאא"}


def est_tokens(obj: Any) -> int:
    """chars / 4 — the usual rule of thumb, applied to what was actually sent."""
    if obj is None:
        return 0
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str)
    return max(1, len(text) // 4)


def _fault_exception(kind: str) -> Exception:
    if kind == "timeout":
        from openai import APITimeoutError
        return APITimeoutError(request=SimpleNamespace(method="POST", url="https://offline.invalid"))
    if kind == "overloaded":
        return RuntimeError("Error code: 503 - the model is overloaded")
    if kind == "auth":
        return RuntimeError("Error code: 401 - could not authenticate: invalid api key")
    return RuntimeError(f"simulated model failure: {kind}")


class _Completions:
    def __init__(self, model: "FakeModel"):
        self._m = model

    async def create(self, **kw):
        return await self._m.respond(**kw)


class FakeClient:
    """Quacks like AsyncOpenAI for the one call the server makes."""

    def __init__(self, model: "FakeModel"):
        self.chat = SimpleNamespace(completions=_Completions(model))
        self.model = model


class FakeModel:
    def __init__(self, scenarios: Optional[list] = None, latency_s: float = 0.3,
                 side_latency_s: float = 0.15, default_text: str = "בסדר 👍",
                 side_fail: bool = False, model_name: str = "nvidia/nemotron-3-super-120b-a12b",
                 side_json: Optional[dict] = None):
        self.by_text = [(s.note or s.name, s) for s in (scenarios or [])]
        self.side_json = side_json      # the answer to JSON-mode calls when no scenario says otherwise
        self.latency_s = latency_s
        self.side_latency_s = side_latency_s
        self.default_text = default_text
        self.side_fail = side_fail
        self.model_name = model_name
        self.calls = 0
        self.faults_raised = 0
        self._fallback_counts: dict = {}   # fault counters when no Trace is active

    # -- scenario lookup -----------------------------------------------------
    def register(self, key: str, scenario: Scenario) -> None:
        """Route any turn whose last user message CONTAINS `key` to `scenario`."""
        self.by_text.append((key, scenario))

    def _scenario(self, messages: list) -> Optional[Scenario]:
        forced = SCENARIO.get()
        if forced is not None:
            return forced
        last = next((m for m in reversed(messages) if m.get("role") == "user"), None)
        text = str((last or {}).get("content") or "")
        for key, scenario in self.by_text:
            if key and key in text:
                return scenario
        return None

    @staticmethod
    def _round_index(messages: list) -> int:
        """How many assistant messages have followed the last user message."""
        idx = 0
        for m in reversed(messages):
            if m.get("role") == "user":
                break
            if m.get("role") == "assistant":
                idx += 1
        return idx

    # -- the call ------------------------------------------------------------
    async def respond(self, **kw):
        self.calls += 1
        messages = kw.get("messages") or []
        tools = kw.get("tools")
        trace = CURRENT.get()
        model = kw.get("model") or self.model_name
        tin = est_tokens(messages) + est_tokens(tools)

        # Side calls: understanding / task_extract (JSON mode), profile extraction
        # (forced tool_choice). Not the agent loop.
        is_agent_call = bool(tools) and kw.get("tool_choice") == "auto"
        if not is_agent_call:
            await asyncio.sleep(self.side_latency_s)
            if self.side_fail:
                self._note(trace, self.side_latency_s, tin, 0, fault="side", model=model)
                raise _fault_exception("overloaded")
            scenario = self._scenario(messages)
            if isinstance(kw.get("tool_choice"), dict):          # profile extraction
                content, tool_calls = "", None
            else:
                payload = (scenario.side_json if scenario and scenario.side_json is not None
                           else (self.side_json or DEFAULT_SIDE))
                content, tool_calls = json.dumps(payload, ensure_ascii=False), None
            tout = est_tokens(content)
            self._note(trace, self.side_latency_s, tin, tout, model=model)
            return self._response(model, content, tool_calls, tin, tout)

        scenario = self._scenario(messages)
        index = self._round_index(messages)
        rnd = {}
        if scenario and index < len(scenario.rounds):
            rnd = scenario.rounds[index]
        elif scenario and scenario.rounds:
            rnd = {"text": self.default_text}
        else:
            rnd = {"text": self.default_text}

        fault = rnd.get("fault")
        await asyncio.sleep(self.latency_s)
        if fault:
            key = (scenario.name if scenario else "-", index)
            counts = trace.fault_counts if trace is not None else self._fallback_counts
            if counts.get(key, 0) < int(fault.get("times", 1)):
                counts[key] = counts.get(key, 0) + 1
                self.faults_raised += 1
                if fault["kind"] in SOFT_FAULTS:
                    # The call "succeeds" but the output is bad: empty, or the
                    # repetition loop the degenerate-output guard exists for.
                    text = SOFT_FAULTS[fault["kind"]]
                    self._note(trace, self.latency_s, tin, est_tokens(text), fault=fault["kind"], model=model)
                    return self._response(model, text, None, tin, est_tokens(text))
                self._note(trace, self.latency_s, tin, 0, fault=fault["kind"], model=model)
                raise _fault_exception(fault["kind"])

        calls = rnd.get("calls") or []
        text = rnd.get("text", "") if "text" in rnd else ("" if calls else self.default_text)
        tool_calls = []
        for n, (name, args) in enumerate(calls):
            raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
            tool_calls.append(SimpleNamespace(
                id=f"call_{index}_{n}", type="function",
                function=SimpleNamespace(name=name, arguments=raw)))
        tout = est_tokens(text) + sum(est_tokens(tc.function.arguments) for tc in tool_calls)
        tout = max(tout, 8)
        self._note(trace, self.latency_s, tin, tout, model=model)
        return self._response(model, text, tool_calls or None, tin, tout)

    def _note(self, trace, latency_s: float, tin: int, tout: int, fault: Optional[str] = None,
              model: Optional[str] = None) -> None:
        if trace is not None:
            trace.model_events.append({"latency_s": latency_s, "tokens_in": tin,
                                       "tokens_out": tout, "fault": fault,
                                       "model": model or self.model_name})

    @staticmethod
    def _response(model: str, content: str, tool_calls, tin: int, tout: int):
        message = SimpleNamespace(content=content, tool_calls=tool_calls)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)],
                               usage=SimpleNamespace(prompt_tokens=tin, completion_tokens=tout),
                               model=model)


# ── the outside world ───────────────────────────────────────────────────────

#: Nominal one-way latencies of each outside service, seconds. Assumptions, not
#: measurements — chosen at the low-to-middle of what these APIs usually take so
#: the "our overhead" figures are not flattered by a slow world. Scaled by
#: ExternalSim(latency_scale=…).
EXTERNAL_LATENCY_S = {
    "google_geocode": 0.06, "google_directions": 0.12, "google_places": 0.10,
    "tavily": 0.30, "supabase": 0.03, "other": 0.05,
}


def classify(url: httpx.URL) -> tuple:
    """(service, endpoint) for an outbound request."""
    host, path = url.host or "", url.path or ""
    if "maps.googleapis.com" in host:
        if "/geocode/" in path:
            return "google_geocode", "geocode"
        if "/directions/" in path:
            return "google_directions", "directions"
        if "/place/" in path or "/places" in path:
            return "google_places", "places"
        return "google_places", path
    if "tavily" in host:
        return "tavily", path.strip("/") or "search"
    if "supabase" in host:
        return "supabase", path.strip("/")[:40]
    return "other", f"{host}{path}"[:60]


def _h(text: str) -> int:
    return int(hashlib.md5(text.encode("utf-8")).hexdigest()[:8], 16)


class ExternalSim:
    """Answers (and counts) every outbound request. Install with `install()`."""

    def __init__(self, latency_scale: float = 1.0, faults: Optional[dict] = None):
        self.latency_scale = latency_scale
        self.faults: dict = dict(faults or {})      # service -> mode
        self.calls: list = []                       # {service, endpoint, latency_s, status}
        self.blocked: list = []                     # requests to hosts we do not simulate

    # -- counting ------------------------------------------------------------
    def count(self, service: Optional[str] = None) -> int:
        return sum(1 for c in self.calls if service in (None, c["service"]))

    def by_service(self) -> dict:
        out: dict = {}
        for c in self.calls:
            out[c["service"]] = out.get(c["service"], 0) + 1
        return out

    # -- payloads ------------------------------------------------------------
    @staticmethod
    def _geocode(request: httpx.Request) -> dict:
        address = request.url.params.get("address") or request.url.params.get("latlng") or "x"
        h = _h(address)
        lat, lng = 32.05 + (h % 1000) / 20000, 34.76 + ((h >> 10) % 1000) / 20000
        return {"status": "OK", "results": [{
            "formatted_address": f"{address}, Israel", "place_id": f"sim-{h % 99999}",
            "geometry": {"location": {"lat": lat, "lng": lng}, "location_type": "ROOFTOP"}}]}

    @staticmethod
    def _places(request: httpx.Request) -> dict:
        query = request.url.params.get("query") or "place"
        h = _h(query)
        results = []
        for i in range(3):
            results.append({
                "name": f"{query} #{i + 1}", "formatted_address": f"רחוב {i + 1 + h % 40}, תל אביב",
                "place_id": f"sim-{h % 9999}-{i}", "rating": 4.2,
                "opening_hours": {"open_now": True},
                "geometry": {"location": {"lat": 32.06 + i / 500, "lng": 34.77 + i / 500}}})
        return {"status": "OK", "results": results}

    @staticmethod
    def _directions(request: httpx.Request) -> dict:
        mode = request.url.params.get("mode") or "driving"
        loc = {"lat": 32.07, "lng": 34.79}
        if mode == "transit":
            steps = [
                {"travel_mode": "WALK", "duration": {"value": 300}, "html_instructions": "Walk to Arlozerov"},
                {"travel_mode": "TRANSIT", "duration": {"value": 1200}, "start_location": loc,
                 "end_location": loc, "transit_details": {
                     "line": {"short_name": "251", "vehicle": {"type": "BUS"}},
                     "departure_stop": {"name": "ארלוזורוב"}, "arrival_stop": {"name": "עזריאלי"},
                     "departure_time": {"text": "08:20"}, "arrival_time": {"text": "08:40"},
                     "num_stops": 8}},
                {"travel_mode": "WALK", "duration": {"value": 240}, "html_instructions": "Walk to destination"},
            ]
            leg = {"duration": {"value": 1740}, "steps": steps,
                   "departure_time": {"text": "08:15"}, "arrival_time": {"text": "08:44"}}
        else:
            leg = {"duration": {"value": 1500}, "duration_in_traffic": {"value": 1620},
                   "steps": [{"travel_mode": mode.upper(), "duration": {"value": 1500}}]}
        return {"status": "OK", "routes": [{"legs": [leg], "overview_polyline": {"points": "sim"}}]}

    @staticmethod
    def _tavily(request: httpx.Request) -> dict:
        if request.url.path.endswith("/extract"):
            return {"results": [{"url": "https://example.com", "raw_content": "page text " * 40}]}
        return {"answer": "Simulated answer.", "results": [
            {"title": f"Result {i}", "url": f"https://example.com/{i}",
             "content": "Simulated snippet. " * 12, "score": 0.9 - i / 10} for i in range(3)]}

    # -- the transport -------------------------------------------------------
    async def handle(self, request: httpx.Request) -> httpx.Response:
        service, endpoint = classify(request.url)
        latency = EXTERNAL_LATENCY_S.get(service, 0.05) * self.latency_scale
        trace = CURRENT.get()
        if service == "other":
            self.blocked.append(str(request.url)[:120])
            raise httpx.ConnectError("offline eval: network egress blocked", request=request)
        await asyncio.sleep(latency)
        mode = self.faults.get(service) or (
            self.faults.get("google") if service.startswith("google") else None)
        status, body = 200, None
        if mode == "timeout":
            self._note(trace, service, endpoint, latency, "timeout")
            raise httpx.ReadTimeout("simulated timeout", request=request)
        if mode == "http_403":
            status, body = 403, {"error": {"code": 403, "message": "API key not valid"}}
        elif mode == "http_500":
            status, body = 500, {"error": "internal"}
        elif mode == "denied" and service.startswith("google"):
            body = {"status": "REQUEST_DENIED", "error_message": "The provided API key is invalid.",
                    "results": [], "routes": []}
        elif mode == "zero_results" and service.startswith("google"):
            body = {"status": "ZERO_RESULTS", "results": [], "routes": []}
        elif service == "google_geocode":
            body = self._geocode(request)
        elif service == "google_places":
            body = self._places(request)
        elif service == "google_directions":
            body = self._directions(request)
        elif service == "tavily":
            body = self._tavily(request)
        else:                                       # supabase
            body = []
            status = 200 if request.method == "GET" else 201
        self._note(trace, service, endpoint, latency, status if mode is None else mode)
        return httpx.Response(status, json=body, request=request)

    def _note(self, trace, service: str, endpoint: str, latency: float, status) -> None:
        event = {"service": service, "endpoint": endpoint, "latency_s": latency, "status": status,
                 "tool": CURRENT_TOOL.get()}
        self.calls.append(event)
        if trace is not None:
            trace.ext_events.append(event)
