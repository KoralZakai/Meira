"""Her day, told to the chat, 2026-09-28.

Koral wrote: work on the app, then study for interviews, then a workout
"ב 6 בערב עד 8 בערב", then karaoke at Allenby 30. What she got:

  1. Meira asked instead of saving: "is the gym a specific one or at home?",
     "which slot do you prefer?", "when should I put the CV task?". Nothing on
     the timeline, so no travel between the gym and Allenby either.
  2. The rescue then saved her WHOLE message as one task — both lines as the
     title, no hour, no date — a "flexible task" on Today.
  3. Her answer to "when should the CV task go?" ("לפני האימון ולפני
     הקריוקי") was rescued as a new task too.
  4. "ב6 עד 7" was 06:00 on the server (18:00 on the phone); "1 בלילה" was 13:00.
  5. "Space Gym, יגאל אלון 94" became the street "Gym יגאל אלון 94".
  6. "I have written where the gym is a million times": the app door never
     wrote a place down, and keyed memory by a different id than WhatsApp.
  7. "לשלוח קורות חיים ל-Checkpoint" matched no category, and the model's
     guess — 💪 Gym — was kept.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import categorize  # noqa: E402
import conversation  # noqa: E402
import known_places  # noqa: E402
import lumi_agent  # noqa: E402
import routine_match  # noqa: E402
import task_extract  # noqa: E402
import task_rescue  # noqa: E402
import user_profile  # noqa: E402

HOME = "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo, Tel Aviv District"
DAY = "אימון ב 6 בערב עד 8 בערב \nאחר כך קריוקי באלנבי 30"


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _tool(name, phone, wa_phone=None, content=""):
    for t in lumi_agent._make_tools(phone, content, wa_phone=wa_phone):
        if t.name == name:
            return t
    raise AssertionError(name)


# ── 4. the hour ─────────────────────────────────────────────────────────────

class SpokenHours(unittest.TestCase):
    def test_a_bare_six_is_the_evening(self):
        self.assertEqual(task_extract.parse_clock_time("אימון ב6 עד 7"), "18:00")

    def test_the_range_is_the_length(self):
        r = task_extract.parse_time_range("אימון ב 6 בערב עד 8 בערב")
        self.assertEqual((r["start"], r["end"], r["minutes"]), ("18:00", "20:00", 120))
        r = task_extract.parse_time_range("אימון ב6 עד 7")
        self.assertEqual((r["start"], r["end"], r["minutes"]), ("18:00", "19:00", 60))

    def test_night_is_not_the_afternoon(self):
        self.assertEqual(task_extract.parse_clock_time("פגישה ב-1 בלילה"), "01:00")
        self.assertEqual(task_extract.parse_clock_time("שיחה ב 11 בלילה"), "23:00")

    def test_a_count_or_an_address_is_not_a_range(self):
        self.assertIsNone(task_extract.parse_time_range("יוגה 2-3 שעות"))
        self.assertIsNone(task_extract.parse_time_range("רחוב 8-10"))
        self.assertIsNone(task_extract.parse_clock_time("קריוקי באלנבי 30"))

    def test_team_is_not_am(self):
        self.assertEqual(task_extract.parse_clock_time("team meeting at 3"), "15:00")


# ── 5. a name is not a street ───────────────────────────────────────────────

class NameAndAddress(unittest.TestCase):
    def test_the_name_stays_out_of_the_street(self):
        for line in ("Space Gym, יגאל אלון 94", "Space Gym יגאל אלון 94"):
            street = routine_match.address_in(line)
            self.assertEqual(street, "יגאל אלון 94", line)
            self.assertEqual(routine_match.name_before(line, street), "Space Gym")

    def test_a_routine_line_gives_both(self):
        hit = routine_match.find("אימון", "Space Gym - Yigal Alon 94, Tel Aviv", "2026-09-28")
        self.assertEqual(hit["address"], "Yigal Alon 94, Tel Aviv")
        self.assertEqual(hit["name"], "Space Gym")

    def test_the_class_itself_is_not_a_place_name(self):
        hit = routine_match.find("קיקבוקס", "קיקבוקס 20:30-21:30 ביגאל אלון 94", "2026-09-28")
        self.assertNotIn("name", hit)


# ── 2 + 3. the rescue ───────────────────────────────────────────────────────

class RescueSplitsAndListens(unittest.TestCase):
    def test_two_lines_are_two_tasks_with_their_hours(self):
        tasks = [task_rescue.rescue(c, []) for c in task_rescue.clauses(DAY)]
        gym, karaoke = tasks
        self.assertEqual(gym["text"], "אימון")
        self.assertEqual((gym["fixed_time"], gym["duration_minutes"]), ("18:00", 120))
        self.assertIn("date", gym, "an hour with no day is today, not 'flexible'")
        self.assertEqual(gym["category"], "gym")
        self.assertEqual(karaoke["text"], "קריוקי באלנבי 30")
        self.assertEqual(karaoke["category"], "leisure")

    def test_the_other_option_is_not_a_task(self):
        parts = task_rescue.clauses("אימון ב6 עד 7\nאו ב 7 עד 8")
        self.assertEqual(parts, ["אימון ב6 עד 7"])

    def test_before_and_after_place_a_task_they_are_not_one(self):
        self.assertFalse(task_rescue.looks_like_a_task("לפני האימון ולפני הקריוקי"))
        self.assertTrue(task_rescue.looks_like_a_task("אחרי זה קריוקי"))

    def test_an_answer_to_meira_is_not_rescued(self):
        conversation.append("ans-phone", "לשלוח קורות חיים ל-Checkpoint",
                            "✓ נשמר. לשבץ לפני האימון או אחריו?")
        self.assertTrue(agent_turn.meira_just_asked("ans-phone"))
        with mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: []):
            saved, note = run(agent_turn.rescue_turn(
                "ans-phone", "לפני האימון ולפני הקריוקי", answering=True))
        self.assertEqual(saved, [])

    def test_no_question_was_pending(self):
        conversation.append("calm-phone", "היי", "היי! 🌟")
        self.assertFalse(agent_turn.meira_just_asked("calm-phone"))


# ── 6. told once, remembered — through either door ──────────────────────────

class RememberedPlace(unittest.TestCase):
    def setUp(self):
        user_profile.update_profile("user-uuid-1", homeAddress=HOME)

    async def _place(self, q):
        return {"formatted": "Yigal Alon St 94, Tel Aviv-Yafo", "lat": 32.07, "lng": 34.79,
                "name": "Yigal Alon 94"}

    def test_said_once_in_the_app_found_again_without_an_hour(self):
        with mock.patch.object(lumi_agent.geo, "find_place", self._place):
            saved = run(_tool("remember_place", "user-uuid-1", wa_phone="972500000777").ainvoke(
                {"activity": "חדר כושר", "place": "Space Gym, יגאל אלון 94"}))
            self.assertTrue(saved["ok"])
            self.assertEqual(saved["name"], "Space Gym")
            res = run(_tool("infer_task_details", "user-uuid-1", wa_phone="972500000777").ainvoke(
                {"task_text": "אימון", "date": "2026-09-28"}))
        self.assertEqual(res["location"], "Yigal Alon St 94, Tel Aviv-Yafo")
        self.assertEqual(res["recalled"]["location"]["from"], "known_place")
        self.assertEqual(res["place"]["displayName"], "Space Gym")

    def test_the_whatsapp_door_sees_it_too(self):
        with mock.patch.object(lumi_agent.geo, "find_place", self._place):
            run(_tool("remember_place", "user-uuid-1", wa_phone="972500000777").ainvoke(
                {"activity": "gym", "place": "Space Gym, יגאל אלון 94"}))
        hit = known_places.resolve("0500000777", "יוגה")
        self.assertEqual(hit["address"], "Yigal Alon St 94, Tel Aviv-Yafo")

    def test_a_place_she_names_on_a_task_is_learned(self):
        with mock.patch.object(lumi_agent.geo, "find_place", self._place):
            run(_tool("infer_task_details", "user-uuid-2", wa_phone="972500000888").ainvoke(
                {"task_text": "פילאטיס", "location": "יגאל אלון 94", "fixed_time": "19:00",
                 "date": "2026-09-28"}))
        self.assertIsNotNone(known_places.resolve("972500000888", "פילאטיס"))

    def test_the_model_cannot_flip_her_evening(self):
        async def _none(q):
            return None
        with mock.patch.object(lumi_agent.geo, "find_place", _none):
            res = run(_tool("infer_task_details", "user-uuid-3").ainvoke(
                {"task_text": "אימון ב 6 בערב עד 8 בערב", "fixed_time": "06:00",
                 "date": "2026-09-28"}))
        self.assertEqual((res["fixed_time"], res["duration_minutes"]), ("18:00", 120))


# ── 8. said again, saved once ───────────────────────────────────────────────

class AlreadyOnHerDay(unittest.TestCase):
    """"The karaoke shows twice — if it is already on the schedule it does not
    need to be there twice." She said "ואחר כך הקריוקי" and got "לקריוקי"
    beside "קריוקי באלנבי 30"."""

    DAY = [{"id": "k1", "text": "קריוקי באלנבי 30", "date": "2026-09-28",
            "fixed_time": "20:30", "status": "pending"},
           {"id": "g1", "text": "אימון בוקר", "date": "2026-09-28",
            "fixed_time": "07:00", "status": "pending"}]

    def test_the_same_thing_with_a_prefix_is_found(self):
        for text in ("לקריוקי", "הקריוקי"):
            twin = task_rescue.already_planned(self.DAY, {"text": text, "date": "2026-09-28"})
            self.assertEqual((twin or {}).get("id"), "k1", text)

    def test_another_hour_is_another_thing(self):
        self.assertIsNone(task_rescue.already_planned(
            self.DAY, {"text": "אימון", "date": "2026-09-28", "fixed_time": "18:00"}))

    def test_another_day_is_another_thing(self):
        self.assertIsNone(task_rescue.already_planned(
            self.DAY, {"text": "קריוקי", "date": "2026-09-29"}))

    def test_the_turn_updates_instead_of_adding(self):
        added = []
        with mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: self.DAY), \
                mock.patch.object(agent_turn.user_memory, "add_task",
                                  lambda p, t: added.append(t) or {"id": "new"}), \
                mock.patch.object(agent_turn.user_memory, "update_task", lambda *a: None), \
                mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone",
                                  mock.AsyncMock(return_value=None)), \
                mock.patch.object(agent_turn._tz, "today_il", lambda: __import__("datetime").date(2026, 9, 28)):
            # Her day, told that day: 28.9 is "today" here, not a day gone
            # (a past date with no date in the message now moves to today).
            saved = run(agent_turn.persist_agent_tasks(
                "dup-phone", "ואחר כך הקריוקי",
                {"tasks": [{"text": "לקריוקי", "date": "2026-09-28", "fixed_time": "20:30"}]},
                "app"))
        self.assertEqual(added, [])
        self.assertEqual([t["id"] for t in saved], ["k1"])


# ── 9. "יש לי מילואים ב 8 באוקטובר בפיקוד העורף ברמלה" ────────────────────────

class ReserveDutyDay(unittest.TestCase):
    """What she was about to say out loud. Before: no date (only "8.10" was a
    date), eight o'clock (the 8 of "8 באוקטובר" read as an hour), and no
    category — so no route, no alarm, no whole day on base."""

    SAID = "יש לי מילואים ב 8 באוקטובר בפיקוד העורף ברמלה"

    def test_a_month_name_is_a_date(self):
        import re
        import tz
        self.assertEqual(re.findall(tz.REL_DATE_RE, self.SAID), ["8 באוקטובר"])
        self.assertEqual(tz.resolve_date("8 באוקטובר", tz.date(2026, 9, 28)).isoformat(), "2026-10-08")
        self.assertEqual(tz.resolve_date("October 8th", tz.date(2026, 9, 28)).isoformat(), "2026-10-08")
        self.assertEqual(tz.resolve_date("5 במרס", tz.date(2026, 9, 28)).isoformat(), "2027-03-05")

    def test_the_day_of_the_month_is_not_an_hour(self):
        self.assertIsNone(task_extract.parse_clock_time(self.SAID))
        self.assertEqual(task_extract.parse_clock_time("ראיון ב 10 באוקטובר ב 11"), "11:00")

    def test_reserve_duty_is_a_working_day(self):
        async def _place(q):
            return {"formatted": "Home Front Command, Ramla", "lat": 31.93, "lng": 34.87,
                    "name": "פיקוד העורף"}
        with mock.patch.object(lumi_agent.geo, "find_place", _place):
            res = run(_tool("infer_task_details", "user-uuid-4").ainvoke(
                {"task_text": "מילואים", "location": "פיקוד העורף רמלה", "date": "2026-10-08"}))
        self.assertEqual((res["fixed_time"], res["duration_minutes"]), ("08:00", 480))
        self.assertEqual(res["category"], "work")
        self.assertEqual(res["recalled"]["time"]["from"], "whole_day")
        self.assertIn("place", res)


# ── 7. a CV is work ─────────────────────────────────────────────────────────

class JobHuntIsWork(unittest.TestCase):
    def test_cv_to_checkpoint(self):
        for text in ("לשלוח קורות חיים ל-Checkpoint", 'לשלוח קו"ח לצ׳קפוינט',
                     "send my CV to Checkpoint"):
            self.assertEqual(categorize.merge(text, {"category": "gym"})["category"], "work", text)

    def test_karaoke_is_going_out(self):
        self.assertEqual(categorize.infer("קריוקי באלנבי 30")["category"], "leisure")


if __name__ == "__main__":
    unittest.main()


# ── 11. the afternoon of 28.9, second round ─────────────────────────────────

class SaidInWords(unittest.TestCase):
    """"יש לי עכשיו שיחה עם דותן משתיים עד שתיים וחצי" — Whisper writes the hours
    as words, every parser read digits, nothing was saved."""

    def test_the_dotan_call(self):
        said = "יש לי עכשיו שיחה עם דותן משתיים עד שתיים וחצי, שימי לי את זה בלוז"
        self.assertEqual(task_extract.parse_time_range(said),
                         {"start": "14:00", "end": "14:30", "minutes": 30})
        task = task_rescue.rescue(said, [])
        self.assertEqual(task["fixed_time"], "14:00")
        self.assertNotIn("שתיים", task["text"])

    def test_common_spoken_hours(self):
        for said, hhmm in (("אימון בשמונה בערב", "20:00"), ("רופא ברבע לשלוש", "14:45"),
                           ("בשבע פחות רבע", "18:45"), ("ובשתיים זום", "14:00"),
                           ("באחת עשרה בלילה", "23:00"), ("call at four thirty", "16:30"),
                           ("from two to half past two", "14:00")):
            self.assertEqual(task_extract.parse_clock_time(said), hhmm, said)

    def test_numbers_that_are_not_hours(self):
        for said in ("ללמוד לשלוש שעות", "שלוש משימות היום", "באחת הפגישות",
                     "נסיעה לבאר שבע", "I have two meetings", "at one point"):
            self.assertIsNone(task_extract.parse_clock_time(said), said)


class ADateSheSaid(unittest.TestCase):
    """The reserve-duty recording came back as "ב-80 באוקטובר"; typed, "ב8/10"."""

    def test_glued_zero_and_slash(self):
        import tz
        from datetime import date
        today = date(2026, 9, 28)
        for said in ("מילואים ב-80 באוקטובר", "מילואים ב8/10", "מילואים ב-8.10"):
            found = tz.REL_DATE_RE.findall(said)
            self.assertTrue(found, said)
            self.assertEqual(tz.resolve_date(found[0], today), date(2026, 10, 8), said)


class NotAPlace(unittest.TestCase):
    """"לסדר באגים" was a trip to "אגים"."""

    def test_words_after_bet_are_not_addresses(self):
        for said in ("לעבוד על מאירה, לסדר באגים", "שימי לי את זה בלוז", "באחת הפגישות"):
            self.assertIsNone(task_extract.extract_place(said), said)

    def test_real_addresses_still_are(self):
        self.assertEqual(task_extract.extract_place("קריוקי באלנבי 30"), "אלנבי 30")
        self.assertEqual(task_extract.extract_place("אימון ביגאל אלון 94 ב 8 בערב"), "יגאל אלון 94")


class TheRangeSheSaid(unittest.TestCase):
    """"אימון מ 18:00 עד 20:00" was saved until 19:00 — the gym routine's hour
    won over the two hours she said, and the model passed task_text "אימון"."""

    def test_two_hours_even_with_a_one_hour_routine(self):
        profile = {"homeAddress": HOME, "routinesNotes": "אימון 18:00-19:00 יגאל אלון 94"}
        tool = _tool("infer_task_details", "range-phone", content="אימון מ 18:00 עד 20:00")
        with mock.patch.object(lumi_agent.user_profile, "get_profile", lambda p: profile), \
                mock.patch.object(lumi_agent.geo, "find_place", mock.AsyncMock(return_value=None)), \
                mock.patch.object(lumi_agent.known_places, "resolve", lambda *a, **k: None):
            out = run(tool.ainvoke({"task_text": "אימון", "fixed_time": "18:00",
                                    "date": "2026-09-28"}))
        self.assertEqual(out["fixed_time"], "18:00")
        self.assertEqual(out["duration_minutes"], 120)


class ClashIsSaidOutLoud(unittest.TestCase):
    """Reserve duty on 8.10, on a day that already held two interviews."""

    DAY = [{"id": "i1", "text": "ראיון ראשון - חיפה", "date": "2026-10-08",
            "fixed_time": "10:00", "duration_minutes": 120, "status": "pending"},
           {"id": "i2", "text": "ראיון ברפאל", "date": "2026-10-08",
            "fixed_time": "12:00", "duration_minutes": 60, "status": "pending"}]
    DUTY = {"id": "m1", "text": "מילואים בפיקוד העורף ברמלה", "date": "2026-10-08",
            "fixed_time": "08:00", "duration_minutes": 480}

    def _note(self, cloud):
        with mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone",
                               mock.AsyncMock(return_value="u1")), \
                mock.patch.object(agent_turn.supabase_tasks, "tasks_for_user",
                                  mock.AsyncMock(return_value=cloud)), \
                mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: []):
            return run(agent_turn.clash_note("clash-phone", [self.DUTY], he=True))

    def test_both_interviews_are_named(self):
        note = self._note(self.DAY)
        self.assertIn("ראיון ראשון - חיפה", note)
        self.assertIn("ראיון ברפאל", note)
        self.assertIn("8.10", note)

    def test_a_free_day_says_nothing(self):
        self.assertEqual(self._note([]), "")

    def test_the_task_itself_is_not_a_clash(self):
        self.assertEqual(self._note([self.DUTY]), "")


class TheToolSaysWhatItCollidesWith(unittest.TestCase):
    """A general fix, not a note for one day: infer_task_details returns the
    collisions its task makes, so the agent reasons about them in every channel."""

    def test_reserve_duty_names_both_interviews(self):
        day = [{"id": "i1", "text": "ראיון ראשון - חיפה", "date": "2026-10-08",
                "fixed_time": "10:00", "duration_minutes": 120, "status": "pending"},
               {"id": "i2", "text": "ראיון ברפאל", "date": "2026-10-08",
                "fixed_time": "12:00", "duration_minutes": 60, "status": "pending"}]
        tool = _tool("infer_task_details", "tool-clash", content="מילואים ב 8 באוקטובר")
        with mock.patch.object(lumi_agent.user_profile, "get_profile", lambda p: {"homeAddress": HOME}), \
                mock.patch.object(lumi_agent.geo, "find_place", mock.AsyncMock(return_value=None)), \
                mock.patch.object(lumi_agent.known_places, "resolve", lambda *a, **k: None), \
                mock.patch.object(lumi_agent.task_store, "fetch_task_rows", mock.AsyncMock(return_value=day)):
            out = run(tool.ainvoke({"task_text": "מילואים בפיקוד העורף", "date": "2026-10-08"}))
        self.assertEqual(out["fixed_time"], "08:00")
        self.assertEqual([c["id"] for c in out["clashes"]], ["i1", "i2"])

    def test_a_free_day_has_no_clash_key(self):
        tool = _tool("infer_task_details", "tool-free", content="אימון ב 18:00")
        with mock.patch.object(lumi_agent.user_profile, "get_profile", lambda p: {"homeAddress": HOME}), \
                mock.patch.object(lumi_agent.geo, "find_place", mock.AsyncMock(return_value=None)), \
                mock.patch.object(lumi_agent.known_places, "resolve", lambda *a, **k: None), \
                mock.patch.object(lumi_agent.task_store, "fetch_task_rows", mock.AsyncMock(return_value=[])):
            out = run(tool.ainvoke({"task_text": "אימון", "fixed_time": "18:00", "date": "2026-09-28"}))
        self.assertNotIn("clashes", out)
