"""A task the DB refuses is a task the user lost.

`tasks` constrains priority to ('must','have_to','need_to','nice_to_do') and
status to five values (migration 0001). Nothing enforced that on the way in.
When a value fell outside — priority='high', which categorize.py cannot emit,
so the model produced it — Postgres rejected the ENTIRE row with 23514,
upsert_task logged a warning and returned None, and the caller carried on. The
phone got 200 OK. The task was never in the cloud.

Seen in production on 2026-09-10:

    POST /rest/v1/tasks?on_conflict=userId,id "HTTP/1.1 400 Bad Request"
    upsert_task rejected (400): {"code":"23514","details":"Failing row contains
    (cb69e31a-..., לעשות lean canvas model, work, high, ...)

These pin the clamp that stops it. The rule they encode: a task filed under
the wrong urgency is recoverable by the user, a task that never saved is not,
so an unrecognised value degrades to the default rather than failing the write.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from supabase_tasks import _clamp_priority, _clamp_status

VALID_PRIORITIES = ("must", "have_to", "need_to", "nice_to_do")
VALID_STATUSES = ("pending", "complete", "missed", "moved", "partial")


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("high", "must"),          # the exact value that lost a task
        ("urgent", "must"),
        ("critical", "must"),
        ("p0", "must"),
        ("important", "have_to"),
        ("medium", "need_to"),
        ("normal", "need_to"),
        ("low", "nice_to_do"),
        ("optional", "nice_to_do"),
        # already valid — must pass through untouched
        ("must", "must"),
        ("have_to", "have_to"),
        ("need_to", "need_to"),
        ("nice_to_do", "nice_to_do"),
        # shape, not just spelling
        ("HIGH", "must"),
        ("  High  ", "must"),
        ("have to", "have_to"),
    ],
)
def test_priority_aliases_resolve(raw, expected):
    assert _clamp_priority(raw) == expected


@pytest.mark.parametrize("raw", ["gibberish", "", None, 0, [], "p9"])
def test_unknown_priority_degrades_rather_than_failing_the_write(raw):
    assert _clamp_priority(raw) == "need_to"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("done", "complete"),
        ("completed", "complete"),
        ("finished", "complete"),
        ("skipped", "missed"),
        ("postponed", "moved"),
        ("rescheduled", "moved"),
        ("in_progress", "partial"),
        ("started", "partial"),
        ("pending", "pending"),
        ("complete", "complete"),
        ("DONE", "complete"),
    ],
)
def test_status_aliases_resolve(raw, expected):
    assert _clamp_status(raw) == expected


@pytest.mark.parametrize("raw", ["gibberish", "", None, 42])
def test_unknown_status_degrades_to_pending(raw):
    assert _clamp_status(raw) == "pending"


def test_every_output_satisfies_the_check_constraint():
    """The whole point: no input can produce a value Postgres would reject."""
    hostile = [
        "high", "low", "medium", None, "", "gibberish", 0, [], {}, "must",
        "P0", "nice to do", "urgent!!", "דחוף", "  ", "None", "null",
    ]
    for raw in hostile:
        assert _clamp_priority(raw) in VALID_PRIORITIES, raw
        assert _clamp_status(raw) in VALID_STATUSES, raw
