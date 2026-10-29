"""20.10 live eval: reasoning leaked into a reply ("… Let the user know. </think> I don't see…")
and "אם יש משהו נוסף" was scored a fake save."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from react_loop import visible_text  # noqa: E402
from evals import guards  # noqa: E402


def test_bare_close_tag_drops_the_reasoning_before_it():
    raw = "No dentist appointment found. Let the user know. </think> I don't see a dentist appointment."
    assert visible_text(raw) == "I don't see a dentist appointment."


def test_full_think_block_is_removed():
    assert visible_text("<think>plan it</think>\nנשמר ✓") == "נשמר ✓"


def test_plain_reply_and_reasoning_only_reply_survive():
    assert visible_text("Got it!") == "Got it!"
    assert visible_text(None) == ""
    assert visible_text("only reasoning </think>") == "only reasoning"


def test_additional_is_not_added():
    assert not guards.claims_save("הכל טוב! אם יש משהו נוסף – אשמח לעזור. 😊")
    assert not guards.claims_save("בנוסף, יש לך פגישה ב-10:00")
    assert guards.claims_save("✅ נוסף ליומן: שיחה עם נועה")
    assert guards.claims_save("שיחה נוספה ✓")


def test_a_promise_to_check_with_no_tool_is_caught():
    import lumi_agent
    from react_loop import ToolMessage
    said = "I’ll look it up for you—checking your saved tasks now."
    assert lumi_agent._promises_without_acting(said, [])
    assert lumi_agent._promises_without_acting("רגע, אבדוק את היומן", [])
    tool_ran = [ToolMessage(content="{}", tool_call_id="1", name="find_task")]
    assert not lumi_agent._promises_without_acting("I'll check again later if you want.", tool_ran)
    assert not lumi_agent._promises_without_acting("No dentist appointment found.", [])
    assert not lumi_agent._promises_without_acting("בדקתי — אין אימון מחר.", [])


def test_the_reasoning_is_kept_not_thrown_away():
    from react_loop import split_reasoning
    said, thought = split_reasoning("No workout tomorrow. Tell her. </think> לא מצאתי אימון מחר.")
    assert said == "לא מצאתי אימון מחר."
    assert thought == "No workout tomorrow. Tell her."
    assert split_reasoning("<think>a</think>hi") == ("hi", "a")
    assert split_reasoning("hi") == ("hi", "")


def test_the_turn_says_why():
    import lumi_agent
    from react_loop import AIMessage, ToolMessage
    msgs = [ToolMessage(content='{"ok": true, "tasks": []}', name="find_task", tool_call_id="1"),
            ToolMessage(content='{"ok": false, "error": "too_vague"}', name="infer_task_details", tool_call_id="2"),
            AIMessage(content="מה ומתי?", reasoning="Nothing to save; ask.")]
    assert lumi_agent._turn_why(msgs) == "find_task:ok → infer_task_details:failed | Nothing to save; ask."



def test_a_leading_answer_label_is_dropped():
    assert visible_text("Answer: In 5 days it's Sunday, 25.10.") == "In 5 days it's Sunday, 25.10."
    assert visible_text("תשובה: מחר יום רביעי") == "מחר יום רביעי"
    assert visible_text("The answer: is fine") == "The answer: is fine"
