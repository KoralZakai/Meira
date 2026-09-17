"""The ReAct loop, run against the OpenAI SDK that is already imported.

ReAct is a pattern, not a library: think -> call a tool -> read the result ->
think again. LangGraph does not supply the thinking; the model does. What
LangGraph supplied was the `while` loop below — about ninety lines — in
exchange for 35 MB of resident memory on a 256 MB machine:

    fastapi + httpx + openai      66 MB   (required either way)
    + langchain_openai           +28 MB
    + langgraph                   +7 MB
    + all of Lumi's own modules   +3 MB

The server was OOM-killed on 2026-08-28 and dropped the WhatsApp message Meta
was delivering at the time. `openai` is already resident — it is what the
profile extractor and the embeddings call use — so this loop is free.

Deliberately shaped as a drop-in: `tool`, `ChatOpenAI`, `create_react_agent`,
`AIMessage` and `ToolMessage` keep the names, constructor arguments and
attributes lumi_agent already reads, so swapping it in changes four import
lines and nothing else. In particular `result["messages"]` still interleaves
AIMessage and ToolMessage in call order, because both anti-fabrication guards
walk that list and ask which tools ran and whether they returned ok.

What is NOT reimplemented, because Lumi never used it: checkpointers, state
graphs, streaming, structured output, human-in-the-loop interrupts. If any of
those is ever wanted, take the library back rather than growing this file.

Dependencies: openai (AsyncOpenAI). Consumed by lumi_agent.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
import typing
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

# Nebius occasionally answers a tool call with arguments that are not JSON. The
# model is told, in the tool result, what it did wrong — the same recovery
# LangGraph's handle_tool_errors gave us.
_BAD_ARGS = "Error: could not parse the arguments as JSON. Call the tool again with valid JSON."


# ── messages ────────────────────────────────────────────────────────────────

@dataclass
class AIMessage:
    """One assistant turn: prose, tool calls, or both."""
    content: str = ""
    tool_calls: list = field(default_factory=list)   # [{"id", "name", "args"}]
    usage_metadata: Optional[dict] = None            # {"input_tokens","output_tokens"}


@dataclass
class ToolMessage:
    """What one tool returned, addressed to the call that asked for it."""
    content: str                 # always a string; JSON for dict/list results
    name: str = ""
    tool_call_id: str = ""
    status: str = "success"      # "error" when the tool raised


# ── tools ───────────────────────────────────────────────────────────────────

_JSON_TYPES: dict = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


def _unwrap_optional(annotation: Any) -> tuple:
    """(inner type, is_optional) for `Optional[X]`; (annotation, False) otherwise."""
    if typing.get_origin(annotation) is typing.Union:
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        if len(args) == 1:
            return args[0], True
    return annotation, False


def _param_schema(annotation: Any) -> dict:
    """JSON-schema fragment for one parameter's type hint."""
    inner, _ = _unwrap_optional(annotation)
    origin = typing.get_origin(inner) or inner
    json_type = _JSON_TYPES.get(origin, "string")
    if json_type == "array":
        # Every list argument Lumi has is a list of strings (agent weekdays).
        return {"type": "array", "items": {"type": "string"}}
    return {"type": json_type}


def _schema_from(fn: Callable) -> dict:
    """The OpenAI function schema for a tool: name, docstring, typed parameters.

    A parameter is required exactly when it has no default — the same rule
    LangChain's @tool applied, so the model sees the tool it always saw.
    """
    sig = inspect.signature(fn)
    properties, required = {}, []
    for name, param in sig.parameters.items():
        properties[name] = _param_schema(param.annotation)
        if param.default is inspect.Parameter.empty:
            required.append(name)
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": inspect.getdoc(fn) or "",
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


class Tool:
    """One callable the model may invoke, plus the schema that describes it."""

    def __init__(self, fn: Callable):
        self.fn = fn
        self.name = fn.__name__
        self.description = inspect.getdoc(fn) or ""
        self.schema = _schema_from(fn)

    async def ainvoke(self, args: dict) -> Any:
        """Run the tool and return its RAW result (dict/list), not JSON text.

        Tests call this directly, and so does the loop — which serialises
        afterwards. Keeping serialisation out of here means a tool's own shape
        is what its unit test sees.
        """
        result = self.fn(**(args or {}))
        return await result if inspect.isawaitable(result) else result

    def __call__(self, *args, **kwargs):
        return self.fn(*args, **kwargs)


def tool(fn: Callable) -> Tool:
    """Decorator: mark a function as a tool the agent may call."""
    return Tool(fn)


# ── the model ───────────────────────────────────────────────────────────────

class ChatOpenAI:
    """Sampling settings plus a lazily-built AsyncOpenAI client.

    Same constructor keywords lumi_agent already passes, so the two singletons
    (normal and the higher-temperature retry used after a Qwen repetition loop)
    are unchanged.
    """

    def __init__(self, model: str, base_url: str = "", api_key: str = "",
                 max_tokens: int = 600, temperature: float = 0.4,
                 presence_penalty: Optional[float] = None,
                 frequency_penalty: Optional[float] = None):
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.presence_penalty = presence_penalty
        self.frequency_penalty = frequency_penalty
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    def _sampling(self) -> dict:
        out = {"max_tokens": self.max_tokens, "temperature": self.temperature}
        if self.presence_penalty is not None:
            out["presence_penalty"] = self.presence_penalty
        if self.frequency_penalty is not None:
            out["frequency_penalty"] = self.frequency_penalty
        return out

    async def complete(self, messages: list, tools: list):
        """One chat completion with the tool schemas attached."""
        return await self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            tools=[t.schema for t in tools] or None,
            tool_choice="auto" if tools else None,
            **self._sampling(),
        )


