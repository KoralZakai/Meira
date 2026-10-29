"""What the phone stopped deciding for itself.

Three extractors moved off the device this cycle — onboarding answers, the
check-in verdict, and Gmail events. Each keeps the model for the language work
and takes the consequential decision away from it, and these tests pin exactly
that boundary: completeness is computed, labels come from the table, and an
event that cannot be dated is dropped rather than hopefully kept.

No network: nothing here calls a model.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import checkin_parse
import email_events
import profile_extract


# --- onboarding -------------------------------------------------------------

def test_a_null_never_erases_what_we_already_know():
    merged = profile_extract.merge({"name": "קורל", "homeAddress": "יגאל אלון 94"},
                                   {"name": None, "transportMode": "transit"})
    assert merged["name"] == "קורל"
    assert merged["homeAddress"] == "יגאל אלון 94"
    assert merged["transportMode"] == "transit"


def test_times_are_normalised_and_nonsense_is_refused():
    merged = profile_extract.merge({}, {"workStartTime": "9:00", "sleepTime": "24:30"})
    assert merged["workStartTime"] == "09:00"
    assert "sleepTime" not in merged


REST = {"wakeTime": "07:00", "morningConfirmed": True, "routines": "none",
        "workAddress": "none", "homeAddress": "a", "hasCar": False}


def test_completeness_is_computed_not_asserted():
    # The model used to be able to end onboarding by claiming isComplete.
    still_missing = profile_extract.missing_fields({"name": "קורל"})
    assert "wakeTime" in still_missing
    assert "morningHabitsOrTotal" in still_missing
    assert profile_extract.missing_fields({
        "name": "קורל", "sleepTime": "23:30", "totalMorningMinutesEstimate": 45, **REST,
    }) == []


def test_two_habits_count_as_a_morning_routine():
    assert profile_extract.missing_fields({
        "name": "x", "sleepTime": "23:00", **REST,
        "morningHabits": [{"habit": "shower", "estimatedMinutes": 15},
                          {"habit": "coffee", "estimatedMinutes": 10}],
    }) == []


# --- the check-in verdict ---------------------------------------------------

def test_the_keyword_table_overrules_the_models_category():
    labelled = checkin_parse._label({"text": "ראיון עבודה", "category": "leisure",
                                     "priority": "nice_to_do"})
    assert labelled["category"] == "interview"
    assert labelled["priority"] == "must"
    assert labelled["duration_minutes"] == 90


def test_location_and_deadline_flags_follow_the_values():
    with_place = checkin_parse._label({"text": "gym", "location": "Space Gym"})
    without = checkin_parse._label({"text": "gym"})
    assert with_place["hasLocation"] is True and without["hasLocation"] is False
    assert without["deadline"] is None and without["hasDeadline"] is False


# --- Gmail events -----------------------------------------------------------

def test_an_event_that_cannot_be_dated_is_dropped():
    kept = email_events.clean([{"title": "No date"}, {"title": "Junk", "date": "soonish"}],
                              date(2026, 9, 6))
    assert kept == []


def test_past_events_are_dropped_and_relative_ones_resolved():
    kept = email_events.clean([
        {"title": "Old", "date": "2026-09-01"},
        {"title": "Interview", "date": "מחר"},
    ], date(2026, 9, 6))
    assert [e["title"] for e in kept] == ["Interview"]
    assert kept[0]["date"] == "2026-09-07"


def test_times_are_normalised_and_bad_ones_become_none():
    kept = email_events.clean([
        {"title": "Dentist", "date": "2026-09-10", "time": "9:30"},
        {"title": "Vague", "date": "2026-09-10", "time": "sometime"},
    ], date(2026, 9, 6))
    assert kept[0]["time"] == "09:30"
    assert kept[1]["time"] is None


def test_no_emails_means_no_call_and_no_events():
    import asyncio
    assert asyncio.run(email_events.extract([], date(2026, 9, 6))) == []
