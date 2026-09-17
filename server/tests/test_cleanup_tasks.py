"""user_memory.cleanup_tasks — removes past-deadline + duplicate tasks."""
import os
import tempfile
import unittest
from unittest import mock

import user_memory as um

TODAY = "2026-08-03"


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._p = mock.patch.object(um, "_PATH", os.path.join(self._tmp, "user_memory.json"))
        self._p.start()

    def tearDown(self):
        self._p.stop()

    def _seed(self, tasks):
        um._save({"972": {"tasks": tasks}})

    def test_removes_past_and_dupes_keeps_future(self):
        self._seed([
            {"id": "1", "date": "2026-07-24", "text": "submit DDP work", "status": "pending"},   # past
            {"id": "2", "date": "2026-08-03", "text": "interview prep", "status": "pending"},     # today
            {"id": "3", "date": "2026-08-03", "text": "interview  prep!", "status": "pending"},    # dup of #2
            {"id": "4", "date": "2026-08-05", "text": "Nebius graduation", "fixed_time": "18:00",
             "status": "pending"},                                                                # future
        ])
        res = um.cleanup_tasks("972", TODAY)
        self.assertEqual(res["removed_past"], 1)
        self.assertEqual(res["removed_dupes"], 1)
        self.assertEqual(res["kept"], 2)
        texts = {t["text"] for t in um.tasks_for_phone("972")}
        self.assertNotIn("submit DDP work", texts)          # past gone
        self.assertIn("Nebius graduation", texts)           # future kept

    def test_dup_keeps_richer_entry(self):
        self._seed([
            {"id": "a", "date": "2026-08-04", "text": "meeting", "status": "pending"},
            {"id": "b", "date": "2026-08-04", "text": "meeting", "fixed_time": "11:00",
             "location": "Meta", "status": "pending"},
        ])
        um.cleanup_tasks("972", TODAY)
        kept = um.tasks_for_phone("972")
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["id"], "b")                # the detailed one survived

    def test_noop_for_unknown_phone(self):
        self._seed([{"id": "1", "date": "2026-08-05", "text": "x", "status": "pending"}])
        res = um.cleanup_tasks("000000", TODAY)
        self.assertEqual(res, {"removed_past": 0, "removed_dupes": 0, "kept": 0})


if __name__ == "__main__":
    unittest.main()