# ── the loop ────────────────────────────────────────────────────────────────

class GraphRecursionError(RuntimeError):
    """Raised when the loop hits its step budget.

    Named to match what lumi_agent._is_recursion looks for, and carries
    `.state` so a partial turn can still be answered rather than dropped —
    exactly what the caller already does with LangGraph's version.
    """

    def __init__(self, message: str, state: dict):
        super().__init__(message)
        self.state = state


def _serialize(value: Any) -> str:
    """A tool result as the string the API (and json.loads downstream) wants."""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _assistant_turn(message: Any) -> dict:
    """The assistant message in wire form, tool calls included.

    Built field by field rather than dumped from the SDK object: providers
    differ on which nulls they tolerate echoed back, and a rejected replay
    would fail the turn after the tools had already run.
    """
    out: dict = {"role": "assistant", "content": message.content or ""}
    if getattr(message, "tool_calls", None):
        out["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.function.name, "arguments": tc.function.arguments},
            }
            for tc in message.tool_calls
        ]
    return out


class _Graph:
    """Just enough of a graph object for GET /debug/graph."""

    def __init__(self, tool_names: list):
        self._tools = tool_names

    def draw_mermaid(self) -> str:
        lines = ["graph TD", "  __start__([__start__]) --> agent[agent]",
                 "  agent -->|tool_calls| tools[tools]",
                 "  tools --> agent", "  agent -->|no tool_calls| __end__([__end__])"]
        for name in self._tools:
            lines.append(f"  tools -.-> {name}")
        return "\n".join(lines)


class ReActAgent:
    """Think, act, observe — until the model answers without calling a tool."""

    def __init__(self, llm: ChatOpenAI, tools: list, prompt: str = ""):
        self.llm = llm
        self.tools = list(tools or [])
        self.by_name = {t.name: t for t in self.tools}
        self.prompt = prompt or ""

    def get_graph(self) -> _Graph:
        return _Graph(list(self.by_name))

    async def _run_tool(self, name: str, raw_args: str, call_id: str) -> ToolMessage:
        """One tool call, including the two ways it can fail.

        A failure is reported back to the model as a normal tool result rather
        than raised: that is how it recovers (calls infer_task_details after
        update_task says the id does not exist) instead of the whole turn dying
        and the user getting an apology for a message that was perfectly clear.
        """
        target = self.by_name.get(name)
        if target is None:
            return ToolMessage(content=f"Error: no tool named {name!r}.",
                               name=name, tool_call_id=call_id, status="error")
        try:
            args = json.loads(raw_args) if raw_args else {}
            if not isinstance(args, dict):
                raise ValueError("arguments must be a JSON object")
        except (json.JSONDecodeError, ValueError):
            logger.warning("tool %s called with unparseable arguments: %r", name, raw_args[:120])
            return ToolMessage(content=_BAD_ARGS, name=name,
                               tool_call_id=call_id, status="error")
        try:
            result = await target.ainvoke(args)
        except Exception as exc:  # noqa: BLE001 — reported to the model, not raised
            logger.warning("tool %s raised: %s", name, exc)
            return ToolMessage(content=f"Error: {exc}", name=name,
                               tool_call_id=call_id, status="error")
        return ToolMessage(content=_serialize(result), name=name, tool_call_id=call_id)

    async def ainvoke(self, state: dict, config: Optional[dict] = None) -> dict:
        """Run the turn. `state["messages"]` is [{"role","content"}, ...].

        Returns {"messages": [...]} holding the AIMessage/ToolMessage sequence
        in call order — the shape both anti-fabrication guards read.
        """
        # LangGraph counted supersteps, and one round trip is two of them (the
        # agent node, then the tools node). Keeping the caller's 15 meaning the
        # same ~7 rounds it always did.
        limit = int((config or {}).get("recursion_limit", 15))
        max_rounds = max(1, math.ceil(limit / 2))

        wire: list = []
        if self.prompt:
            wire.append({"role": "system", "content": self.prompt})
        wire.extend(state.get("messages") or [])

        collected: list = []
        for _round in range(max_rounds):
            response = await self.llm.complete(wire, self.tools)
            choice = response.choices[0].message
            usage = getattr(response, "usage", None)
            ai = AIMessage(
                content=choice.content or "",
                tool_calls=[{"id": tc.id, "name": tc.function.name,
                             "args": tc.function.arguments}
                            for tc in (choice.tool_calls or [])],
                usage_metadata={
                    "input_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                    "output_tokens": getattr(usage, "completion_tokens", 0) or 0,
                },
            )
            collected.append(ai)

            if not choice.tool_calls:
                return {"messages": collected}

            wire.append(_assistant_turn(choice))
            # Calls in one assistant turn are independent by construction, so
            # they run together — three lookups take one lookup's latency.
            results = await asyncio.gather(*[
                self._run_tool(tc.function.name, tc.function.arguments, tc.id)
                for tc in choice.tool_calls
            ])
            for message in results:
                collected.append(message)
                wire.append({"role": "tool", "tool_call_id": message.tool_call_id,
                             "content": message.content})

        raise GraphRecursionError(
            f"agent did not finish within {max_rounds} tool rounds",
            {"messages": collected})


def create_react_agent(llm: ChatOpenAI, tools: list, prompt: str = "") -> ReActAgent:
    """A ReAct agent over these tools. Signature matches langgraph.prebuilt's."""
    return ReActAgent(llm, tools, prompt)
