"""One person, one brain key (identity_keys, 6.10).

The bug: the agent saved her routines under her account id, the app's routes
read and wrote under her phone, and a pre-link uuid5 record sat beside both.
The kickboxing she told the chat never reached the phone, her 👍/👎 never
reached the agent, and account deletion removed one record of three.

These tests build exactly that three-way split and check every reader agrees.
"""
import asyncio
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import account_deletion
import feedback_store
import identity_keys
import user_profile
import user_store

PHONE = "972501234567"
UID = "0b6c2f6a-1111-4c3e-9d2a-5f8e7a6b4c3d"


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class SplitPerson(unittest.TestCase):
    """A linked user with data under the uid, the phone and the old uuid5."""

    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self._paths = (user_store._PATH, user_profile._PATH, feedback_store._PATH)
        user_store._PATH = os.path.join(self._dir, "user_store.json")
        user_profile._PATH = os.path.join(self._dir, "profiles.json")
        feedback_store._PATH = os.path.join(self._dir, "feedback.json")
        data = user_store._load()
        data["users"][PHONE] = {"id": UID, "whatsapp_phone": PHONE}
        user_store._save(data)
        identity_keys.invalidate()
        identity_keys._seen.clear()
        self.local = user_store._local_id(PHONE)

    def tearDown(self):
        user_store._PATH, user_profile._PATH, feedback_store._PATH = self._paths
        identity_keys.invalidate()
        identity_keys._seen.clear()

    # ── the map ──────────────────────────────────────────────────────────────
    def test_every_key_resolves_to_the_account_id(self):
        self.assertEqual(identity_keys.canonical(PHONE), UID)
        self.assertEqual(identity_keys.canonical(self.local), UID)
        self.assertEqual(identity_keys.canonical(UID), UID)
        self.assertEqual(identity_keys.canonical("someone-else"), "someone-else")

    def test_aliases_are_the_phone_and_the_pre_link_id(self):
        self.assertEqual(set(identity_keys.aliases_of(UID)), {PHONE, self.local})
        self.assertEqual(identity_keys.keys_of(PHONE)[0], UID)

    def test_a_verified_caller_outranks_a_stale_record(self):
        data = user_store._load()
        data["users"][PHONE]["id"] = self.local          # lookup failed when it was made
        user_store._save(data)
        identity_keys.invalidate()
        identity_keys.note_caller(UID, PHONE)
        self.assertEqual(identity_keys.canonical(PHONE), UID)

    def test_brain_key_of_an_app_caller_is_the_account_id(self):
        caller = {"userId": UID, "phone": PHONE, "key": PHONE}
        self.assertEqual(identity_keys.brain_key(caller), UID)
        self.assertEqual(identity_keys.brain_key({"key": PHONE}), UID)
        keys = identity_keys.all_keys(caller)
        self.assertEqual(keys[0], UID)
        self.assertTrue({PHONE, self.local} <= set(keys))

    # ── the profile ──────────────────────────────────────────────────────────
    def _split_profile(self):
        """Her 6.10 state: the chat's line under the uid, the voice check-in's
        under her phone, a transport she said under the pre-link id."""
        data = user_profile._load()
        data[UID] = {**user_profile._DEFAULTS, "routinesNotes": "קיקבוקס 20:30-21:30 יגאל אלון 94"}
        data[PHONE] = {**user_profile._DEFAULTS, "routinesNotes": "יוגה ראשון 07:00", "language": "he"}
        data[self.local] = {**user_profile._DEFAULTS, "transportType": "bike"}
        user_profile._save(data)

    def test_the_routine_told_in_chat_reaches_the_phone(self):
        self._split_profile()
        caller = {"userId": UID, "phone": PHONE, "key": PHONE}
        prof = user_profile.get_profile(identity_keys.brain_key(caller))
        self.assertIn("קיקבוקס", prof["routinesNotes"])
        self.assertIn("יוגה", prof["routinesNotes"])

    def test_what_she_said_beats_a_default(self):
        self._split_profile()
        prof = user_profile.get_profile(UID)
        self.assertEqual(prof["transportType"], "bike")   # the uid record only had the default car
        self.assertEqual(prof["language"], "he")

    def test_the_webhook_writing_by_phone_lands_on_the_account(self):
        self._split_profile()
        user_profile.update_profile(PHONE, currentAddress="Azrieli")
        data = user_profile._load()
        self.assertEqual(data[UID]["currentAddress"], "Azrieli")
        self.assertEqual(data[UID]["transportType"], "bike")   # the union was kept on write
        self.assertEqual(data[PHONE].get("_mergedInto"), UID)

    def test_a_merged_record_cannot_bring_an_old_value_back(self):
        self._split_profile()
        user_profile.update_profile(UID, hobbies="climbing")          # first write merges
        user_profile.update_profile(UID, transportType="car")         # she changes it back
        self.assertEqual(user_profile.get_profile(PHONE)["transportType"], "car")

    def test_nothing_is_deleted_by_the_merge(self):
        self._split_profile()
        user_profile.update_profile(UID, hobbies="climbing")
        data = user_profile._load()
        self.assertIn(PHONE, data)
        self.assertIn(self.local, data)

    # ── feedback ─────────────────────────────────────────────────────────────
    def test_feedback_recorded_under_her_phone_is_still_hers(self):
        feedback_store.record(PHONE, "errand", "down", "Laundry Express")
        feedback_store.record(UID, "errand", "up", "Wash & Go")
        subjects = {v["subject"] for v in feedback_store.verdicts(UID, "errand")}
        self.assertEqual(subjects, {"Laundry Express", "Wash & Go"})

    # ── deletion ─────────────────────────────────────────────────────────────
    def test_deletion_removes_every_key(self):
        self._split_profile()
        feedback_store.record(PHONE, "errand", "down", "Laundry Express")
        caller = {"userId": UID, "phone": PHONE, "key": PHONE}
        result = account_deletion.purge_local_stores(PHONE, *identity_keys.all_keys(caller))
        self.assertEqual(result["user_profile"], "deleted")
        data = user_profile._load()
        for key in (UID, PHONE, self.local):
            self.assertNotIn(key, data)
        self.assertEqual(feedback_store.verdicts(UID), [])


if __name__ == "__main__":
    unittest.main()
