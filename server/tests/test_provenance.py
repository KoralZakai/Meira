"""Every task must record which conversation created it.

The gap: a task Koral created over WhatsApp was stored with source='voice',
because the app's addTasksForDate stamped everything it wrote 'voice'
regardless of origin and the server recorded no channel at all. With both
stores labelling by code path rather than origin, "where did this come from?"
had no answer — which is also why a WhatsApp task silently missing its route
took a conversation-log dig to explain.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

import provenance as pv


class SessionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._p = patch.object(pv, "_PATH", os.path.join(self._tmp.name, "sessions.json"))
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self._tmp.cleanup()

    PHONE = "972500000009"

    def test_messages_close_together_are_one_session(self):
        a = pv.stamp(self.PHONE, "whatsapp", "יוגה ב-11", now=1000.0)
        b = pv.stamp(self.PHONE, "whatsapp", "ומחר שיחה", now=1060.0)
        self.assertEqual(a["sessionId"], b["sessionId"])

    def test_each_message_is_its_own_turn(self):
        # Tasks from ONE message share a turn id; that is the unit of "undo
        # what this message did".
        a = pv.stamp(self.PHONE, "whatsapp", "x", now=1000.0)
        b = pv.stamp(self.PHONE, "whatsapp", "y", now=1060.0)
        self.assertNotEqual(a["turnId"], b["turnId"])

    def test_the_next_morning_is_a_new_session(self):
        a = pv.stamp(self.PHONE, "whatsapp", "x", now=1000.0)
        b = pv.stamp(self.PHONE, "whatsapp", "y", now=1000.0 + pv.SESSION_IDLE_SECONDS + 1)
        self.assertNotEqual(a["sessionId"], b["sessionId"])

    def test_the_same_person_written_two_ways_is_one_session(self):
        a = pv.stamp("0500000009", "whatsapp", "x", now=1000.0)
        b = pv.stamp("972500000009", "whatsapp", "y", now=1060.0)
        self.assertEqual(a["sessionId"], b["sessionId"])

    def test_channels_do_not_share_a_session(self):
        a = pv.stamp(self.PHONE, "whatsapp", "x", now=1000.0)
        b = pv.stamp(self.PHONE, "app_chat", "x", now=1000.0)
        self.assertNotEqual(a["sessionId"], b["sessionId"])

    def test_two_people_never_share_a_session(self):
        a = pv.stamp(self.PHONE, "whatsapp", "x", now=1000.0)
        b = pv.stamp("972501234567", "whatsapp", "x", now=1000.0)
        self.assertNotEqual(a["sessionId"], b["sessionId"])

    def test_an_unknown_channel_is_recorded_as_unknown_not_invented(self):
        self.assertEqual(pv.stamp(self.PHONE, "carrier-pigeon")["channel"], "unknown")

    def test_the_sentence_that_caused_it_is_kept_but_bounded(self):
        st = pv.stamp(self.PHONE, "whatsapp", "יוגה ביגאל אלון 94 ב-11:00")
        self.assertIn("יוגה", st["inputText"])
        long = pv.stamp(self.PHONE, "whatsapp", "x" * 500)
        self.assertLessEqual(len(long["inputText"]), 160)
        self.assertIsNone(pv.stamp(self.PHONE, "whatsapp", "")["inputText"])

    def test_a_missing_phone_still_yields_a_usable_stamp(self):
        st = pv.stamp("", "whatsapp", "x")
        self.assertTrue(st["sessionId"])
        self.assertTrue(st["turnId"])

    def test_a_corrupt_store_does_not_break_a_turn(self):
        with open(pv._PATH, "w", encoding="utf-8") as f:
            f.write("{ not json")
        self.assertTrue(pv.stamp(self.PHONE, "whatsapp", "x")["sessionId"])


class SourceMappingTests(unittest.TestCase):
    def test_whatsapp_is_never_recorded_as_voice_again(self):
        # The exact bug.
        self.assertEqual(pv.to_source("whatsapp"), "whatsapp")

    def test_each_app_entry_point_keeps_its_own_identity(self):
        self.assertEqual(pv.to_source("app_voice"), "voice")
        self.assertEqual(pv.to_source("app_chat"), "chat")
        self.assertEqual(pv.to_source("app_manual"), "manual")

    def test_every_channel_maps_to_something(self):
        for ch in pv.CHANNELS:
            self.assertTrue(pv.to_source(ch))


if __name__ == "__main__":
    unittest.main()


class SupabaseSourceTests(unittest.TestCase):
    """The `source` column must follow the envelope, not the code path."""

    def test_a_stamped_whatsapp_task_is_labelled_whatsapp(self):
        import supabase_tasks
        self.assertEqual(
            supabase_tasks._source_of({"provenance": {"channel": "whatsapp"}}), "whatsapp")

    def test_a_stamped_app_chat_task_keeps_its_own_label(self):
        import supabase_tasks
        self.assertEqual(
            supabase_tasks._source_of({"provenance": {"channel": "app_chat"}}), "chat")

    def test_an_unstamped_task_falls_back_rather_than_guessing_wrong(self):
        # Paths not yet moved onto provenance still reach Supabase via the
        # WhatsApp mirror, so the fallback must stay 'whatsapp'.
        import supabase_tasks
        self.assertEqual(supabase_tasks._source_of({}), "whatsapp")
        self.assertEqual(supabase_tasks._source_of({"provenance": None}), "whatsapp")
        self.assertEqual(supabase_tasks._source_of({"provenance": "nonsense"}), "whatsapp")
