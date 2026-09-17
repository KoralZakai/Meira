"""Three reported WhatsApp failures, pinned.

1. Picking a travel option did not work. Lumi printed "Option 1/2/3 — pick a
   train (1-3)", and every way of answering — "option 2", "2", "רכבת אופציה 3",
   the whole option pasted back — fell through to the model, which had never
   seen the timetable and replied "לא הבנתי את התשובה" while asking again where
   she was leaving from. Six turns, no ride chosen.

2. A list of things to DO was read as a request to DELETE. "icons for סינון
   drop down", inside eight design tasks, matched the bare word "drop" in the
   delete trigger; with no single match to delete it answered a page of new
   work with "Which task should I delete?".

3. Those eight tasks arrived as eight unrelated rows. They were one project,
   written in one breath.

Run: python3 -m unittest tests.test_route_pick_and_grouping -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import task_grouping  # noqa: E402


class OptionPickParsing(unittest.TestCase):
    """How she actually answers a numbered question."""

    def setUp(self):
        import main  # noqa: PLC0415 — imported here so DATA_DIR is set first
        self.pick = main._picked_option

    def test_bare_number(self):
        self.assertEqual(self.pick("2"), 2)
        self.assertEqual(self.pick("3"), 3)

    def test_the_word_option(self):
        self.assertEqual(self.pick("option 2"), 2)
        self.assertEqual(self.pick("Option 3"), 3)

    def test_hebrew(self):
        self.assertEqual(self.pick("אופציה 3"), 3)
        self.assertEqual(self.pick("רכבת אופציה 3 , תשימי תזכורת"), 3)
        self.assertEqual(self.pick("אפשרות 1"), 1)

    def test_the_whole_block_pasted_back(self):
        # She quoted the option she wanted, times and all.
        quoted = ("אני רוצה את זה - Option 2:\n⏰ Wake up by 09:49\n"
                  "🚶 7 min to Tel Aviv Ha'Hagana Station\n📍 Arrive by 12:17")
        self.assertEqual(self.pick(quoted), 2)

    def test_ordinary_sentences_are_not_picks(self):
        self.assertIsNone(self.pick("מהבית וברכבת"))
        self.assertIsNone(self.pick("תזכירי לי להתקשר לאמא"))


class OptionDeparture(unittest.TestCase):
    """A picked ride becomes a real departure, with its own reminders."""

    def setUp(self):
        import main
        self.main = main

    def test_wake_and_leave_come_from_the_picked_option(self):
        option = {"leaveBy": "09:49", "arriveAt": "12:17", "minutes": 88,
                  "departAt": "10:51", "legs": [{"type": "train", "line": "אשקלון"}]}
        head = {"destination": "HaMezah 10", "destResolved": "10, Kfar Vitkin",
                "date": "2026-09-01", "routineMinutes": 45, "fromHome": True}
        dep = self.main._option_departure(option, head)
        self.assertEqual(dep["leaveHomeBy"], "09:49")
        self.assertEqual(dep["arriveBy"], "12:17")
        self.assertEqual(dep["wakeUpBy"], "09:04", "leave minus the 45-min routine")
        self.assertEqual(dep["date"], "2026-09-01")

    def test_no_wake_time_when_she_is_not_starting_from_home(self):
        option = {"leaveBy": "09:49", "arriveAt": "12:17"}
        head = {"routineMinutes": 45, "fromHome": False}
        self.assertIsNone(self.main._option_departure(option, head)["wakeUpBy"])

    def test_button_title_fits_whatsapp_and_names_the_ride(self):
        title = self.main._option_button_title({"departAt": "10:51"}, 2, "he")
        self.assertIn("10:51", title)
        self.assertLessEqual(len(title), 20)


class DeleteTrigger(unittest.TestCase):
    """Deleting needs an unambiguous ask."""

    def setUp(self):
        import main
        self.main = main

    def test_drop_down_is_not_a_delete(self):
        self.assertIsNone(self.main._DELETE_RE.search("icons for סינון drop down"))

    def test_real_delete_requests_still_fire(self):
        for phrase in ("delete the gym task", "תמחקי את הראיון", "cancel my dentist",
                       "drop the task", "remove that"):
            self.assertIsNotNone(self.main._DELETE_RE.search(phrase), phrase)

    def test_a_list_of_tasks_is_never_a_delete(self):
        listed = ("משימות למחר- להכין lean canvas model\n"
                  "לפתוח ללומי חשבון gmail\n"
                  "להכין אתר - דף נחיתה\n"
                  "icons for סינון drop down")
        self.assertTrue(self.main._looks_like_a_list(listed))

    def test_one_line_is_not_a_list(self):
        self.assertFalse(self.main._looks_like_a_list("תמחקי את הראיון"))


class Grouping(unittest.TestCase):
    """One message, one subject."""

    BATCH = [
        "להכין lean canvas model",
        "לפתוח ללומי חשבון gmail",
        "להכין אתר - דף נחיתה",
        "לשנות את העיצוב: אייקונים לפי icons8 ios 27, liquid glass components",
        "font - heebo hebrew / assistant",
        "icons for סינון drop down",
        "dribble - דוגמאות של ux ui",
        "i frame - show the map on the app",
    ]

    def test_the_design_batch_gets_one_label(self):
        self.assertEqual(
            task_grouping.group_label(self.BATCH, "משימות למחר- להכין lean canvas model"),
            "עיצוב UX/UI",
        )

    def test_english_label_for_an_english_user(self):
        self.assertEqual(task_grouping.group_label(self.BATCH, "", "en"), "UX/UI design")

    def test_a_pair_is_not_a_project(self):
        self.assertIsNone(task_grouping.group_label(["לקנות חלב", "להתקשר לאמא"], ""))

    def test_unrelated_tasks_get_no_theme_but_may_get_the_heading(self):
        mixed = ["לקנות חלב", "להתקשר לאמא", "לשלם ארנונה"]
        self.assertEqual(task_grouping.group_label(mixed, "משימות למחר- לקנות חלב"),
                         "משימות למחר")
        self.assertIsNone(task_grouping.group_label(mixed, "לקנות חלב"))


if __name__ == "__main__":
    unittest.main()
