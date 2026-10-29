"""What she says now owns its slot: an older routine at the same day and hour loses that day (21.10, Koral)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import user_profile as up  # noqa: E402

OLD = "\n".join([
    "ברמיה 94",
    "קיקבוקס · Sundays · 20:30 · יגאל אלון 76, תל אביב",
    "training · Thursdays · 19:00 · יגאל אלון 76, תל אביב",
    "אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76, תל אביב",
    "אימון בוקר · יום שישי · 11:00 · יגאל אלון 76, תל אביב",
])
SAID = "יש לי יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי"


def test_tuesday_workout_becomes_yoga_and_keeps_its_place():
    out = up.merge_routine_lines(OLD, SAID).split("\n")
    assert "יוגה · יום שלישי · 20:00-21:30 · יגאל אלון 76, תל אביב" in out
    assert "יוגה · יום שישי · 11:00-12:30 · יגאל אלון 76, תל אביב" in out


def test_the_old_line_loses_only_the_day_she_replaced():
    out = up.merge_routine_lines(OLD, SAID)
    assert "יום ראשון, שני ושלישי" not in out
    old_line = next(l for l in out.split("\n") if l.startswith("אימון ·"))
    assert "א׳" in old_line and "ב׳" in old_line and "ג׳" not in old_line
    assert "20:00" in old_line and "יגאל אלון 76" in old_line


def test_the_friday_workout_is_replaced_not_kept_beside_the_yoga():
    out = up.merge_routine_lines(OLD, SAID)
    assert "אימון בוקר" not in out


def test_other_days_and_other_hours_are_untouched():
    out = up.merge_routine_lines(OLD, SAID)
    assert "קיקבוקס · Sundays · 20:30" in out        # Sunday, and 20:30 is another day anyway
    assert "training · Thursdays · 19:00" in out
    assert "ברמיה 94" in out


def test_a_different_hour_on_the_same_day_is_not_a_clash():
    old = "אימון · יום שלישי · 08:00 · יגאל אלון 76"
    out = up.merge_routine_lines(old, "יוגה · יום שלישי · 20:00-21:30")
    assert "אימון · יום שלישי · 08:00" in out and "יוגה · יום שלישי · 20:00-21:30" in out


def test_her_own_free_words_are_never_rewritten():
    old = "ארוחת ערב עם סבתא בשלישי 20:00"
    out = up.merge_routine_lines(old, "יוגה · יום שלישי · 20:00-21:30")
    assert "ארוחת ערב עם סבתא בשלישי 20:00" in out
