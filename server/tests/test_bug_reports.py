"""Bug intake: the trigger must be exact, and a filed bug must be findable."""
import os
import tempfile
import unittest

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())

import bug_reports


class DetectTests(unittest.TestCase):
    def test_hebrew_with_colon(self):
        self.assertEqual(
            bug_reports.detect("באג בלומי: ההתראות מופיעות פעמיים"),
            "ההתראות מופיעות פעמיים",
        )

    def test_english_case_insensitive(self):
        self.assertEqual(bug_reports.detect("Bug In Lumi: it crashed"), "it crashed")

    def test_hebrew_reversed_order_without_colon(self):
        self.assertEqual(bug_reports.detect("לומי באג הכפתור לא עובד"), "הכפתור לא עובד")

    def test_trigger_with_no_description_is_empty_not_none(self):
        # "" means "asked for a bug, said nothing" — the caller must prompt,
        # not file a blank report. None means "not a bug report at all".
        self.assertEqual(bug_reports.detect("באג בלומי"), "")

    def test_ordinary_message_is_not_a_bug(self):
        self.assertIsNone(bug_reports.detect("קבעי לי חדר כושר מחר ב-18:00"))

    def test_word_bug_alone_is_not_a_trigger(self):
        self.assertIsNone(bug_reports.detect("there is a bug somewhere"))


class StoreTests(unittest.TestCase):
    def setUp(self):
        bug_reports._PATH = os.path.join(tempfile.mkdtemp(), "bugs.json")

    def test_file_and_fetch(self):
        rec = bug_reports.file_bug("972542902729", "notifications appear twice")
        self.assertEqual(rec["status"], "new")
        self.assertTrue(rec["id"].startswith("LUMI-"))
        self.assertEqual(bug_reports.get(rec["id"])["description"], "notifications appear twice")

    def test_status_transition(self):
        rec = bug_reports.file_bug("972542902729", "x")
        moved = bug_reports.set_status(rec["id"], "fixing", issueUrl="http://example/1")
        self.assertEqual(moved["status"], "fixing")
        self.assertEqual(moved["issueUrl"], "http://example/1")

    def test_unknown_status_refused(self):
        rec = bug_reports.file_bug("972542902729", "x")
        self.assertIsNone(bug_reports.set_status(rec["id"], "banana"))
        self.assertEqual(bug_reports.get(rec["id"])["status"], "new")

    def test_open_only_hides_released(self):
        a = bug_reports.file_bug("972542902729", "still broken")
        b = bug_reports.file_bug("972542902729", "already shipped")
        bug_reports.set_status(b["id"], "released")
        open_ids = [r["id"] for r in bug_reports.list_for_phone("972542902729", open_only=True)]
        self.assertIn(a["id"], open_ids)
        self.assertNotIn(b["id"], open_ids)

    def test_phone_scoping(self):
        bug_reports.file_bug("972542902729", "mine")
        bug_reports.file_bug("972500000001", "someone else")
        rows = bug_reports.list_for_phone("0542902729")   # local format, same number
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["description"], "mine")


if __name__ == "__main__":
    unittest.main()
