"""Lumi should remember how you get to a place instead of asking every time.

The gap, from a real message:

    "ב 11:00 יוגה ביגאל אלון 94"
        -> no travel mode in the text, so Lumi ASKS
        -> no route, no leave time, no wake alarm until she answers

Asking the first time is right. Asking the fifth time is forgetting.
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import travel_prefs as tp


class PlaceKeyTests(unittest.TestCase):
    def test_the_typed_and_the_geocoded_form_are_one_place(self):
        # What she types vs what Google returns must not be two keys, or she
        # teaches the same preference twice and it never reaches a majority.
        self.assertEqual(tp.place_key("יגאל אלון 94"),
                         tp.place_key("יגאל אלון 94, תל אביב-יפו, מחוז תל אביב"))

    def test_house_number_first_keeps_the_street(self):
        # Real row from her data. A bare "33" would collide with every other
        # number 33 in the city.
        self.assertEqual(tp.place_key("33, Florentin Street, Tel Aviv-Yafo"),
                         "33 florentin street")
        self.assertEqual(tp.place_key("5, הילטון צפון, תל אביב-יפו"), "5 הילטון צפון")

    def test_case_and_padding_do_not_split_a_place(self):
        self.assertEqual(tp.place_key("  Yigal Alon 94, Tel Aviv  "),
                         tp.place_key("yigal alon 94"))

    def test_two_gyms_on_one_street_stay_distinct(self):
        self.assertNotEqual(tp.place_key("יגאל אלון 94"), tp.place_key("יגאל אלון 12"))

    def test_empty_is_safe(self):
        self.assertEqual(tp.place_key(""), "")
        self.assertEqual(tp.place_key(None), "")


class PreferenceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._patch = patch.object(tp, "_PATH", os.path.join(self._tmp.name, "travel_prefs.json"))
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def test_nothing_learned_means_still_ask(self):
        self.assertIsNone(tp.preferred("972500000009", "יגאל אלון 94", "gym"))

    def test_one_confirmation_is_enough_to_act_on(self):
        # Because the reply always states the assumption, a wrong memory costs
        # one correction — cheaper than a missing alarm.
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        self.assertEqual(tp.preferred("972500000009", "יגאל אלון 94", "gym"), "bike")

    def test_the_place_is_found_from_the_geocoded_address_too(self):
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        self.assertEqual(
            tp.preferred("972500000009", "יגאל אלון 94, תל אביב-יפו, מחוז תל אביב", "gym"),
            "bike")

    def test_category_carries_to_a_gym_she_has_never_been_to(self):
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        self.assertEqual(tp.preferred("972500000009", "רחוב אחר 5", "gym"), "bike")

    def test_the_place_beats_the_category(self):
        # She cycles to the gym generally, but drives to this one.
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        tp.remember("972500000009", "car", "הרצליה 20", "gym")
        self.assertEqual(tp.preferred("972500000009", "הרצליה 20", "gym"), "car")
        self.assertEqual(tp.preferred("972500000009", "יגאל אלון 94", "gym"), "bike")

    def test_a_correction_outvotes_the_old_habit(self):
        tp.remember("972500000009", "bus", "יגאל אלון 94", "gym")
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        self.assertEqual(tp.preferred("972500000009", "יגאל אלון 94", "gym"), "bike")

    def test_local_and_international_phone_are_the_same_person(self):
        # Same bug shape as the pending-mirror flush.
        tp.remember("0500000009", "bike", "יגאל אלון 94", "gym")
        self.assertEqual(tp.preferred("972500000009", "יגאל אלון 94", "gym"), "bike")

    def test_another_persons_habits_never_leak(self):
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        self.assertIsNone(tp.preferred("972501234567", "יגאל אלון 94", "gym"))

    def test_junk_modes_are_refused(self):
        tp.remember("972500000009", "teleport", "יגאל אלון 94", "gym")
        self.assertIsNone(tp.preferred("972500000009", "יגאל אלון 94", "gym"))

    def test_work_by_car_and_gym_by_bike_coexist(self):
        # Her original ask, stated exactly.
        tp.remember("972500000009", "car", "רוטשילד 1", "work")
        tp.remember("972500000009", "bike", "יגאל אלון 94", "gym")
        self.assertEqual(tp.preferred("972500000009", None, "work"), "car")
        self.assertEqual(tp.preferred("972500000009", None, "gym"), "bike")

    def test_the_assumption_is_always_stated(self):
        for mode in tp.VALID_MODES:
            self.assertTrue(tp.assumption_line(mode, "he").strip())
            self.assertTrue(tp.assumption_line(mode, "en").strip())
        self.assertIn("אופניים", tp.assumption_line("bike", "he"))
        self.assertIn("bike", tp.assumption_line("bike", "en"))

    def test_a_corrupt_store_does_not_crash_the_route(self):
        with open(tp._PATH, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        self.assertIsNone(tp.preferred("972500000009", "יגאל אלון 94", "gym"))


if __name__ == "__main__":
    unittest.main()
