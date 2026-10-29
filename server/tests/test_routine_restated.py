"""11.10, Koral: one workout (Sun–Tue 20:00 and Fri 11:00 at Yigal Alon 94, by
bike), told to Meira by voice, chat and typing, was twelve lines — some glued
into one comma line — and five cards on "Tomorrow". Saying it again must
REPLACE what was there. These are her real lines.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import routine_match  # noqa: E402
import stt  # noqa: E402
from user_profile import merge_routine_lines  # noqa: E402

HERS = "\n".join([
    "אימון · יום ראשון, שני ושלישי · 20:00 · עיגול אלון 94, תל אביב",
    "יוגה ב 11 ימי שישי",
    "אימון בערב · יום ראשון, יום שני, יום שלישי · 20:00",
    "אימון בוקר · יום שישי · 11:00",
    "work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96 · באופניים",
    "אימון · יום ראשון, שני, שלישי, יום שישי · 20:00 או 11:00 · יגאל אלון 94 · באופניים, שלישי · 20:00 · "
    "עיגל אלון 94, אימונים · יום שישי · 11:00 · יגאל אלון 94, תל אביב · באופניים",
    "קפה עם דנה · שישי · 10:00",
])
NEW = "אימון · ראשון, שני, שלישי · 20:00 · יגאל אלון 94, תל אביב · באופניים"


class SayingItAgainReplacesIt(unittest.TestCase):
    def test_the_evening_workout_is_one_line_after(self):
        out = merge_routine_lines(HERS, NEW).split("\n")
        evening = [l for l in out if "20:00" in l]
        self.assertEqual(evening, [NEW], out)

    def test_what_else_she_said_stays(self):
        out = merge_routine_lines(HERS, NEW)
        self.assertIn("יוגה ב 11 ימי שישי", out)
        self.assertIn("אימון בוקר · יום שישי · 11:00", out)
        self.assertIn("קפה עם דנה · שישי · 10:00", out)
        self.assertIn("אימונים · יום שישי · 11:00 · יגאל אלון 94", out)

    def test_different_things_are_not_one(self):
        self.assertFalse(routine_match.same_routine("פילאטיס · א׳", "אימון · ראשון · 20:30"))
        self.assertFalse(routine_match.same_routine("יוגה · שישי · 11:00", "פילאטיס · שישי · 11:00"))
        self.assertFalse(routine_match.same_routine("אימון · שני · 20:00", "אימון · שני · 07:00"))
        self.assertTrue(routine_match.same_routine("יוגה ב 11:00 ימי שישי", "אימון בוקר · יום שישי · 11:00"))


class TheStreetSheMeant(unittest.TestCase):
    def test_misheard_yigal_alon_is_fixed_and_google_spelling_is_not_touched(self):
        self.assertEqual(stt.fix_places("אני מתאמנת בעיגל אלון 96"), "אני מתאמנת ביגאל אלון 96")
        self.assertEqual(stt.fix_places("עיגול אלון 94, תל אביב"), "יגאל אלון 94, תל אביב")
        self.assertEqual(stt.fix_places("Yigal Alon Street"), "Yigal Alon Street")


if __name__ == "__main__":
    unittest.main()


class AVenueIsNotSentToHerCity(unittest.TestCase):
    """13.10: "רפאל מכון דוד, Mordei ha-Geta'ot Street" — the home street glued on
    by the phone's old cityOf — could not be routed at all."""

    def test_the_glued_home_street_comes_off(self):
        import daychain
        self.assertEqual(daychain.address_of({"location": {"address": "רפאל מכון  דוד, Mordei ha-Geta'ot Street"}}),
                         "רפאל מכון  דוד")
        self.assertEqual(daychain.address_of({"location": {"address": "Yigal Alon St 94, Tel Aviv-Yafo"}}),
                         "Yigal Alon St 94, Tel Aviv-Yafo")

    def test_only_a_street_with_a_number_gets_her_city(self):
        home = "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo"
        self.assertEqual(routine_match.complete_address("רפאל מכון דוד", home), "רפאל מכון דוד")
        self.assertEqual(routine_match.complete_address("יגאל אלון 94", home), "יגאל אלון 94, Tel Aviv-Yafo")
