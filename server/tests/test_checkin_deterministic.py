"""The check-in screen's verdict, decided by rules and not by a model.

Every transcript used to go to Nebius to be sorted into one of nine intents —
the same question `src/services/TaskIntent.ts` answers offline in under a
millisecond, on the phone, for free. These tests pin the port: the intents, the
Hebrew (where a wrong word boundary has silently killed whole branches before),
and the fact that no client is constructed at all.
"""
import asyncio
import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import checkin_parse  # noqa: E402
import task_intent    # noqa: E402


def parse(text, mode="capture", pending=None):
    return asyncio.run(checkin_parse.parse(text, mode, pending))


# ── it does not call a model ────────────────────────────────────────────────

def test_no_model_call_anywhere_in_the_module():
    src = inspect.getsource(checkin_parse)
    for banned in ("AsyncOpenAI", "chat.completions", "LLM_MODEL", "import config"):
        assert banned not in src, f"{banned} is back — the check-in is paying for a lookup"


def test_the_response_says_it_was_deterministic():
    assert parse("יוגה ב-11:00")["source"] == "deterministic"


# ── intents, both languages ─────────────────────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("תעירי אותי ב-7", "wake_up"),
    ("wake me up at 6:30", "wake_up"),
    ("move the gym to 18:00", "task_update"),
    ("תזיז את היוגה ל-19:00", "task_update"),
    ("תמחק את המשימה של הראיון", "task_update"),
    ("סיימתי עם הרופא", "check_in"),
    ("done with the gym", "check_in"),
    ("add a meeting tomorrow", "add_tasks"),
    ("תוסיף פגישה מחר", "add_tasks"),
    ("יוגה ב-11:00 ביגאל אלון", "add_tasks"),
    ("sort my day", "optimize"),
    ("תסדרי לי את היום", "optimize"),
    ("אני גר ביגאל אלון 94", "profile_update"),
    ("I usually wake at 7", "profile_update"),
    ("these two overlap", "conflict"),
    ("כלום", "empty_list"),
    ("nothing", "empty_list"),
])
def test_intent_classification(text, expected):
    assert task_intent.classify(text) == expected, text


def test_mode_decides_the_ambiguous_tail():
    """'the doctor' is a capture in one screen and a tick-off in the other."""
    assert task_intent.classify("the doctor", "capture") == "add_tasks"
    assert task_intent.classify("the doctor", "review") == "check_in"


def test_a_request_to_add_beats_an_update_verb():
    """'add a meeting and move it to 6' is an add — the TypeScript agrees."""
    assert task_intent.classify("add a meeting and move it to 6") == "add_tasks"


# ── capture ─────────────────────────────────────────────────────────────────

def test_capture_labels_from_the_table_not_from_a_guess():
    task = parse("ראיון עבודה מחר ב-11:30")["tasks"][0]
    assert task["category"] == "interview"
    assert task["priority"] == "must"
    assert task["deadline"] == "11:30"
    assert task["duration_minutes"] > 0


def test_capture_splits_only_on_a_real_separator():
    """Over-splitting invents tasks nobody asked for."""
    two = parse("gym at six and then call mum")["tasks"]
    assert [t["text"] for t in two] == ["gym at six", "call mum"]
    one = parse("ראיון עבודה במר גרופ")["tasks"]
    assert len(one) == 1, "a place inside a task is not a second task"


def test_capture_never_swallows_the_sentence():
    """Returning nothing for something the user just said is the worst
    available outcome (the rule task_extract already follows)."""
    tasks = parse("...")["tasks"]
    assert tasks and tasks[0]["text"]


# ── review ──────────────────────────────────────────────────────────────────

def test_review_matches_what_was_done_against_what_was_pending():
    out = parse("סיימתי עם הרופא", "review", ["תור לרופא", "יוגה"])
    assert out["intent"] == "check_in"
    assert out["matched_task_texts"] == ["תור לרופא"]


def test_review_matches_two_at_once():
    out = parse("I did the gym and the weekly shop", "review",
                ["Gym", "Weekly shop", "Dentist"])
    assert set(out["matched_task_texts"]) == {"Gym", "Weekly shop"}
    assert "Dentist" not in out["matched_task_texts"]


def test_review_matches_nothing_rather_than_something_wrong():
    out = parse("סיימתי עם הרופא", "review", ["יוגה", "קניות"])
    assert out["matched_task_texts"] == []


# ── updates ─────────────────────────────────────────────────────────────────

def test_an_update_names_the_real_pending_task_and_the_new_time():
    out = parse("move the gym to 18:00", "review", ["Gym 17:00", "Dentist"])
    assert out["intent"] == "task_update"
    assert out["task_updates"] == [{"target_text": "Gym 17:00", "new_text": None,
                                    "new_location": None, "new_deadline": "18:00"}]


def test_a_hebrew_update_resolves_a_bare_hour():
    out = parse("תזיז את היוגה ל-19", "review", ["יוגה בבוקר"])
    assert out["task_updates"][0]["new_deadline"] == "19:00"


def test_an_update_with_no_known_target_still_says_what_it_meant():
    out = parse("move the gym to 18:00", "review", [])
    assert out["task_updates"][0]["target_text"] == "gym"


# ── the reference stripper ──────────────────────────────────────────────────

def test_the_reference_drops_verbs_and_times():
    assert task_intent.reference("move the gym to 18:00") == "gym"
    assert "תזיז" not in task_intent.reference("תזיז את היוגה ל-19:00")


def test_hebrew_patterns_are_not_anchored_on_ascii_word_boundaries():
    r"""\b is defined on ASCII \w, so \bמחר\b matches nothing — that mistake
    made a whole Hebrew branch of the TypeScript dead code.

    Checked against the COMPILED patterns rather than the file text, so the
    comment explaining the trap does not trip the test that guards it.
    """
    import re as _re
    compiled = [v for v in vars(task_intent).values()
                if isinstance(v, _re.Pattern)]
    assert compiled, "no patterns found — did the module change shape?"
    for pattern in compiled:
        for alternative in pattern.pattern.split("|"):
            if any("֐" <= ch <= "׿" for ch in alternative):
                assert "\\b" not in alternative, (
                    f"ASCII word boundary next to Hebrew: {alternative[:70]}")
