"""× on a routine whose line has commas inside it removes the whole line (21.10, Koral)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import user_profile  # noqa: E402

NOTES = "\n".join([
    "ברמיה 94",
    "קיקבוקס · Sundays · 20:30 · יגאל אלון 76, תל אביב",
    "אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76, תל אביב",
    "אימון בוקר · יום שישי · 11:00 · יגאל אלון 76, תל אביב",
])


def _run(monkeypatch, wanted):
    state = {"notes": NOTES}
    monkeypatch.setattr(user_profile, "get_profile", lambda phone: {"routinesNotes": state["notes"]})
    monkeypatch.setattr(user_profile, "update_profile", lambda phone, **kw: state.update(notes=kw["routinesNotes"]))
    removed = user_profile.remove_routine_lines("p", wanted)
    return removed, state["notes"]


def test_a_line_with_commas_inside_is_removed_whole(monkeypatch):
    line = "אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76, תל אביב"
    removed, notes = _run(monkeypatch, [line])
    assert removed == [line]
    assert line not in notes
    assert "קיקבוקס · Sundays" in notes and "אימון בוקר" in notes


def test_nothing_matched_writes_nothing(monkeypatch):
    removed, notes = _run(monkeypatch, ["a routine she never had"])
    assert removed == [] and notes == NOTES


def test_a_short_fragment_still_removes_by_words(monkeypatch):
    removed, notes = _run(monkeypatch, ["ברמיה 94"])
    assert removed and "ברמיה" not in notes
