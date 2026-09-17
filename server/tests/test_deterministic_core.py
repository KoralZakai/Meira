"""The day is built by code, and the label comes from a table.

These two modules replace LLM calls that were doing arithmetic and lookups, so
the tests are about the properties that made the LLM version wrong: a day that
started in the past, a fixed appointment that drifted, a Hebrew task that fell
through an English-only path, and a model guess that overwrote a correct label.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import categorize
import day_schedule


# --- the timeline -----------------------------------------------------------

def _tasks():
    return [
        {"text": "gym", "category": "gym", "duration_minutes": 60, "priority": "must"},
        {"text": "interview", "category": "interview", "fixed_time": "10:00", "priority": "must"},
        {"text": "study PPO", "category": "course", "duration_minutes": 30, "priority": "have_to"},
        {"text": "water the plants", "priority": "nice_to_do"},
    ]


def test_cursor_never_starts_in_the_past():
    day = day_schedule.build_day_schedule(_tasks(), "08:00", now="12:56")
    gym = next(t for t in day if t["text"] == "gym")
    assert gym["scheduled_time"] >= "13:00"


def test_fixed_task_keeps_its_clock_time():
    day = day_schedule.build_day_schedule(_tasks(), "08:00", now="12:56")
    interview = next(t for t in day if t["text"] == "interview")
    assert interview["scheduled_time"] == "10:00"


def test_study_gets_a_three_hour_floor():
    day = day_schedule.build_day_schedule(_tasks(), "08:00")
    study = next(t for t in day if t["text"] == "study PPO")
    assert study["duration_minutes"] == 180


def test_important_only_leaves_the_rest_unscheduled_but_present():
    day = day_schedule.build_day_schedule(_tasks(), "08:00", important_only=True)
    plants = next(t for t in day if t["text"] == "water the plants")
    assert "scheduled_time" not in plants
    assert len(day) == 4          # nothing is dropped, only left off the timeline


def test_priority_before_clock():
    day = day_schedule.build_day_schedule([
        {"text": "late must", "priority": "must", "fixed_time": "18:00"},
        {"text": "early nice", "priority": "nice_to_do", "fixed_time": "07:00"},
    ], "06:00")
    assert [t["text"] for t in day] == ["late must", "early nice"]


def test_leave_home_time_outranks_the_fixed_time():
    # The clock that governs the morning is when she has to walk out the door.
    a = {"text": "far", "priority": "must", "fixed_time": "10:00",
         "location": {"leaveHomeBy": "08:10"}}
    b = {"text": "near", "priority": "must", "fixed_time": "09:00"}
    assert [t["text"] for t in day_schedule.build_day_schedule([b, a], "07:00")] == ["far", "near"]


def test_camel_case_tasks_from_the_app_are_understood():
    day = day_schedule.build_day_schedule(
        [{"text": "ראיון", "fixedTime": "09:30", "durationMinutes": 90, "priority": "must"}], "08:00")
    assert day[0]["scheduledTime"] == "09:30"      # camelCase caller gets its own key
    assert day[0]["scheduled_time"] == "09:30"


def test_flexible_stale_slot_is_reassigned_pinned_time_is_not():
    day = day_schedule.build_day_schedule([
        {"text": "stale", "scheduled_time": "07:00", "priority": "need_to"},
        {"text": "pinned", "fixed_time": "16:00", "priority": "need_to"},
    ], "08:00", now="12:56")
    by_text = {t["text"]: t for t in day}
    assert by_text["stale"]["scheduled_time"] >= "13:00"
    assert by_text["pinned"]["scheduled_time"] == "16:00"


def test_times_wrap_instead_of_producing_garbage():
    assert day_schedule.add_minutes("23:30", 60) == "00:30"
    assert day_schedule.minutes_to_time(-45) == "23:15"
    assert day_schedule.round_up_quarter("12:56") == "13:00"
    assert day_schedule.round_up_quarter("13:00") == "13:00"


# --- the label --------------------------------------------------------------

def test_hebrew_is_not_a_fallback():
    assert categorize.infer("ראיון עבודה במר גרופ")["category"] == "interview"
    assert categorize.infer("אימון בחדר כושר")["category"] == "gym"
    assert categorize.infer("להתקשר לאמא")["category"] == "call"
    assert categorize.infer("תור לרופא שיניים")["category"] == "doctor"
    assert categorize.infer("שיעור פילאטיס")["category"] == "gym"


def test_stated_urgency_overrides_the_rule():
    assert categorize.infer("דחוף להתקשר לביטוח")["priority"] == "must"
    assert categorize.infer("אולי לצאת לסרט")["priority"] == "nice_to_do"


def test_default_duration_comes_from_the_category():
    assert categorize.infer("call the bank")["duration_minutes"] == 15
    assert categorize.infer("ראיון")["duration_minutes"] == 90


def test_the_table_wins_over_the_model_when_it_matched():
    merged = categorize.merge("ראיון עבודה", {"category": "leisure", "priority": "nice_to_do"})
    assert merged["category"] == "interview"
    assert merged["priority"] == "must"


def test_the_model_may_still_fill_a_blank():
    merged = categorize.merge("water the plants", {"category": "leisure", "duration_minutes": 20})
    assert merged["category"] == "leisure"
    assert merged["duration_minutes"] == 20


def test_a_junk_category_from_the_model_is_refused():
    assert categorize.merge("water the plants", {"category": "🌱"})["category"] == "general"


def test_learned_average_beats_the_static_default():
    assert categorize.merge("gym", {}, learned={"gym": 75})["duration_minutes"] == 75
