"""user_store — the records that replaced a Postgres nobody ever provisioned.

The bug worth a regression test is not "does JSON round-trip". It is that
`set_push_token_by_phone` used to raise Connection refused into a try/except,
so the app's Expo push token silently had nowhere to go and every reminder
stopped at WhatsApp. These tests assert it now lands and comes back.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import user_store


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class UserStoreTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self._prev = user_store._PATH
        user_store._PATH = os.path.join(self._dir, "user_store.json")
        user_store._ID_CACHE.clear()
        # No Supabase in tests: identity falls back to the stable local id.
        self._prev_lookup = user_store._supabase_user_id

        async def _none(_phone):
            return None
        user_store._supabase_user_id = _none

    def tearDown(self):
        user_store._PATH = self._prev
        user_store._supabase_user_id = self._prev_lookup
        user_store._ID_CACHE.clear()

    # ── phone normalization (moved here with the module) ──
    def test_normalize_strips_punctuation(self):
        self.assertEqual(user_store._normalize_phone("+972-50-000-0000"), "972500000000")

    def test_normalize_empty(self):
        self.assertEqual(user_store._normalize_phone(""), "")

    # ── users ──
    def test_unknown_phone_is_none(self):
        self.assertIsNone(run(user_store.DatabaseService.get_user_by_whatsapp("972500000000")))

    def test_create_then_read_back(self):
        created = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        found = run(user_store.DatabaseService.get_user_by_whatsapp("+972 50 000 0000"))
        self.assertEqual(found["id"], created["id"])

    def test_id_is_stable_across_recreate(self):
        a = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        b = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertEqual(a["id"], b["id"])

    def test_recreate_keeps_push_token(self):
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        run(user_store.DatabaseService.set_push_token_by_phone("972500000000", "ExponentPushToken[x]"))
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertEqual(
            run(user_store.DatabaseService.get_push_token_by_phone("972500000000")),
            "ExponentPushToken[x]")

    def test_get_user_by_id(self):
        created = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertEqual(
            run(user_store.DatabaseService.get_user_by_id(created["id"]))["whatsapp_phone"],
            "972500000000")

    # ── push token: the failure this module exists to fix ──
    def test_push_token_saved_and_returned(self):
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        ok = run(user_store.DatabaseService.set_push_token_by_phone(
            "972500000000", "ExponentPushToken[abc]"))
        self.assertTrue(ok)
        self.assertEqual(
            run(user_store.DatabaseService.get_push_token_by_phone("972500000000")),
            "ExponentPushToken[abc]")

    def test_push_token_for_unknown_phone_reports_false(self):
        self.assertFalse(run(user_store.DatabaseService.set_push_token_by_phone(
            "972500000000", "ExponentPushToken[abc]")))

    def test_push_token_missing_is_none(self):
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertIsNone(run(user_store.DatabaseService.get_push_token_by_phone("972500000000")))

    def test_push_token_survives_a_restart(self):
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        run(user_store.DatabaseService.set_push_token_by_phone("972500000000", "ExponentPushToken[z]"))
        with open(user_store._PATH, encoding="utf-8") as f:      # what a new process would read
            on_disk = json.load(f)
        self.assertEqual(on_disk["users"]["972500000000"]["push_token"], "ExponentPushToken[z]")

    # ── mbti ──
    def test_set_mbti(self):
        created = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        run(user_store.DatabaseService.set_mbti(created["id"], "INFJ", 0.8))
        again = run(user_store.DatabaseService.get_user_by_id(created["id"]))
        self.assertEqual((again["mbti_type"], again["mbti_confidence"]), ("INFJ", 0.8))

    # ── messages: idempotent on the Meta message id (webhook retries 4x) ──
    def test_message_is_idempotent(self):
        u = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        for _ in range(4):
            run(user_store.DatabaseService.save_incoming_message(
                u["id"], "wamid.1", "972500000000", "שלום"))
        self.assertEqual(len(user_store._load()["messages"]), 1)

    def test_messages_are_capped(self):
        u = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        for i in range(user_store._MAX_MESSAGES + 25):
            run(user_store.DatabaseService.save_incoming_message(
                u["id"], f"wamid.{i}", "972500000000", "x"))
        self.assertLessEqual(len(user_store._load()["messages"]), user_store._MAX_MESSAGES)

    # ── personality signals ──
    def test_signals_round_trip(self):
        user_store.add_signal("u1", "suggestion_accepted", "E/I", 0.4)
        user_store.add_signal("u1", "detail_requested", "S/N", 0.6)
        user_store.add_signal("u2", "logic_motivated", "T/F", 0.5)
        self.assertEqual(user_store.signals_for("u1"),
                         [("suggestion_accepted", 0.4), ("detail_requested", 0.6)])

    def test_signals_are_capped(self):
        for _ in range(user_store._MAX_SIGNALS + 10):
            user_store.add_signal("u1", "suggestion_accepted", "E/I", 0.4)
        self.assertEqual(len(user_store.signals_for("u1")), user_store._MAX_SIGNALS)

    # ── handoff tokens ──
    def test_handoff_round_trip(self):
        exp = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        user_store.put_handoff("tok", "u1", exp)
        row = user_store.take_handoff("tok")
        self.assertEqual((row["user_id"], row["used"]), ("u1", False))

    def test_handoff_is_single_use(self):
        exp = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        user_store.put_handoff("tok", "u1", exp)
        user_store.take_handoff("tok")
        self.assertTrue(user_store.take_handoff("tok")["used"])

    def test_handoff_unknown_token(self):
        self.assertIsNone(user_store.take_handoff("nope"))

    def test_expired_tokens_are_pruned_on_write(self):
        past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        future = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        user_store.put_handoff("old", "u1", past)
        user_store.put_handoff("new", "u1", future)
        self.assertNotIn("old", user_store._load()["handoff_tokens"])

    # ── corruption: an OOM kill mid-write must not lose the store ──
    def test_corrupt_file_reads_as_empty_not_crash(self):
        with open(user_store._PATH, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        self.assertEqual(user_store._load()["users"], {})

    def test_write_is_atomic(self):
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertFalse(os.path.exists(user_store._PATH + ".tmp"))


class SupabaseIdentityTests(unittest.TestCase):
    """A linked account's auth id wins, so the app and WhatsApp are one person."""

    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self._prev = user_store._PATH
        user_store._PATH = os.path.join(self._dir, "user_store.json")
        user_store._ID_CACHE.clear()
        self._prev_lookup = user_store._supabase_user_id

    def tearDown(self):
        user_store._PATH = self._prev
        user_store._supabase_user_id = self._prev_lookup
        user_store._ID_CACHE.clear()

    def test_linked_account_id_is_used(self):
        async def _uid(_phone):
            return "auth-uuid-1"
        user_store._supabase_user_id = _uid
        created = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertEqual(created["id"], "auth-uuid-1")

    def test_linking_later_adopts_the_auth_id(self):
        async def _none(_phone):
            return None
        user_store._supabase_user_id = _none
        first = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))

        async def _uid(_phone):
            return "auth-uuid-1"
        user_store._supabase_user_id = _uid          # she links the app afterwards
        found = run(user_store.DatabaseService.get_user_by_whatsapp("972500000000"))
        self.assertNotEqual(first["id"], found["id"])
        self.assertEqual(found["id"], "auth-uuid-1")


