"""Eval 20.10: "what do I have today?" got a Hebrew answer — the turn's Hebrew
time stamp made every message read as Hebrew."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lumi_agent  # noqa: E402


class ReplyLanguage(unittest.TestCase):
    def test_the_stamp_is_not_her_language(self):
        self.assertEqual(lumi_agent._detect_language("[נשלח עכשיו ב-02:10] what do I have today?", "he"), "en")

    def test_hebrew_is_hebrew(self):
        self.assertEqual(lumi_agent._detect_language("[נשלח עכשיו ב-02:10] מה יש לי היום?", "en"), "he")

    def test_no_letters_keeps_her_preference(self):
        self.assertEqual(lumi_agent._detect_language("[נשלח עכשיו ב-02:10] 👍", "he"), "he")


if __name__ == "__main__":
    unittest.main()
