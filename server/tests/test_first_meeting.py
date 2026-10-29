"""The first meeting (8.10, Koral): Meira speaks in a natural voice, asks about
the morning, wake time, transport, car, home, gym — saves what was said — and
keeps asking, one thing at a time, until every detail is covered.
"""
import asyncio
import base64
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import profile_extract  # noqa: E402
import tts  # noqa: E402

FULL = {"name": "קורל", "wakeTime": "07:00", "totalMorningMinutesEstimate": 40,
        "morningConfirmed": True, "routines": "none", "workAddress": "none",
        "homeAddress": "מרדכי הגטאות, תל אביב", "hasCar": False, "sleepTime": "23:30"}


class KeepsAskingUntilCovered(unittest.TestCase):
    def test_everything_said_means_done(self):
        self.assertEqual(profile_extract.missing_fields(FULL), [])

    def test_the_morning_is_confirmed_in_minutes(self):
        m = {"name": "קורל", "wakeTime": "07:00",
             "morningHabits": [{"habit": "מקלחת", "estimatedMinutes": 15},
                               {"habit": "קפה", "estimatedMinutes": 10},
                               {"habit": "להתלבש", "estimatedMinutes": 15}]}
        missing = profile_extract.missing_fields(m)
        self.assertEqual(missing[0], "morningConfirmed")
        self.assertEqual(profile_extract.next_question(missing, "he", 0, m),
                         "אז לוקח לך בערך 40 דקות להתארגן?")
        # "No, more like an hour" corrects AND confirms.
        fixed = profile_extract.merge({**m, "totalMorningMinutesEstimate": 40},
                                      {"totalMorningMinutesEstimate": 60})
        self.assertNotIn("morningConfirmed", profile_extract.missing_fields(fixed))

    def test_a_routine_is_asked_about_until_it_is_whole(self):
        m = profile_extract.merge({**FULL, "routines": []},
                                  {"routines": [{"what": "פילאטיס", "place": "סטודיו בדיזנגוף"}]})
        missing = profile_extract.missing_fields(m)
        self.assertEqual(missing, ["routine:0:days", "routine:0:time", "routine:0:transport"])
        self.assertEqual(profile_extract.next_question(missing, "he", 0, m), "ובאילו ימים יש לך פילאטיס?")
        # The days arrive alone; they land on the same routine.
        m2 = profile_extract.merge(m, {"routines": [{"what": "פילאטיס", "days": "ראשון ושלישי"}]})
        self.assertEqual(len(m2["routines"]), 1)
        self.assertEqual(m2["routines"][0]["place"], "סטודיו בדיזנגוף")
        self.assertEqual(profile_extract.missing_fields(m2), ["routine:0:time", "routine:0:transport"])

    def test_a_whole_routine_is_the_line_meira_already_reads(self):
        self.assertEqual(profile_extract.routine_line(
            {"what": "קיקבוקס", "days": "ב׳ וד׳", "time": "20:30-21:30",
             "place": "יגאל אלון 94, תל אביב", "transport": "bike"}),
            "קיקבוקס · ב׳ וד׳ · 20:30-21:30 · יגאל אלון 94, תל אביב · באופניים")

    def test_work_then_how_she_gets_there(self):
        m = profile_extract.merge({**FULL, "workAddress": None}, {"workAddress": "עזריאלי"})
        self.assertEqual(profile_extract.missing_fields(m), ["workTransport"])
        self.assertEqual(profile_extract.next_question(["workTransport"], "he", 0, m),
                         "ואיך את נוסעת לעבודה בדרך כלל?")
        m2 = profile_extract.merge(m, {"workTransport": "bus"})
        self.assertEqual(profile_extract.missing_fields(m2), [])

    def test_no_car_no_routines_no_work_are_answers(self):
        merged = profile_extract.merge({}, {"hasCar": False, "routines": "none", "workAddress": "אין"})
        missing = profile_extract.missing_fields(merged)
        for answered in ("hasCar", "routines", "workAddress", "workTransport"):
            self.assertNotIn(answered, missing)

    def test_driving_everywhere_answers_the_car_question(self):
        self.assertIs(profile_extract.merge({}, {"transportMode": "car"})["hasCar"], True)

    def test_the_answer_is_saved_where_meira_reads_it(self):
        llm = mock.MagicMock()
        llm.chat.completions.create = mock.AsyncMock(return_value=mock.MagicMock(
            usage=None, choices=[mock.MagicMock(message=mock.MagicMock(content=(
                '{"name":"קורל","wakeTime":"7:00","totalMorningMinutesEstimate":40,"morningConfirmed":true,'
                '"routines":[{"what":"קיקבוקס","place":"יגאל אלון 94","days":"ב׳ וד׳","time":"20:30",'
                '"transport":"bike"}],"workAddress":"עזריאלי","workTransport":"bus","hasCar":false}')))]))
        with mock.patch.object(profile_extract, "_get_client", return_value=llm), \
             mock.patch.object(profile_extract.user_profile, "update_profile") as save, \
             mock.patch("known_places.remember") as remember:
            out = asyncio.run(profile_extract.extract("...", {}, phone="972500000000"))
        saved = {}
        for c in save.call_args_list:
            saved.update({k: v for k, v in c.kwargs.items() if v is not None})
        self.assertEqual((saved["hasCar"], saved["defaultWakeTime"]), (False, "07:00"))
        self.assertEqual(saved["routinesNotes"], "קיקבוקס · ב׳ וד׳ · 20:30 · יגאל אלון 94 · באופניים")
        self.assertEqual(saved["workAddress"], "עזריאלי")
        remember.assert_any_call("972500000000", "קיקבוקס", "יגאל אלון 94")
        remember.assert_any_call("972500000000", "עבודה", "עזריאלי")
        self.assertEqual(out["missingFields"], ["homeAddress", "sleepTime"])
        self.assertEqual(out["transportMode"], "transit")
        self.assertFalse(out["isComplete"])


