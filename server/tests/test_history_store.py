"""history_store — nothing without her yes, nothing older than 90 days, and a
failed read is never an empty week.

Supabase, embeddings and the profile store are mocked; what is tested is the
module's own guarantees.
"""
import asyncio
import os
import sys
import unittest
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import history_store as hs  # noqa: E402

TODAY = date(2026, 10, 20)


def run(c):
    return asyncio.run(c)


class Base(unittest.TestCase):
    def setUp(self):
        self.profile = {"historyOptIn": True, "language": "he"}
        self.upserts, self.deletes = [], []
        self.read_rows = []

        async def _upsert(path, rows, on_conflict=None):
            self.upserts.append((path, rows, on_conflict))
            return True

        async def _delete(path, params):
            self.deletes.append((path, params))
            return True

        async def _get(path, params):
            return self.read_rows

        patches = [
            mock.patch.object(hs.identity_keys, "canonical", side_effect=lambda k: k if str(k).startswith("brain:") else f"brain:{k}"),
            mock.patch.object(hs.identity_keys, "keys_of", side_effect=lambda k: [k]),
            mock.patch.object(hs.user_profile, "get_profile", side_effect=lambda k: self.profile),
            mock.patch.object(hs.user_profile, "update_profile",
                              side_effect=lambda k, **f: self.profile.update(f) or self.profile),
            mock.patch.object(hs.database_service, "enabled", return_value=True),
            mock.patch.object(hs.database_service, "_upsert", _upsert),
            mock.patch.object(hs.database_service, "_delete", _delete),
            mock.patch.object(hs.database_service, "_get", _get),
            mock.patch.object(hs.dedup_service, "embed_texts",
                              mock.AsyncMock(side_effect=lambda texts: [[0.1, 0.2]] * len(texts))),
            mock.patch.object(hs, "today_il", return_value=TODAY),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class Record(Base):
    def test_nothing_is_stored_without_her_yes(self):
        self.profile["historyOptIn"] = False
        got = run(hs.record("u1", [{"kind": "moved", "day": "2026-10-20", "taskId": "t"}]))
        self.assertFalse(got["ok"])
        self.assertEqual(got["reason"], "not_opted_in")
        self.assertEqual(self.upserts, [])

    def test_rows_are_cleaned_keyed_embedded_and_idempotent(self):
        got = run(hs.record("u1", [
            {"kind": "moved", "day": "2026-10-20", "taskId": "t1", "text": "לשלוח דוח",
             "data": {"from": "2026-10-19", "to": "2026-10-20"}},
            {"kind": "hacked", "day": "2026-10-20"},                 # unknown kind
            {"kind": "completed", "day": "2026-06-01", "taskId": "old"},  # past retention
            {"kind": "trip", "day": "2026-10-20", "taskId": "r", "minutes": 99999},  # absurd minutes
        ]))
        self.assertTrue(got["ok"])
        path, rows, conflict = self.upserts[0]
        self.assertEqual((path, conflict), ("lumi_history", "userKey,dedupKey"))
        self.assertEqual(len(rows), 2)
        moved = rows[0]
        self.assertEqual(moved["userKey"], "brain:u1")
        self.assertEqual(moved["embedding"], [0.1, 0.2])
        self.assertEqual(moved["dedupKey"], "moved:t1:2026-10-20:2026-10-19")
        self.assertIsNone(rows[1]["minutes"])

    def test_every_write_prunes_past_90_days(self):
        run(hs.record("u1", [{"kind": "missed", "day": "2026-10-20", "taskId": "t"}]))
        self.assertIn(("lumi_history", {"userKey": "eq.brain:u1", "day": "lt.2026-07-22"}), self.deletes)

    def test_a_third_move_is_reported_as_a_streak(self):
        self.read_rows = [{"kind": "moved", "taskId": "t1", "text": "דוח", "day": d}
                          for d in ("2026-10-18", "2026-10-19", "2026-10-20")]
        got = run(hs.record("u1", [{"kind": "moved", "day": "2026-10-20", "taskId": "t1", "text": "דוח"}]))
        self.assertEqual(got["streaks"], [{"taskId": "t1", "text": "דוח", "moves": 3}])

    def test_a_failed_write_says_so(self):
        with mock.patch.object(hs.database_service, "_upsert", mock.AsyncMock(return_value=False)):
            got = run(hs.record("u1", [{"kind": "missed", "day": "2026-10-20", "taskId": "t"}]))
        self.assertEqual(got, {"ok": False, "reason": "write_failed", "stored": 0})

    def test_no_embeddings_still_stores_the_row(self):
        with mock.patch.object(hs.dedup_service, "embed_texts", mock.AsyncMock(return_value=None)):
            got = run(hs.record("u1", [{"kind": "missed", "day": "2026-10-20", "taskId": "t", "text": "x"}]))
        self.assertTrue(got["ok"])
        self.assertNotIn("embedding", self.upserts[0][1][0])


class Reads(Base):
    def test_a_failed_read_is_a_reason_not_an_empty_list(self):
        with mock.patch.object(hs.database_service, "_get", mock.AsyncMock(return_value=None)):
            rows, reason = run(hs.events("u1", "2026-10-01", "2026-10-20"))
        self.assertIsNone(rows)
        self.assertEqual(reason, "read_failed")

    def test_report_fails_loudly_when_tasks_cannot_be_read(self):
        with mock.patch.object(hs, "tasks", mock.AsyncMock(return_value=(None, "http_500"))):
            got = run(hs.report("u1"))
        self.assertEqual((got["ok"], got["reason"]), (False, "http_500"))

    def test_report_has_numbers_targets_and_a_line(self):
        self.profile["weeklyTargets"] = {"workouts": 3}
        rows = [{"id": "g", "date": "2026-10-19", "text": "gym", "category": "gym", "status": "complete"}]
        with mock.patch.object(hs, "tasks", mock.AsyncMock(return_value=(rows, None))):
            got = run(hs.report("u1"))
        self.assertTrue(got["ok"])
        self.assertEqual(got["current"]["workouts"], 1)
        self.assertIn("1/3", got["line"])


class Consent(Base):
    def test_no_deletes_everything_and_turns_it_off(self):
        got = run(hs.set_consent("u1", False))
        self.assertEqual(got["optedIn"], False)
        self.assertFalse(self.profile["historyOptIn"])
        self.assertIn(("lumi_history", {"userKey": "eq.brain:u1"}), self.deletes)

    def test_yes_backfills_from_her_tasks(self):
        self.profile["historyOptIn"] = False
        rows = [{"id": "a", "date": "2026-10-19", "text": "gym", "category": "gym", "status": "complete"}]
        with mock.patch.object(hs, "tasks", mock.AsyncMock(return_value=(rows, None))):
            got = run(hs.set_consent("u1", True))
        self.assertTrue(got["optedIn"])
        self.assertEqual(got["backfilled"], 1)
        self.assertTrue(self.profile["historyOptInAt"])

    def test_targets(self):
        self.assertEqual(hs.set_target("u1", "workouts", 3), {"workouts": 3})
        self.assertEqual(hs.set_target("u1", "workouts", 0), {})


class Backfill(unittest.TestCase):
    def test_events_from_tasks(self):
        evs = hs.events_from_tasks([
            {"id": "a", "date": "2026-10-19", "text": "gym", "category": "gym", "status": "complete",
             "actualDurationMinutes": 55},
            {"id": "b", "date": "2026-10-20", "text": "דוח", "status": "missed",
             "movedFromDate": "2026-10-18"},
            {"id": "c", "date": "2026-10-20", "text": "pending", "status": "pending"},
        ])
        kinds = sorted((e["kind"], e["dedupKey"]) for e in evs)
        self.assertEqual(kinds, [("completed", "completed:a:2026-10-19"),
                                 ("missed", "missed:b:2026-10-20"),
                                 ("moved", "moved:b:2026-10-18:2026-10-20")])
        self.assertEqual(next(e for e in evs if e["kind"] == "completed")["minutes"], 55)


if __name__ == "__main__":
    unittest.main()
