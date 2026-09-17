"""Regression + parity tests for the personality system. stdlib unittest only,
no DB required — run with: python -m unittest server/test_personality_parity.py

Locks in two things that have silently drifted before:
1. The Python scoring math must keep producing the same output for the same
   input (regression) — guards personality_learning_service.compute_personality.
2. mbti.py / personality_learning_service.py are hand-maintained mirrors of
   src/constants/mbti.ts / src/services/PersonalityLearningService.ts. These
   tests hardcode the TS side's values so an edit to only one side fails CI.
"""
import json
import os
import unittest
from datetime import datetime, timedelta, timezone

from mbti import MBTI_COMMUNICATION
from personality_learning_service import compute_personality, SIGNAL_MAP, DICHOTOMY_LETTERS, ORDER
from personality_handoff import _is_valid

_FIXTURE = os.path.join(os.path.dirname(__file__), "personality_parity_fixture.json")

# Mirrors SIGNAL_TO_DICHOTOMY in src/services/PersonalityLearningService.ts.
TS_SIGNAL_TO_DICHOTOMY = {
    "suggestion_accepted": ("E/I", 1),
    "suggestion_rejected": ("E/I", -1),
    "detail_requested": ("S/N", 1),
    "big_picture_preferred": ("S/N", -1),
    "logic_motivated": ("T/F", 1),
    "emotion_motivated": ("T/F", -1),
    "fixed_task_completed": ("J/P", 1),
    "flexible_task_completed": ("J/P", -1),
}

# Mirrors the 16 keys of MBTI_PROFILES / MBTI_COMMUNICATION in src/constants/mbti.ts.
TS_MBTI_TYPES = {
    "INTJ", "INTP", "ENTJ", "ENTP", "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ISTP", "ISFP", "ESTJ", "ESFJ", "ESTP", "ESFP",
}


class ScoringParity(unittest.TestCase):
    def test_signal_map_matches_ts(self):
        self.assertEqual(SIGNAL_MAP, TS_SIGNAL_TO_DICHOTOMY)

    def test_dichotomy_letters_and_order_match_ts(self):
        self.assertEqual(ORDER, ["E/I", "S/N", "T/F", "J/P"])
        self.assertEqual(DICHOTOMY_LETTERS, {
            "E/I": ("E", "I"), "S/N": ("S", "N"), "T/F": ("T", "F"), "J/P": ("J", "P"),
        })

    def test_mbti_communication_covers_all_16_types(self):
        self.assertEqual(set(MBTI_COMMUNICATION.keys()), TS_MBTI_TYPES)


class ScoringRegression(unittest.TestCase):
    def test_no_signals_falls_back_to_quick_assessment(self):
        result = compute_personality("u1", "ESFP", 0.4, [])
        self.assertEqual(result, {
            "userId": "u1", "quickAssessmentType": "ESFP", "quickAssessmentConfidence": 0.4,
            "behavioralType": None, "behavioralConfidence": 0.0,
            "finalType": "ESFP", "finalConfidence": 0.4, "signalCount": 0,
        })

    def test_full_signal_coverage_overrides_quick_assessment(self):
        signals = [
            ("suggestion_rejected", 0.5),     # E/I -> I
            ("detail_requested", 0.6),        # S/N -> S
            ("logic_motivated", 0.7),         # T/F -> T
            ("flexible_task_completed", 0.8), # J/P -> P
        ]
        result = compute_personality("u1", "ESFP", 0.4, signals)
        self.assertEqual(result["behavioralType"], "ISTP")
        self.assertEqual(result["finalType"], "ISTP")
        self.assertEqual(result["behavioralConfidence"], 0.4)
        self.assertEqual(result["finalConfidence"], 0.4)
        self.assertEqual(result["signalCount"], 4)

    def test_no_assessment_and_no_signals_is_unknown(self):
        result = compute_personality("u1", None, 0.0, [])
        self.assertIsNone(result["behavioralType"])
        self.assertIsNone(result["finalType"])
        self.assertEqual(result["finalConfidence"], 0.0)

    def test_unknown_signal_type_is_ignored(self):
        result = compute_personality("u1", "ESFP", 0.4, [("not_a_real_signal", 1.0)])
        self.assertEqual(result["signalCount"], 1)  # counted, but...
        self.assertEqual(result["finalType"], "ESFP")  # ...doesn't move any dichotomy


class FixtureParity(unittest.TestCase):
    """The shared fixture is the source of truth both Python and the TS test assert
    against. If compute_personality drifts from it, this fails; the TS test guards
    the JS side against the same fixture."""
    def test_compute_matches_fixture(self):
        with open(_FIXTURE, encoding="utf-8") as f:
            cases = json.load(f)
        self.assertTrue(cases, "fixture must not be empty")
        for i, case in enumerate(cases):
            sigs = [(s["signalType"], s["confidence"]) for s in case["signals"]]
            r = compute_personality("u", case["quickType"], case["quickConf"], sigs)
            exp = case["expected"]
            self.assertEqual(r["finalType"], exp["finalType"], f"case {i} finalType")
            self.assertEqual(r["behavioralType"], exp["behavioralType"], f"case {i} behavioralType")
            self.assertEqual(r["signalCount"], exp["signalCount"], f"case {i} signalCount")
            self.assertAlmostEqual(r["behavioralConfidence"], exp["behavioralConfidence"], places=6)
            self.assertAlmostEqual(r["finalConfidence"], exp["finalConfidence"], places=6)


class HandoffTokenValidity(unittest.TestCase):
    def test_fresh_token_is_valid(self):
        future = datetime.now(timezone.utc) + timedelta(minutes=5)
        self.assertTrue(_is_valid(future, used=False))

    def test_expired_token_is_invalid(self):
        past = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.assertFalse(_is_valid(past, used=False))

    def test_consumed_token_is_invalid_even_if_not_expired(self):
        future = datetime.now(timezone.utc) + timedelta(minutes=5)
        self.assertFalse(_is_valid(future, used=True))


if __name__ == "__main__":
    unittest.main()
