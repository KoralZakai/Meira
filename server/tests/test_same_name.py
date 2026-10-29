"""The phone's nameSkeleton and the server's agree on who is the same person."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import name_skeleton  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "same-name.json")


def test_same_name_parity():
    for case in json.load(open(FIXTURE, encoding="utf-8")):
        assert name_skeleton.shares_a_name(case["a"], case["b"]) is case["same"], case


def test_meira_sees_one_call():
    """1.10: her "שיחה עם סגית" and Google's "Sagit/Koral- intro" at 20:30."""
    import day_plan
    import task_rescue
    mine = {"id": "m1", "text": "שיחה עם סגית", "date": "2026-10-01", "fixed_time": "20:30", "duration_minutes": 15}
    google = {"id": "gcal-x", "text": "Sagit/Koral- intro", "date": "2026-10-01", "fixed_time": "20:30",
              "duration_minutes": 60, "source": "calendar", "meetingUrl": "https://meet.google.com/abc"}
    [one] = day_plan.collapse_same_meetings([google, mine])
    assert (one["id"], one["duration_minutes"], one["twin_ids"]) == ("m1", 60, ["gcal-x"])
    assert one["meetingUrl"] == "https://meet.google.com/abc"
    assert task_rescue.already_planned([google], dict(mine, id=None)) is google
    later = dict(google, id="gcal-y", fixed_time="21:30")
    assert len(day_plan.collapse_same_meetings([later, mine])) == 2
