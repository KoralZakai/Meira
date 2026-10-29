import unittest

import routine_text as rt


class SpokenHoursTests(unittest.TestCase):
    def test_her_sentence_becomes_two_clear_routines(self):
        said = "יש לי יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי"
        self.assertEqual(rt.canonical_lines(said),
                         ["יוגה · יום שלישי · 20:00-21:30", "יוגה · יום שישי · 11:00-12:30"])

    def test_hours_as_people_say_them(self):
        self.assertEqual(rt.read_hours("ב 8 בערב"), {"time": "20:00"})
        self.assertEqual(rt.read_hours("ב 8 וחצי בערב")["time"], "20:30")
        self.assertEqual(rt.read_hours("11 עד 12 וחצי בבוקר"), {"time": "11:00", "end": "12:30", "minutes": 90})
        self.assertEqual(rt.read_hours("ב-7 בבוקר")["time"], "07:00")
        self.assertEqual(rt.read_hours("at 6pm for an hour"), {"time": "18:00", "end": "19:00", "minutes": 60})
        self.assertEqual(rt.read_hours("יום חמישי"), {})                 # no hour said: no hour invented
        self.assertEqual(rt.read_hours("ב21.10"), {})                    # a date is not an hour

    def test_two_days_that_share_hours(self):
        self.assertEqual(rt.canonical_lines("יוגה בשלישי ובחמישי ב-7 בבוקר"), ["יוגה · ימי שלישי וחמישי · 07:00"])

    def test_nothing_to_read(self):
        self.assertEqual(rt.canonical_lines("אני אוהבת ללכת לים"), [])


class WiredInTests(unittest.TestCase):
    def test_routine_match_now_reads_a_spoken_hour(self):
        import routine_match
        self.assertEqual(routine_match._when("יוגה ב 8 בערב").get("time"), "20:00")

    def test_saving_a_sentence_writes_clear_lines(self):
        import user_profile
        out = user_profile.merge_routine_lines("", "יש לי יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי")
        self.assertIn("יוגה · יום שלישי · 20:00-21:30", out)
        self.assertIn("יוגה · יום שישי · 11:00-12:30", out)
        # a line that already has a clock, or no hour at all, is left exactly as she wrote it
        self.assertEqual(user_profile.expand_spoken("קיקבוקס · יום ראשון · 20:30"), "קיקבוקס · יום ראשון · 20:30")
        self.assertEqual(user_profile.expand_spoken("יוגה בשלישי"), "יוגה בשלישי")

    def test_the_extraction_uses_her_words_over_the_models_reading(self):
        import profile_extract
        extracted = {"routines": [{"what": "יוגה", "place": "יגאל אלון 76", "days": "ראשון עד שלישי",
                                    "time": "08:00-09:30", "transport": "bike"}]}
        profile_extract._routines_from_her_words(
            extracted, "יש לי יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי")
        times = sorted(r["time"] for r in extracted["routines"])
        self.assertEqual(times, ["11:00-12:30", "20:00-21:30"])
        self.assertTrue(all(r["place"] == "יגאל אלון 76" for r in extracted["routines"]))   # the gym is kept
