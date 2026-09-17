"""Numbered-choice ownership — a bare "3" belongs to whoever asked last.

Lumi asks several numbered questions: "pick a bus (1-3)" and "reply with a
number" for the HR job shortlist. A bare number is meaningless alone, so the
asker is recorded when the question is SENT and read back when the reply lands.

The bug this locks down: ownership used to be inferred by string-matching the
English prose "Pick a bus" in the outgoing message (main.py). In Hebrew the
message reads "בחרי אוטובוס", the substring is absent, the flag never set — so
typing "3" to pick a bus tailored a CV for job #3 instead. Prose is translated;
branching on it is the defect. The count now comes from the route data itself.
"""
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp()
os.environ["DATA_DIR"] = _TMP

import config  # noqa: E402
config.DATA_DIR = _TMP

import session  # noqa: E402
session._PATH = os.path.join(_TMP, "active_session.json")

import geo  # noqa: E402

PHONE = "972500000000"


def _leg(vehicle: str, line: str, dep: str, arr: str) -> dict:
    return {"vehicle": vehicle, "line": line, "departure": dep, "arrival": arr,
            "steps": [{"travel_mode": "TRANSIT", "vehicle": vehicle, "line": line}]}


def _plan(n: int) -> dict:
    return {
        "startResolved": "הרצל 1, תל אביב", "destResolved": "מגדלי אמזון",
        "destination": "מגדלי אמזון", "arriveBy": "10:00",
        "routineMinutes": 45, "fromHome": True,
        "alternatives": [_leg("BUS", str(200 + i), "08:%02d" % i, "09:%02d" % i)
                         for i in range(n)],
    }


class PendingChoiceTests(unittest.TestCase):
    def setUp(self):
        session.clear_pending_choice(PHONE)

    def test_no_question_means_no_owner(self):
        """An unsolicited number isn't hijacked by anyone."""
        self.assertIsNone(session.choice_owner(PHONE, 3))

    def test_route_owns_the_number_it_asked_for(self):
        """The reported bug: '3' after 3 route options is a ride, not a job."""
        session.set_pending_choice(PHONE, "route", 3)
        self.assertEqual(session.choice_owner(PHONE, 3), "route")
        self.assertEqual(session.choice_owner(PHONE, 1), "route")

    def test_out_of_range_number_is_not_consumed(self):
        """'7' when only 1-3 were offered isn't a route pick."""
        session.set_pending_choice(PHONE, "route", 3)
        self.assertIsNone(session.choice_owner(PHONE, 7))

    def test_most_recent_asker_wins(self):
        """HR asking after the route picker takes ownership of the number."""
        session.set_pending_choice(PHONE, "route", 3)
        session.set_pending_choice(PHONE, "hr", 5)
        self.assertEqual(session.choice_owner(PHONE, 3), "hr")

    def test_consuming_releases_ownership(self):
        """After the pick is handled, a later stray number is free again."""
        session.set_pending_choice(PHONE, "route", 3)
        session.clear_pending_choice(PHONE)
        self.assertIsNone(session.choice_owner(PHONE, 3))

    def test_stale_question_expires(self):
        """A question from an hour ago must not hijack an unrelated message."""
        session.set_pending_choice(PHONE, "route", 3)
        raw = session._load()
        raw[session._digits(PHONE)]["pending_choice"]["at"] -= session._PICK_TTL_SECONDS + 60
        session._save(raw)
        self.assertIsNone(session.choice_owner(PHONE, 3))

    def test_option_count_is_language_independent(self):
        """THE regression guard: the count must not depend on the prose.

        Hebrew output does not contain 'Pick a bus' — that is precisely why the
        old string-matching flag never fired for Hebrew users.
        """
        counts = {}
        for lang in ("he", "en"):
            counter: list = []
            text = geo.format_route_message(_plan(4), pref="bus", lang=lang, counter=counter)
            counts[lang] = counter[0] if counter else 0
            if lang == "he":
                self.assertNotIn("Pick a bus", text, "Hebrew must not carry the English marker")
        self.assertEqual(counts["he"], counts["en"])
        self.assertEqual(counts["he"], 3, "options are capped at 3")


if __name__ == "__main__":
    unittest.main()
