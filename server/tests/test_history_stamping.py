"""Anti-parrot history stamping (behaviour A) — lumi_agent.

Pins yesterday's uncommitted fixes: the internal [DD/MM HH:MM] marker is
context, never Lumi's voice; user turns are stamped from their real `ts`;
assistant turns are stripped of clock/route/confirmation noise and NOT
stamped; the `ts` key never leaks to the model.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

from lumi_agent import (  # noqa: E402
    _STAMP_RE, _HISTORY_NOISE_RE, _stamp, _sanitize_history)


class StampRegexTests(unittest.TestCase):
    def test_doubled_stamp_collapses_to_text(self):
        s = "[02/08 22:47] [02/08 22:47] text"
        self.assertEqual(_STAMP_RE.sub("", s).strip(), "text")

    def test_single_stamp_stripped(self):
        self.assertEqual(_STAMP_RE.sub("", "[26/07 13:00] hi").strip(), "hi")

    def test_final_reply_echo_marker_stripped(self):
        # Same regex used on the outgoing reply (lumi_agent line ~1278).
        out = _STAMP_RE.sub("", "[02/08 22:47] *מחר בבוקר*").strip()
        self.assertEqual(out, "*מחר בבוקר*")


class StampTests(unittest.TestCase):
    def test_stamps_with_valid_iso_ts(self):
        turn = {"ts": "2026-07-26T13:00:00"}
        self.assertEqual(_stamp(turn, "hello"), "[26/07 13:00] hello")

    def test_no_ts_returns_bare_text(self):
        self.assertEqual(_stamp({}, "hello"), "hello")

    def test_short_ts_returns_bare_text(self):
        # len < 16 => treated as absent.
        self.assertEqual(_stamp({"ts": "2026-07-26"}, "hello"), "hello")

    def test_never_doubles_existing_stamp(self):
        turn = {"ts": "2026-07-26T13:00:00"}
        self.assertEqual(_stamp(turn, "[26/07 13:00] hello"), "[26/07 13:00] hello")


class SanitizeHistoryTests(unittest.TestCase):
    def test_user_turn_stamped_from_ts(self):
        out = _sanitize_history(
            [{"role": "user", "content": "בדקי אותי ב 13:00", "ts": "2026-07-26T13:00"}])
        self.assertTrue(out[0]["content"].startswith("[26/07 13:00] "))

    def test_ts_key_never_leaks(self):
        out = _sanitize_history(
            [{"role": "user", "content": "x", "ts": "2026-07-26T13:00"},
             {"role": "assistant", "content": "y", "ts": "2026-07-26T13:00"}])
        for turn in out:
            self.assertEqual(set(turn.keys()), {"role", "content"})

    def test_assistant_turn_not_stamped(self):
        out = _sanitize_history(
            [{"role": "assistant", "content": "sure thing", "ts": "2026-07-26T13:00"}])
        self.assertEqual(out[0]["content"], "sure thing")

    def test_assistant_noise_lines_stripped(self):
        content = "בסדר!\n🕘 09:00 תזכורת\n🕐 13:00 בדיקה"
        out = _sanitize_history(
            [{"role": "assistant", "content": content, "ts": "2026-07-26T13:00"}])
        self.assertEqual(out[0]["content"], "בסדר!")

    def test_assistant_all_noise_dropped_entirely(self):
        out = _sanitize_history(
            [{"role": "assistant", "content": "🕘 09:00", "ts": "2026-07-26T13:00"}])
        self.assertEqual(out, [])


class HistoryNoiseRegexTests(unittest.TestCase):
    def test_matches_stale_dated_header(self):
        self.assertTrue(_HISTORY_NOISE_RE.search("*מחר, יום שישי 1.8*"))

    def test_matches_clock_emoji_reminder_line(self):
        self.assertTrue(_HISTORY_NOISE_RE.search("🕘 09:00 תזכורת"))

    def test_does_not_match_plain_tomorrow_time(self):
        # "מחר ב-11:00" has no D.M date -> must survive.
        self.assertIsNone(_HISTORY_NOISE_RE.search("מחר ב-11:00"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