class SheSaysBackWhatSheUnderstood(unittest.TestCase):
    """8.10, Koral: "repeat after me — 'I understood: no car, so you go by public
    transport; you train Sunday to Tuesday in the evening'"."""

    def test_her_recording_said_back(self):
        known = {"name": "קורל"}
        merged = profile_extract.merge(known, {
            "hasCar": False, "transportMode": "transit", "wakeTime": "7:00",
            "routines": [{"what": "אימון", "days": "ראשון עד שלישי", "time": "ערב"}],
            "workAddress": "עזריאלי", "workTransport": "bus"})
        self.assertEqual(profile_extract.echo_line(known, merged, "he"),
                         "הבנתי — את קמה ב-07:00, אין לך אוטו, אז את בתחבורה ציבורית, "
                         "את מתאמנת בימים ראשון עד שלישי בערב, את עובדת בעזריאלי ונוסעת לשם באוטובוס.")

    def test_a_named_workout_keeps_its_name(self):
        m = profile_extract.merge({}, {"routines": [{"what": "קיקבוקס", "days": "ב׳ וד׳", "time": "20:30"}]})
        self.assertEqual(profile_extract.echo_line({}, m, "he"), "הבנתי — את מתאמנת בקיקבוקס בימים ב׳ וד׳ ב-20:30.")

    def test_only_what_is_new_is_repeated(self):
        known = profile_extract.merge({}, {"routines": [{"what": "קיקבוקס", "days": "ב׳ וד׳"}], "hasCar": False})
        m = profile_extract.merge(known, {"routines": [{"what": "קיקבוקס", "time": "20:30"}]})
        line = profile_extract.echo_line(known, m, "he")
        self.assertIn("ב-20:30", line)
        self.assertNotIn("אוטו", line)

    def test_nothing_understood_says_nothing(self):
        self.assertEqual(profile_extract.echo_line({"name": "x"}, {"name": "x"}, "he"), "")


class TheVoice(unittest.TestCase):
    def setUp(self):
        tts._cache.clear()
        tts._by_id.clear()
        tts._working.clear()

    def _post(self, answers):
        calls = []

        async def post(url, params=None, json=None):
            calls.append(json["voice"]["name"])
            status, body = answers.pop(0)
            r = mock.MagicMock(status_code=status, text=str(body))
            r.json = lambda: body
            return r
        client = mock.MagicMock()
        client.post = post
        cm = mock.MagicMock()
        cm.__aenter__ = mock.AsyncMock(return_value=client)
        cm.__aexit__ = mock.AsyncMock(return_value=False)
        return calls, mock.patch.object(tts.httpx, "AsyncClient", return_value=cm)

    def test_hebrew_is_spoken_in_chirp_first(self):
        mp3 = base64.b64encode(b"ID3audio").decode()
        calls, patch = self._post([(200, {"audioContent": mp3})])
        with patch, mock.patch.object(tts, "_key", return_value="k"):
            audio, why = asyncio.run(tts.synthesize("היי, אני מאירה!"))
        self.assertEqual((audio, why), (b"ID3audio", None))
        self.assertEqual(calls, ["he-IL-Chirp3-HD-Aoede"])

    def test_a_voice_google_does_not_serve_falls_to_the_next(self):
        mp3 = base64.b64encode(b"x").decode()
        calls, patch = self._post([(400, {"error": "voice"}), (200, {"audioContent": mp3})])
        with patch, mock.patch.object(tts, "_key", return_value="k"):
            audio, _ = asyncio.run(tts.synthesize("שלום"))
        self.assertEqual(audio, b"x")
        self.assertEqual(calls, ["he-IL-Chirp3-HD-Aoede", "he-IL-Wavenet-A"])
        self.assertEqual(tts._working["he"], "he-IL-Wavenet-A")

    def test_every_failure_says_why(self):
        with mock.patch.object(tts, "_key", return_value=None):
            self.assertEqual(asyncio.run(tts.synthesize("שלום")), (None, "not_configured"))
        calls, patch = self._post([(403, {"error": "SERVICE_DISABLED"})])
        with patch, mock.patch.object(tts, "_key", return_value="k"):
            self.assertEqual(asyncio.run(tts.synthesize("שלום")), (None, "refused"))

    def test_the_same_greeting_is_not_paid_for_twice(self):
        mp3 = base64.b64encode(b"hi").decode()
        calls, patch = self._post([(200, {"audioContent": mp3})])
        with patch, mock.patch.object(tts, "_key", return_value="k"):
            asyncio.run(tts.synthesize("Hi, I'm Meira"))
            clip, _ = asyncio.run(tts.synthesize_id("Hi, I'm Meira"))
        self.assertEqual(calls, ["en-US-Chirp3-HD-Aoede"])
        # The phone's player fetches it by id — the sentence is never in a URL.
        self.assertEqual(tts.clip(clip), b"hi")
        self.assertNotIn("Meira", clip)


if __name__ == "__main__":
    unittest.main()
