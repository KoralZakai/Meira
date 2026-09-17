"""The pending-mirror queue must flush even when the phone is written two ways.

Found live: /diag/sync reported 37 queued tasks for a phone that /link/verify
resolved successfully, yet the flush moved zero of them:

    {"linked": true, "flushed": 0}     # ...and the count stayed at 37

user_id_for_phone normalizes generously (exact digits, then a last-9-digit
suffix match, then a digits-normalized scan), which is why the link resolved.
flush_pending compared with strict string equality, so a task queued as
"0500000000" was invisible to a flush called with "972500000000". The tasks
were never lost — they were unreachable, and the endpoint reported success.

This is the same shape as the two bugs in HANDOFF.md: an operation that returns
OK while doing nothing, whose zero is read as "nothing to do".
"""
import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import supabase_tasks


class SamePhoneTests(unittest.TestCase):
    def test_local_and_international_forms_are_the_same_number(self):
        self.assertTrue(supabase_tasks._same_phone("0500000000", "972500000000"))
        self.assertTrue(supabase_tasks._same_phone("972500000000", "0500000000"))
        self.assertTrue(supabase_tasks._same_phone("+972-50-000-0000", "0500000000"))

    def test_identical_digits_match(self):
        self.assertTrue(supabase_tasks._same_phone("972500000000", "972500000000"))

    def test_different_numbers_never_match(self):
        self.assertFalse(supabase_tasks._same_phone("0500000000", "0501234567"))
        # Same tail, genuinely different subscriber numbers.
        self.assertFalse(supabase_tasks._same_phone("0500000000", "0543902729"))

    def test_short_or_empty_values_do_not_match_by_accident(self):
        # "0001" sits in the live queue and must never be flushed to a real
        # account just because a suffix happens to line up.
        self.assertFalse(supabase_tasks._same_phone("0001", "972500000000"))
        self.assertFalse(supabase_tasks._same_phone("", "972500000000"))
        self.assertFalse(supabase_tasks._same_phone("972500000000", ""))
        self.assertFalse(supabase_tasks._same_phone(None, "972500000000"))


class FlushPendingTests(unittest.TestCase):
    def _run(self, queued_phone, flush_phone, upsert_ok=True):
        """Queue one task under `queued_phone`, flush with `flush_phone`.
        Returns (flushed_count, remaining_queue)."""
        upserted = []

        async def fake_uid(_phone):
            return "user-1"

        async def fake_upsert(uid, task):
            upserted.append((uid, task))
            return "row-1" if upsert_ok else None

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pending_mirror.json")
            with patch.object(supabase_tasks, "_PENDING_PATH", path), \
                 patch.object(supabase_tasks, "user_id_for_phone", fake_uid), \
                 patch.object(supabase_tasks, "upsert_task", fake_upsert):
                supabase_tasks.queue_pending(
                    queued_phone, {"id": "t1", "text": "גיים", "fixed_time": "11:00"})
                flushed = asyncio.run(supabase_tasks.flush_pending(flush_phone))
                with open(path, encoding="utf-8") as f:
                    remaining = json.load(f)
        return flushed, remaining, upserted

    def test_the_live_bug_queued_local_flushed_international(self):
        flushed, remaining, upserted = self._run("0500000000", "972500000000")
        self.assertEqual(flushed, 1, "the queued task must reach Supabase")
        self.assertEqual(remaining, [], "and must not stay queued afterwards")
        self.assertEqual(upserted[0][1]["fixed_time"], "11:00",
                         "the time must survive the mirror")

    def test_the_reverse_direction_too(self):
        flushed, remaining, _ = self._run("972500000000", "0500000000")
        self.assertEqual(flushed, 1)
        self.assertEqual(remaining, [])

    def test_identical_forms_still_work(self):
        flushed, remaining, _ = self._run("972500000000", "972500000000")
        self.assertEqual(flushed, 1)
        self.assertEqual(remaining, [])

    def test_another_persons_task_is_never_flushed_to_this_account(self):
        flushed, remaining, upserted = self._run("0501234567", "972500000000")
        self.assertEqual(flushed, 0)
        self.assertEqual(len(remaining), 1, "it stays queued for its real owner")
        self.assertEqual(upserted, [], "and is never written to the wrong account")

    def test_a_failed_upsert_keeps_the_task_queued(self):
        # No data loss: a task that could not be written must remain, or the
        # queue becomes a way to silently drop tasks.
        flushed, remaining, _ = self._run("0500000000", "972500000000", upsert_ok=False)
        self.assertEqual(flushed, 0)
        self.assertEqual(len(remaining), 1)


if __name__ == "__main__":
    unittest.main()
