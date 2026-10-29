"""Routines are added to, never overwritten (user_profile, 6.10).

save_profile's description said "appending", but update_profile replaced the
field, and the prompt never showed the model what was saved — so a second
routine told in the chat wiped the first. The voice check-in did the same
through /app/profile/extract. Every writer now merges line by line.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import identity_keys
import routine_match
import user_profile
from user_profile import merge_routine_lines as merge

KICK = "קיקבוקס 20:30-21:30 יגאל אלון 94"
MORNING = "מקלחת בוקר, קפה, להתלבש"


class MergeLines(unittest.TestCase):
    def test_a_new_routine_is_appended(self):
        self.assertEqual(merge(KICK, "יוגה ראשון 07:00"), f"{KICK}\nיוגה ראשון 07:00")

    def test_the_same_routine_twice_is_kept_once(self):
        self.assertEqual(merge(KICK, KICK), KICK)
        self.assertEqual(merge(KICK, "קיקבוקס 20:30-21:30 יגאל אלון 94."), KICK)

    def test_a_line_that_adds_its_days_replaces_the_one_it_extends(self):
        self.assertEqual(merge(f"{KICK}\n{MORNING}", f"{KICK} · ימי ג׳"),
                         f"{KICK} · ימי ג׳\n{MORNING}")

    def test_a_comma_part_is_widened_in_place(self):
        out = merge(f"{KICK}, {MORNING}", "קיקבוקס 20:30-21:30 יגאל אלון 94 בימי שלישי")
        # 11.10: the newer telling replaces the old one on a line of its own —
        # gluing it into the comma list is how one workout became twelve lines.
        self.assertEqual(out.split("\n")[0], "קיקבוקס 20:30-21:30 יגאל אלון 94 בימי שלישי", out)
        self.assertEqual(out.count("קיקבוקס"), 1, out)
        self.assertIn("מקלחת בוקר", out)

    def test_a_short_part_is_not_swallowed_by_a_new_plan(self):
        out = merge(MORNING, "קפה עם דנה שישי 10:00")
        self.assertIn("קפה עם דנה שישי 10:00", out)
        self.assertIn("קפה", out.split("\n")[0])          # the morning list kept its coffee

    def test_what_is_already_there_is_returned_exactly_as_written(self):
        text = "kids 16:00 every day; " + KICK
        self.assertEqual(merge(text, "kids 16:00 every day"), text)
        self.assertEqual(merge("", "  " + KICK + "  "), KICK)

    def test_a_partial_word_is_not_a_match(self):
        self.assertEqual(merge("גנים בערב 18:00", "גן 08:00"), "גנים בערב 18:00\nגן 08:00")


class ProfileWrites(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self._prev = user_profile._PATH
        user_profile._PATH = os.path.join(self._dir, "profiles.json")
        identity_keys.invalidate()

    def tearDown(self):
        user_profile._PATH = self._prev

    def test_two_routines_told_one_by_one_are_both_kept(self):
        user_profile.update_profile("k1", routinesNotes=KICK)
        user_profile.update_profile("k1", routinesNotes="יוגה ראשון 07:00")
        notes = user_profile.get_profile("k1")["routinesNotes"]
        self.assertIn("קיקבוקס", notes)
        self.assertIn("יוגה", notes)

    def test_the_voice_check_in_adds_instead_of_replacing(self):
        user_profile.update_profile("k2", routinesNotes=f"{KICK}\n{MORNING}")
        # profile_extract passes only what this answer carried
        user_profile.update_profile("k2", routinesNotes="ריצה שני 06:30")
        notes = user_profile.get_profile("k2")["routinesNotes"]
        self.assertEqual(len(user_profile.routine_lines(notes)), 3)

    def test_remove_drops_only_the_named_routine(self):
        user_profile.update_profile("k3", routinesNotes=f"{KICK}\n{MORNING}")
        removed = user_profile.remove_routine_lines("k3", "קיקבוקס")
        self.assertEqual(removed, [KICK])
        self.assertEqual(user_profile.get_profile("k3")["routinesNotes"], MORNING)

    def test_remove_a_comma_part(self):
        user_profile.update_profile("k4", routinesNotes=MORNING)
        self.assertEqual(user_profile.remove_routine_lines("k4", "קפה"), ["קפה"])
        self.assertEqual(user_profile.get_profile("k4")["routinesNotes"], "מקלחת בוקר, להתלבש")

    def test_remove_nothing_matched_writes_nothing(self):
        user_profile.update_profile("k5", routinesNotes=KICK)
        self.assertEqual(user_profile.remove_routine_lines("k5", "פילאטיס"), [])
        self.assertEqual(user_profile.remove_routine_lines("k5", "ab"), [])   # too short to mean anything
        self.assertEqual(user_profile.get_profile("k5")["routinesNotes"], KICK)

    def test_replace_a_line_with_its_days(self):
        user_profile.update_profile("k6", routinesNotes=f"{KICK}\n{MORNING}")
        self.assertTrue(user_profile.replace_routine_line("k6", KICK, f"{KICK} · ימי ג׳"))
        self.assertEqual(user_profile.get_profile("k6")["routinesNotes"], f"{KICK} · ימי ג׳\n{MORNING}")

    def test_replace_says_so_when_the_line_is_gone(self):
        user_profile.update_profile("k7", routinesNotes=MORNING)
        self.assertFalse(user_profile.replace_routine_line("k7", KICK, f"{KICK} · ימי ג׳"))
        self.assertEqual(user_profile.get_profile("k7")["routinesNotes"], MORNING)


class DaysUnsaid(unittest.TestCase):
    """What save_profile reports back so the agent asks "every day, or which days?"."""

    def unsaid(self, text):
        return [r["text"] for r in routine_match.parse(text) if r.get("time") and not r.get("weekdays")]

    def test_an_hour_without_a_day_is_unsaid(self):
        self.assertEqual(self.unsaid(KICK), [KICK])

    def test_a_day_or_every_day_is_said(self):
        self.assertEqual(self.unsaid("קיקבוקס בשלישי 20:30"), [])
        self.assertEqual(self.unsaid("kids 16:00 every day"), [])

    def test_no_hour_is_not_a_question_about_days(self):
        self.assertEqual(self.unsaid("מקלחת בוקר"), [])


if __name__ == "__main__":
    unittest.main()
