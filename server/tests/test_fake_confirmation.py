"""The reply may not confirm a save that did not happen.

From a real conversation on 30.8 at 12:46:

    user   "לדבר עם יניר מחר ב 16:00"
    Lumi   "✓ עודכן: שיחה עם יניר | יום שני, 31.8 | 16:00"
    stores nothing — no such task in user_memory, none in Supabase, ever

Two independent holes let it through, and both had to be open:

  1. the claim pattern listed נשמר/נוצרה/saved but NOT עודכן or הוספתי — the
     two words Lumi actually writes when it confirms;
  2. the guard asked whether an action tool RAN, not whether it SUCCEEDED.
     update_task ran, returned {"ok": false}, and that counted as an action.

A confirmation for a save that did not happen is worse than an error: she
stopped thinking about it, and nothing ever reminded her.
"""
import json
import re
import unittest


# The guard's own logic, extracted verbatim in shape from lumi_agent so the
# rules can be exercised without a model, a network or LangGraph.
_CLAIM_RE = re.compile(
    r"נשמר|נשמרה|נוצרה|נוצרו|תוזמנ|עודכן|עודכנה|עדכנתי|הוספתי|הוספת|נוסף|נוספה"
    r"|reminder set|saved|scheduled|added|updated",
    re.IGNORECASE)


class FakeToolMessage:
    def __init__(self, name, content):
        self.name = name
        self.content = content


def succeeded(m) -> bool:
    try:
        d = json.loads(m.content) if isinstance(m.content, str) else m.content
    except (json.JSONDecodeError, TypeError):
        return True
    if not isinstance(d, dict):
        return True
    if d.get("ok") is False:
        return False
    return not (d.get("error") and "ok" not in d)


class ClaimPatternTests(unittest.TestCase):
    def test_the_exact_reply_that_got_through(self):
        self.assertTrue(_CLAIM_RE.search("✓ עודכן: שיחה עם יניר"),
                        "'עודכן' must count as a save claim")

    def test_added_counts_too(self):
        self.assertTrue(_CLAIM_RE.search("✓ הוספתי ליום שני, 31.8"))

    def test_english_forms(self):
        for text in ["✓ Added to Monday", "✓ Updated", "✓ saved", "reminder set"]:
            self.assertTrue(_CLAIM_RE.search(text), text)

    def test_ordinary_prose_is_not_a_claim(self):
        for text in ["מה תרצי לעשות מחר?", "Here is your day", "🚌 38 · 15 min"]:
            self.assertIsNone(_CLAIM_RE.search(text), text)


class ToolSuccessTests(unittest.TestCase):
    def test_failed_update_is_not_an_action(self):
        m = FakeToolMessage("update_task", json.dumps(
            {"ok": False, "error": "no task with id X exists — nothing was changed"}))
        self.assertFalse(succeeded(m))

    def test_successful_update_is_an_action(self):
        m = FakeToolMessage("update_task", json.dumps({"ok": True, "task": {"id": "1"}}))
        self.assertTrue(succeeded(m))

    def test_a_created_task_is_an_action(self):
        m = FakeToolMessage("infer_task_details", json.dumps(
            {"text": "שיחה עם יניר", "date": "2026-08-31", "fixed_time": "16:00"}))
        self.assertTrue(succeeded(m), "a tool with no ok field is not a failure")

    def test_unparseable_result_is_never_punished(self):
        self.assertTrue(succeeded(FakeToolMessage("set_reminder", "not json at all")))

    def test_bare_error_without_ok_is_a_failure(self):
        m = FakeToolMessage("set_reminder", json.dumps({"error": "could not parse the time"}))
        self.assertFalse(succeeded(m))


class TogetherTests(unittest.TestCase):
    """Both holes had to be open — closing either one stops the bug."""

    def test_the_yanir_turn_is_now_caught(self):
        messages = [FakeToolMessage("update_task", json.dumps({"ok": False, "error": "not found"}))]
        action_ran = any(m.name in {"update_task", "infer_task_details"} and succeeded(m)
                         for m in messages)
        reply = "✓ עודכן: שיחה עם יניר"
        stripped = action_ran is False and bool(_CLAIM_RE.search(reply))
        self.assertTrue(stripped, "the fabricated confirmation must be stripped")

    def test_a_real_save_is_left_alone(self):
        messages = [FakeToolMessage("infer_task_details", json.dumps(
            {"text": "שיחה עם יניר", "date": "2026-08-31"}))]
        action_ran = any(m.name in {"update_task", "infer_task_details"} and succeeded(m)
                         for m in messages)
        self.assertTrue(action_ran, "a genuine confirmation must survive untouched")


if __name__ == "__main__":
    unittest.main()
