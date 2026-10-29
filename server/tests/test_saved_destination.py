"""'When do I leave for the dentist?' — a saved appointment's place IS the destination.

29.9, asked through Meira: "מתי אני צריכה לצאת מחר מהבית לרופא שיניים ב-09:30?"
Meira answered "what's the clinic's name or address?" — the saved task, "Dentist
— Dr. Levi" at 09:30, had Ibn Gabirol 120 on it the whole time. plan_departure
now resolves a destination that names a saved appointment (by its hour, or a
word of its title) to that appointment's address before geocoding anything.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lumi_agent  # noqa: E402
import user_profile  # noqa: E402

PHONE = "0500000789"
HOME = "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo"
DAY = "2099-01-01"
DENTIST = "Ibn Gabirol St 120, Tel Aviv-Yafo"


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class SavedDestination(unittest.TestCase):
    def setUp(self):
        user_profile.update_profile(PHONE, homeAddress=HOME, transportType="bike")
        self.calls = []

        async def _plan(**kw):
            self.calls.append(kw)
            return {"ok": True, "plan": {"leaveHomeBy": "09:02", "travelMinutes": 18}}

        rows = [{"id": "gcal-x", "text": "Dentist — Dr. Levi", "fixed_time": "09:30", "date": DAY,
                 "status": "pending", "category": "doctor", "location": {"address": DENTIST}},
                {"id": "t2", "text": "לעשות תכנית עסקית", "fixed_time": "18:30", "date": DAY,
                 "status": "pending", "category": "general"}]

        async def _rows(phone, d1, d2, **kw):
            return rows

        self.patches = [mock.patch.object(lumi_agent.geo, "plan_departure", _plan),
                        mock.patch.object(lumi_agent.task_store, "fetch_task_rows", _rows)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def _plan(self, destination, arrival):
        tool = next(t for t in lumi_agent._make_tools(PHONE, "") if t.name == "plan_departure")
        return run(tool.ainvoke({"destination": destination, "arrival_time": arrival, "task_date": DAY}))

    def test_her_words_in_hebrew_and_the_hour_find_the_saved_address(self):
        res = self._plan("רופא שיניים", "09:30")
        self.assertTrue(res.get("plan"), res)
        self.assertEqual(self.calls[0]["destination"], DENTIST)

    def test_a_word_of_the_title_is_enough(self):
        self._plan("the dentist", "10:00")
        self.assertEqual(self.calls[0]["destination"], DENTIST)

    def test_an_address_is_left_alone(self):
        self._plan("Herzl 10, Tel Aviv", "09:30")
        self.assertEqual(self.calls[0]["destination"], "Herzl 10, Tel Aviv")

    def test_no_matching_appointment_keeps_her_words(self):
        self._plan("הספרייה", "17:00")
        self.assertEqual(self.calls[0]["destination"], "הספרייה")


if __name__ == "__main__":
    unittest.main()
