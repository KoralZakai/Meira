"""chat_feedback — 👍/👎 kept per person, replaced per message, removable."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chat_feedback  # noqa: E402


def _fresh():
    chat_feedback._PATH = os.path.join(tempfile.mkdtemp(), "chat_feedback.json")


def test_one_entry_per_message_and_none_removes_it():
    _fresh()
    assert chat_feedback.record("u1", "up", "Bike 7 min", "how?", "m1")
    assert chat_feedback.record("u1", "down", "Bike 7 min", "how?", "m1")
    assert [r["reaction"] for r in chat_feedback.list_all()] == ["down"]
    assert chat_feedback.record("u1", "none", "", "", "m1")
    assert chat_feedback.list_all() == []


def test_people_are_kept_apart_and_bad_input_is_refused():
    _fresh()
    chat_feedback.record("u1", "down", "a", "", "m1")
    chat_feedback.record("u2", "up", "b", "", "m1")
    assert {r["userKey"] for r in chat_feedback.list_all()} == {"u1", "u2"}
    assert [r["reply"] for r in chat_feedback.list_all("down")] == ["a"]
    assert not chat_feedback.record("u1", "love", "x")
    assert not chat_feedback.record("", "up", "x")


def test_texts_are_capped():
    _fresh()
    chat_feedback.record("u1", "down", "x" * 5000, "y" * 5000, "m1")
    row = chat_feedback.list_all()[0]
    assert len(row["reply"]) == 1200 and len(row["question"]) == 1200
