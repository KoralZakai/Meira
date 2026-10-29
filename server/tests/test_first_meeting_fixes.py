"""9.10, Koral, on her phone: "I don't work right now, so fix Palo Alto" left
Palo Alto in place; Meira answered her Hebrew in English ("Got it — יום ראשון,
on אימון בערב…"); and one gym split into two workouts asked "where is it?"
for the one that had no address.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import profile_extract  # noqa: E402


def _model(content: str):
    llm = mock.MagicMock()
    llm.chat.completions.create = mock.AsyncMock(return_value=mock.MagicMock(
        usage=None, choices=[mock.MagicMock(message=mock.MagicMock(content=content))]))
    return llm


KNOWN = {"name": "קורל", "wakeTime": "08:00", "totalMorningMinutesEstimate": 20, "morningConfirmed": True,
         "workAddress": "Palo Alto Networks", "workTransport": "bus",
         "homeAddress": "מרדכי הגטאות 21, תל אביב", "hasCar": False, "sleepTime": "23:00"}


class SheNoLongerWorksThere(unittest.TestCase):
    def test_her_words_close_work_even_when_the_model_missed_them(self):
        with mock.patch.object(profile_extract, "_get_client", return_value=_model('{"workAddress": null}')), \
             mock.patch.object(profile_extract.user_profile, "update_profile") as save, \
             mock.patch("known_places.forget") as forget:
            out = asyncio.run(profile_extract.extract(
                "ואני לא עובדת כרגע, אז תקני את פלו אלטו", KNOWN, phone="972500000000", lang="en"))
        self.assertEqual(out["workAddress"], "none")
        self.assertNotIn("workTransport", out)
        self.assertNotIn("workAddress", out["missingFields"])
        save.assert_any_call("972500000000", workAddress="")
        forget.assert_called_once_with("972500000000", "עבודה")
        self.assertIn("את לא עובדת במקום קבוע", out["followUpQuestion"])

    def test_working_is_not_read_as_not_working(self):
        for said in ("אני עובדת בעזריאלי", "I work at Azrieli", "עבדתי פעם בפלו אלטו"):
            self.assertFalse(profile_extract.says_no_work(said), said)
        for said in ("אני לא עובדת כרגע", "I don't work", "אני מובטלת", "I'm between jobs"):
            self.assertTrue(profile_extract.says_no_work(said), said)


class SheIsAnsweredInHerLanguage(unittest.TestCase):
    def test_hebrew_answer_on_an_english_phone_gets_hebrew(self):
        reply = ('{"routines":[{"what":"אימון","place":"יגאל אלון 94","days":"ראשון","time":"20:00",'
                 '"transport":"bike"}]}')
        with mock.patch.object(profile_extract, "_get_client", return_value=_model(reply)):
            out = asyncio.run(profile_extract.extract("אני מתאמנת ביום ראשון בשמונה", {**KNOWN, "routines": []},
                                                      lang="en"))
        self.assertTrue(out["followUpQuestion"].startswith("הבנתי — "), out["followUpQuestion"])
        self.assertNotIn("Got it", out["followUpQuestion"])


class OneGymManySessions(unittest.TestCase):
    def test_the_place_she_gave_once_covers_every_workout(self):
        m = profile_extract.merge({**KNOWN, "routines": []}, {"routines": [
            {"what": "אימון בערב", "days": "ראשון, שני, שלישי", "time": "20:00", "transport": "bike"},
            {"what": "אימון בוקר", "days": "שישי", "time": "11:00", "place": "יגאל אלון 94, תל אביב"},
        ]})
        self.assertEqual([r["place"] for r in m["routines"]], ["יגאל אלון 94, תל אביב"] * 2)
        self.assertEqual([r["transport"] for r in m["routines"]], ["bike"] * 2)
        self.assertFalse([f for f in profile_extract.missing_fields(m) if f.startswith("routine:")])

    def test_a_class_does_not_borrow_the_gym(self):
        m = profile_extract.merge({**KNOWN, "routines": []}, {"routines": [
            {"what": "אימון", "place": "יגאל אלון 94"}, {"what": "חוג ציור"}]})
        self.assertIsNone(m["routines"][1].get("place"))


if __name__ == "__main__":
    unittest.main()


class TheAnswerGoesToTheQuestion(unittest.TestCase):
    """11.10: "work out — where is it?" → "Yigal Alon 96" was saved as her home."""
    KNOWN = {**KNOWN, "workAddress": "none", "homeAddress": "מרדכי הגטאות 21, תל אביב",
             "routines": [{"what": "work out", "days": "ראשון, שני, שלישי", "time": "20:00"}]}

    def _run(self, reply: str, said: str):
        with mock.patch.object(profile_extract, "_get_client", return_value=_model(reply)):
            return asyncio.run(profile_extract.extract(said, dict(self.KNOWN), lang="he"))

    def test_a_place_filed_as_home_goes_to_the_routine(self):
        out = self._run('{"homeAddress": "Igal Alon Street 96, Tel Aviv"}', "אני מתאמנת ביגאל אלון 96")
        self.assertEqual(out["homeAddress"], "מרדכי הגטאות 21, תל אביב")
        self.assertEqual(out["routines"][0]["place"], "Igal Alon Street 96, Tel Aviv")
        self.assertEqual(out["missingFields"][0], "routine:0:transport")

    def test_a_home_changes_only_when_she_says_she_lives_there(self):
        k = {**self.KNOWN, "routines": "none"}
        with mock.patch.object(profile_extract, "_get_client",
                               return_value=_model('{"homeAddress": "יגאל אלון 96, תל אביב"}')):
            kept = asyncio.run(profile_extract.extract("יגאל אלון 96", dict(k), lang="he"))
            moved = asyncio.run(profile_extract.extract("עברתי דירה, אני גרה ביגאל אלון 96", dict(k), lang="he"))
        self.assertEqual(kept["homeAddress"], "מרדכי הגטאות 21, תל אביב")
        self.assertEqual(moved["homeAddress"], "יגאל אלון 96, תל אביב")

    def test_asked_for_home_she_can_give_any_address(self):
        k = {**self.KNOWN, "routines": "none", "homeAddress": None}
        with mock.patch.object(profile_extract, "_get_client",
                               return_value=_model('{"homeAddress": "מרדכי הגטאות 21, תל אביב"}')):
            out = asyncio.run(profile_extract.extract("מרדכי הגטאות 21", k, lang="he"))
        self.assertEqual(out["homeAddress"], "מרדכי הגטאות 21, תל אביב")


class AHomeKeepsItsTown(unittest.TestCase):
    """13.10: "מורדי הגטאות 23" — no town — geocoded to Be'er Sheva."""

    def test_a_home_resaid_without_a_town_keeps_the_town(self):
        k = {**KNOWN, "routines": "none", "workAddress": "none",
             "homeAddress": "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo"}
        k.pop("homeAddress")
        k_full = {**k, "homeAddress": None}
        with mock.patch.object(profile_extract, "_get_client",
                               return_value=_model('{"homeAddress": "מורדי הגטאות 23"}')):
            out = asyncio.run(profile_extract.extract("אני גרה במורדי הגטאות 23",
                                                      {**k_full, "homeAddress": "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo"},
                                                      lang="he"))
        self.assertEqual(out["homeAddress"], "מורדי הגטאות 23, Tel Aviv-Yafo")
