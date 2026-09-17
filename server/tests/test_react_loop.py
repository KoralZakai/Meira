"""react_loop — the ReAct loop that replaced LangGraph.

These are the tests that make the swap safe. The risk in dropping a library is
never "does it call the model"; it is the quiet shape changes: an Optional
argument that becomes required and makes the model stop calling a tool, a tool
result that stops being JSON so the anti-fabrication guard can no longer read
`ok`, an error that propagates instead of being handed back for the model to
recover from. Each of those has a test here.
"""
import asyncio
import json
import os
import sys
import unittest
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import react_loop
from react_loop import AIMessage, ToolMessage, create_react_agent, tool


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── a fake model: scripted replies, no network ──────────────────────────────

class _Fn:
    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments


class _Call:
    def __init__(self, call_id, name, arguments):
        self.id, self.function = call_id, _Fn(name, arguments)


class _Choice:
    def __init__(self, content, tool_calls):
        self.message = self
        self.content, self.tool_calls = content, tool_calls


class _Usage:
    def __init__(self, pin, pout):
        self.prompt_tokens, self.completion_tokens = pin, pout


class _Response:
    def __init__(self, content="", tool_calls=None, usage=(10, 5)):
        self.choices = [_Choice(content, tool_calls)]
        self.usage = _Usage(*usage)


class FakeLLM:
    """Replays a script of responses and records what it was sent."""

    def __init__(self, script):
        self.script = list(script)
        self.seen = []          # each call's wire messages
        self.tools_seen = []

    async def complete(self, messages, tools):
        self.seen.append(list(messages))
        self.tools_seen.append(list(tools))
        return self.script.pop(0)


# ── tool schemas ────────────────────────────────────────────────────────────

class SchemaTests(unittest.TestCase):
    def test_required_is_exactly_the_args_without_defaults(self):
        @tool
        async def infer_task_details(task_text: str, category: str = "general",
                                     fixed_time: Optional[str] = None) -> dict:
            """Extract a task."""
            return {}

        params = infer_task_details.schema["function"]["parameters"]
        self.assertEqual(params["required"], ["task_text"])

    def test_optional_str_is_still_a_string(self):
        @tool
        async def t(a: Optional[str] = None) -> dict:
            """d"""
            return {}
        self.assertEqual(t.schema["function"]["parameters"]["properties"]["a"],
                         {"type": "string"})

    def test_types_map(self):
        @tool
        async def t(a: str, b: int, c: bool, d: float, e: Optional[list] = None) -> dict:
            """d"""
            return {}
        props = t.schema["function"]["parameters"]["properties"]
        self.assertEqual(props["a"]["type"], "string")
        self.assertEqual(props["b"]["type"], "integer")
        self.assertEqual(props["c"]["type"], "boolean")
        self.assertEqual(props["d"]["type"], "number")
        self.assertEqual(props["e"], {"type": "array", "items": {"type": "string"}})

    def test_description_is_the_docstring(self):
        @tool
        async def find_place(query: str) -> dict:
            """Look up WHERE a place is by NAME."""
            return {}
        self.assertIn("Look up WHERE", find_place.schema["function"]["description"])

    def test_name_survives(self):
        @tool
        async def plan_departure(destination: str) -> dict:
            """d"""
            return {}
        self.assertEqual(plan_departure.name, "plan_departure")

    def test_no_arg_tool_has_empty_required(self):
        @tool
        async def send_app_link() -> dict:
            """d"""
            return {}
        self.assertEqual(send_app_link.schema["function"]["parameters"]["required"], [])

    def test_ainvoke_returns_the_raw_object(self):
        """Tests (and the loop) rely on this NOT being pre-serialised JSON."""
        @tool
        async def t(a: str) -> dict:
            """d"""
            return {"ok": True, "a": a}
        self.assertEqual(run(t.ainvoke({"a": "x"})), {"ok": True, "a": "x"})


# ── the loop ────────────────────────────────────────────────────────────────

def _echo_tool():
    @tool
    async def echo(value: str) -> dict:
        """Echo."""
        return {"ok": True, "value": value}
    return echo


