"""20.10 live eval: "תקבעי לי פגישה" saved a placeholder task called "פגישה"."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lumi_agent  # noqa: E402
import task_extract  # noqa: E402


def _infer(content):
    tool = next(t for t in lumi_agent._make_tools("vague-phone", content) if t.name == "infer_task_details")
    return asyncio.new_event_loop().run_until_complete(tool.ainvoke({"task_text": content, "category": "meeting"}))


def test_nothing_to_save_is_vague_in_both_languages():
    for m in ("תקבעי לי פגישה", "תוסיפי משימה", "remind me", "add a task", "set a meeting"):
        assert task_extract.too_vague(m), m


def test_a_person_a_day_or_an_hour_makes_it_real():
    for m in ("תקבעי לי פגישה עם דני", "פגישה מחר", "meeting at 3", "call mom",
              "תזכירי לי לקנות חלב", "קיקבוקס", "dentist"):
        assert not task_extract.too_vague(m), m


def test_the_tool_refuses_and_says_to_ask():
    res = _infer("תקבעי לי פגישה")
    res = res if isinstance(res, dict) else __import__("json").loads(res)
    assert res["ok"] is False and res["error"] == "too_vague"