if __name__ == "__main__":
    unittest.main()


class PushRegisterRecoveryTests(unittest.TestCase):
    """A linked number with no local record must still get its token stored.

    The regression this pins: on 2026-08-31 the app finally obtained an Expo
    push token (Firebase was configured that morning) and POSTed it — and the
    server answered 404, because user_store had been created hours earlier and
    held no record for a phone that had not messaged Lumi since. Firebase
    working and the token still going nowhere is precisely the failure mode
    that hides for days.
    """

    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self._prev = user_store._PATH
        user_store._PATH = os.path.join(self._dir, "user_store.json")
        user_store._ID_CACHE.clear()
        self._prev_lookup = user_store._supabase_user_id

    def tearDown(self):
        user_store._PATH = self._prev
        user_store._supabase_user_id = self._prev_lookup
        user_store._ID_CACHE.clear()

    def test_unknown_phone_is_rejected_before_the_supabase_check(self):
        """The bare setter stays strict — the recovery lives in the endpoint."""
        self.assertFalse(run(user_store.DatabaseService.set_push_token_by_phone(
            "972500000000", "ExponentPushToken[a]")))

    def test_creating_the_record_then_setting_the_token_succeeds(self):
        """What the endpoint now does when Supabase confirms the number."""
        async def _uid(_phone):
            return "auth-uuid-1"
        user_store._supabase_user_id = _uid
        run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertTrue(run(user_store.DatabaseService.set_push_token_by_phone(
            "972500000000", "ExponentPushToken[a]")))
        self.assertEqual(
            run(user_store.DatabaseService.get_push_token_by_phone("972500000000")),
            "ExponentPushToken[a]")

    def test_the_created_record_carries_the_auth_id(self):
        async def _uid(_phone):
            return "auth-uuid-1"
        user_store._supabase_user_id = _uid
        created = run(user_store.DatabaseService.create_user_from_whatsapp("972500000000"))
        self.assertEqual(created["id"], "auth-uuid-1")