class LoopTests(unittest.TestCase):
    def test_plain_answer_needs_one_call(self):
        llm = FakeLLM([_Response(content="שלום!")])
        agent = create_react_agent(llm, [_echo_tool()], prompt="be Lumi")
        out = run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}))
        self.assertEqual(len(out["messages"]), 1)
        self.assertEqual(out["messages"][0].content, "שלום!")

    def test_system_prompt_goes_first(self):
        llm = FakeLLM([_Response(content="x")])
        agent = create_react_agent(llm, [], prompt="be Lumi")
        run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}))
        self.assertEqual(llm.seen[0][0], {"role": "system", "content": "be Lumi"})

    def test_tool_round_trip_order(self):
        """AIMessage, ToolMessage, AIMessage — the order both guards walk."""
        llm = FakeLLM([
            _Response(tool_calls=[_Call("c1", "echo", '{"value": "hi"}')]),
            _Response(content="done"),
        ])
        agent = create_react_agent(llm, [_echo_tool()])
        out = run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}))
        kinds = [type(m).__name__ for m in out["messages"]]
        self.assertEqual(kinds, ["AIMessage", "ToolMessage", "AIMessage"])

    def test_tool_result_is_json_the_guard_can_read(self):
        llm = FakeLLM([
            _Response(tool_calls=[_Call("c1", "echo", '{"value": "hi"}')]),
            _Response(content="done"),
        ])
        agent = create_react_agent(llm, [_echo_tool()])
        out = run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}))
        tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(tm.name, "echo")
        self.assertEqual(json.loads(tm.content), {"ok": True, "value": "hi"})

    def test_hebrew_survives_serialisation(self):
        @tool
        async def t(value: str) -> dict:
            """d"""
            return {"text": "לדבר עם יניר"}
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "t", '{"value":"x"}')]),
                       _Response(content="ok")])
        out = run(create_react_agent(llm, [t]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(json.loads(tm.content)["text"], "לדבר עם יניר")

    def test_tool_result_is_replayed_to_the_model(self):
        llm = FakeLLM([
            _Response(tool_calls=[_Call("c1", "echo", '{"value": "hi"}')]),
            _Response(content="done"),
        ])
        run(create_react_agent(llm, [_echo_tool()]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        second = llm.seen[1]
        self.assertEqual(second[-1]["role"], "tool")
        self.assertEqual(second[-1]["tool_call_id"], "c1")
        self.assertEqual(second[-2]["role"], "assistant")
        self.assertEqual(second[-2]["tool_calls"][0]["function"]["name"], "echo")

    def test_parallel_calls_all_run(self):
        llm = FakeLLM([
            _Response(tool_calls=[_Call("c1", "echo", '{"value":"a"}'),
                                  _Call("c2", "echo", '{"value":"b"}')]),
            _Response(content="done"),
        ])
        out = run(create_react_agent(llm, [_echo_tool()]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        values = [json.loads(m.content)["value"]
                  for m in out["messages"] if isinstance(m, ToolMessage)]
        self.assertEqual(sorted(values), ["a", "b"])

    def test_several_rounds(self):
        llm = FakeLLM([
            _Response(tool_calls=[_Call("c1", "echo", '{"value":"a"}')]),
            _Response(tool_calls=[_Call("c2", "echo", '{"value":"b"}')]),
            _Response(content="done"),
        ])
        out = run(create_react_agent(llm, [_echo_tool()]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        self.assertEqual(len([m for m in out["messages"] if isinstance(m, ToolMessage)]), 2)
        self.assertEqual(out["messages"][-1].content, "done")


class ToolFailureTests(unittest.TestCase):
    """A failing tool is reported to the model, never raised at the caller.

    This is how the agent recovers — update_task saying the id does not exist
    is what makes it call infer_task_details instead. If a failure escaped, the
    turn would die and the user would get an apology for a clear message.
    """

    def test_raising_tool_becomes_an_error_result(self):
        @tool
        async def boom(a: str) -> dict:
            """d"""
            raise RuntimeError("nebius said no")
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "boom", '{"a":"x"}')]),
                       _Response(content="sorry, try again")])
        out = run(create_react_agent(llm, [boom]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(tm.status, "error")
        self.assertIn("nebius said no", tm.content)
        self.assertEqual(out["messages"][-1].content, "sorry, try again")

    def test_unparseable_arguments_do_not_crash(self):
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "echo", "{not json")]),
                       _Response(content="ok")])
        out = run(create_react_agent(llm, [_echo_tool()]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(tm.status, "error")

    def test_unknown_tool_name(self):
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "no_such_tool", "{}")]),
                       _Response(content="ok")])
        out = run(create_react_agent(llm, [_echo_tool()]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(tm.status, "error")
        self.assertIn("no_such_tool", tm.content)

    def test_empty_arguments_string_means_no_arguments(self):
        @tool
        async def list_reminders() -> list:
            """d"""
            return [{"time": "09:00"}]
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "list_reminders", "")]),
                       _Response(content="ok")])
        out = run(create_react_agent(llm, [list_reminders]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(tm.status, "success")


class BudgetTests(unittest.TestCase):
    def test_recursion_limit_raises_with_a_partial_state(self):
        """lumi_agent answers from exc.state rather than dropping the turn."""
        llm = FakeLLM([_Response(tool_calls=[_Call(f"c{i}", "echo", '{"value":"x"}')])
                       for i in range(10)])
        agent = create_react_agent(llm, [_echo_tool()])
        with self.assertRaises(react_loop.GraphRecursionError) as ctx:
            run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]},
                              config={"recursion_limit": 6}))
        self.assertIn("messages", ctx.exception.state)
        self.assertTrue(ctx.exception.state["messages"])

    def test_the_error_is_recognised_as_recursion(self):
        """Matches lumi_agent._is_recursion, which reads the type name."""
        name = react_loop.GraphRecursionError.__name__.lower()
        self.assertIn("graphrecursion", name)

    def test_recursion_limit_15_still_means_seven_rounds(self):
        llm = FakeLLM([_Response(tool_calls=[_Call(f"c{i}", "echo", '{"value":"x"}')])
                       for i in range(20)])
        agent = create_react_agent(llm, [_echo_tool()])
        with self.assertRaises(react_loop.GraphRecursionError):
            run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]},
                              config={"recursion_limit": 15}))
        self.assertEqual(len(llm.seen), 8)   # ceil(15/2)


class UsageTests(unittest.TestCase):
    def test_every_step_reports_tokens(self):
        """Billing visibility sums usage_metadata over all ReAct steps."""
        llm = FakeLLM([
            _Response(tool_calls=[_Call("c1", "echo", '{"value":"x"}')], usage=(100, 20)),
            _Response(content="done", usage=(150, 30)),
        ])
        out = run(create_react_agent(llm, [_echo_tool()]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        ai = [m for m in out["messages"] if isinstance(m, AIMessage)]
        self.assertEqual(sum(m.usage_metadata["input_tokens"] for m in ai), 250)
        self.assertEqual(sum(m.usage_metadata["output_tokens"] for m in ai), 50)


class GraphTests(unittest.TestCase):
    def test_mermaid_names_the_tools(self):
        diagram = create_react_agent(FakeLLM([]), [_echo_tool()]).get_graph().draw_mermaid()
        self.assertIn("graph TD", diagram)
        self.assertIn("echo", diagram)


if __name__ == "__main__":
    unittest.main()
