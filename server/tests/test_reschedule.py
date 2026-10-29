import unittest
from datetime import date

import reschedule as rs

TODAY = date(2026, 10, 18)   # a Sunday
TASKS = [
    {"id": "w", "date": "2026-10-19", "fixed_time": "13:00", "category": "interview",
     "text": "Your Phone Screen at Workday for JR-0104334 Senior Applied AI Engineer (Paradox)"},
    {"id": "g", "date": "2026-10-20", "fixed_time": "20:00", "category": "gym", "text": "אימון"},
    {"id": "m", "date": "2026-10-19", "fixed_time": "18:00", "category": "meeting", "text": "פגישה עם דנה"},
]


class FindMoveTests(unittest.TestCase):
    def test_the_real_garbled_sentence(self):
        # speech-to-text: "הראיון" → "העיון", "נדחה" → "נתחל"
        m = rs.find_move("העיון שלי מחר ב-Work Day נתחל ליום שלישי", TASKS, TODAY)
        self.assertEqual((m["task"]["id"], m["new_date"], m["old_date"]), ("w", "2026-10-20", "2026-10-19"))

    def test_a_clean_sentence_with_an_hour(self):
        m = rs.find_move("הראיון ב-Workday נדחה ליום שלישי ב-14:30", TASKS, TODAY)
        self.assertEqual((m["new_date"], m["new_time"]), ("2026-10-20", "14:30"))

    def test_english(self):
        m = rs.find_move("my Workday interview was postponed to Tuesday", TASKS, TODAY)
        self.assertEqual(m["task"]["id"], "w")

    def test_not_a_move(self):
        self.assertIsNone(rs.find_move("רצה לנסות לקום ליוגה בשמונה", TASKS, TODAY))
        self.assertIsNone(rs.find_move("מתי הראיון נדחה ליום שלישי?", TASKS, TODAY))
        self.assertIsNone(rs.find_move("יש לי ראיון ביום שלישי", TASKS, TODAY))

    def test_two_equal_candidates_are_not_guessed(self):
        two = [{"id": "a", "date": "2026-10-19", "category": "meeting", "text": "פגישה עם דנה"},
               {"id": "b", "date": "2026-10-19", "category": "meeting", "text": "פגישה עם דנה"}]
        self.assertIsNone(rs.find_move("הפגישה עם דנה נדחתה ליום שלישי", two, TODAY))

    def test_the_old_day_picks_the_task(self):
        two = [{"id": "a", "date": "2026-10-19", "category": "meeting", "text": "פגישה עם דנה"},
               {"id": "b", "date": "2026-10-22", "category": "meeting", "text": "פגישה עם דנה"}]
        m = rs.find_move("הפגישה עם דנה מחר נדחתה ליום חמישי", two, TODAY)
        self.assertEqual(m["task"]["id"], "a")


class ReplyTests(unittest.TestCase):
    def setUp(self):
        self.move = rs.find_move("העיון שלי מחר ב-Work Day נתחל ליום שלישי", TASKS, TODAY)

    def test_says_what_moved_what_it_gives_and_asks_once(self):
        text, offered = rs.reply(self.move, TODAY, True)
        self.assertTrue(offered)
        self.assertIn("הזזתי", text)
        self.assertIn("להתכונן", text)
        self.assertTrue(text.endswith("?"))
        self.assertIn("באיזו שעה", text)
        self.assertIn("20.10", text)          # dated (rule 4)

    def test_english_and_the_google_note(self):
        text, _ = rs.reply(self.move, TODAY, False, calendar_owned=True)
        self.assertIn("Google Calendar", text)
        self.assertIn("Tuesday 20.10", text)

    def test_no_study_offer_for_a_dentist(self):
        mv = {"task": {"id": "d", "category": "doctor", "text": "רופא שיניים", "fixed_time": "10:00"},
              "new_date": "2026-10-21", "new_time": None, "old_date": "2026-10-19"}
        text, offered = rs.reply(mv, TODAY, True)
        self.assertFalse(offered)
        self.assertNotIn("לימוד", text)


class AnswerTests(unittest.TestCase):
    def test_answers(self):
        self.assertEqual(rs.parse_answer("כן")["answer"], "yes")
        self.assertEqual(rs.parse_answer("ב-8"), {"answer": "time", "time": "08:00"})
        self.assertEqual(rs.parse_answer("בשבע וחצי"), {"answer": "time", "time": "07:30"})
        self.assertEqual(rs.parse_answer("לא צריך")["answer"], "no")
        self.assertIsNone(rs.parse_answer("אולי")["answer"])

    def test_study_slot_is_the_day_before_and_never_the_past(self):
        self.assertEqual(rs.study_slot("2026-10-20", TODAY, "08:00", "10:00"), "2026-10-19")
        self.assertEqual(rs.study_slot("2026-10-19", TODAY, "20:00", "10:00"), "2026-10-18")
        self.assertIsNone(rs.study_slot("2026-10-19", TODAY, "08:00", "10:00"))


class SessionOfferTests(unittest.TestCase):
    def test_offer_round_trip(self):
        import session
        session.set_pending_offer("0500000000", {"kind": "study", "date": "2026-10-20"})
        self.assertEqual(session.get_pending_offer("0500000000")["kind"], "study")
        session.clear_pending_offer("0500000000")
        self.assertIsNone(session.get_pending_offer("0500000000"))


class ChosenModeTests(unittest.TestCase):
    def test_her_choice_stands_and_the_ladders_does_not(self):
        import daychain
        self.assertEqual(daychain.chosen_mode({"location": {"transportType": "car", "transportTypeBy": "her"}}), "car")
        self.assertEqual(daychain.chosen_mode({"location": {"transportType": "bus"}}), "bus")  # before the ladder: hers
        self.assertIsNone(daychain.chosen_mode({"location": {"transportType": "bus", "transportTypeBy": "ladder"}}))
        self.assertIsNone(daychain.chosen_mode({"location": None}))
        self.assertIsNone(daychain.chosen_mode(None))


# ── 19.10: the offer proposes an hour that fits, and understands the short answer ──

class ProposeStudyTests(unittest.TestCase):
    MOVE = {"task": TASKS[0], "new_date": "2026-10-20", "new_time": None, "old_date": "2026-10-19"}

    def test_proposes_a_free_evening_hour_the_day_before(self):
        p = rs.propose_study(self.MOVE, TASKS, TODAY, "10:00")
        self.assertEqual((p["date"], p["time"]), ("2026-10-19", "20:00"))

    def test_a_busy_evening_moves_the_hour_not_the_promise(self):
        rows = TASKS + [{"id": "x", "date": "2026-10-19", "fixed_time": "19:30", "duration_minutes": 90,
                         "category": "meeting", "text": "ארוחה"}]
        p = rs.propose_study(self.MOVE, rows, TODAY, "10:00")
        self.assertGreaterEqual(p["time"], "21:15")    # 19:30-21:00 plus buffer is taken
        self.assertEqual(p["minutes"], 60)             # two hours no longer fit; one does

    def test_never_in_the_past_and_none_when_nothing_fits(self):
        late = rs.propose_study({**self.MOVE, "new_date": "2026-10-19"}, TASKS, TODAY, "23:00")
        self.assertIsNone(late)                        # the day before is today and it is night

    def test_the_moved_task_does_not_block_its_own_prep(self):
        p = rs.propose_study(self.MOVE, TASKS, TODAY, "10:00")
        self.assertIsNotNone(p)

    def test_reply_names_the_hour_instead_of_asking_for_one(self):
        mv = rs.find_move("העיון שלי מחר ב-Work Day נתחל ליום שלישי", TASKS, TODAY)
        p = rs.propose_study(mv, TASKS, TODAY, "10:00")
        text, offered = rs.reply(mv, TODAY, True, proposal=p)
        self.assertTrue(offered)
        self.assertIn("20:00", text)
        self.assertNotIn("באיזו שעה", text)
        self.assertEqual(text.count("?"), 1)           # ONE question
        en, _ = rs.reply(mv, TODAY, False, proposal=p)
        self.assertIn("20:00", en)
        self.assertEqual(en.count("?"), 1)

    def test_reply_with_no_free_hour_still_asks_once(self):
        mv = rs.find_move("הראיון ב-Workday נדחה ליום שלישי", TASKS, TODAY)
        text, offered = rs.reply(mv, TODAY, True, proposal=None)
        self.assertTrue(offered)
        self.assertIn("באיזו שעה", text)

    def test_no_wake_promise_the_booking_does_not_keep(self):
        mv = rs.find_move("הראיון ב-Workday נדחה ליום שלישי", TASKS, TODAY)
        p = rs.propose_study(mv, TASKS, TODAY, "10:00")
        for he in (True, False):
            text, _ = rs.reply(mv, TODAY, he, proposal=p)
            self.assertNotIn("להעיר", text)
            self.assertNotIn("wake", text.lower())


class MorningOptionsTests(unittest.TestCase):
    def test_offers_flexible_hours_not_one_fixed(self):
        self.assertEqual(rs.morning_options("13:00", 45), ["07:00", "08:00", "09:00"])

    def test_early_interview_leaves_only_what_fits(self):
        opts = rs.morning_options("09:00", 45)          # latest start 06:45
        self.assertTrue(opts and all("06:00" <= o <= "06:45" for o in opts))

    def test_too_early_means_no_offer_at_all(self):
        self.assertEqual(rs.morning_options("07:30", 45), [])


class AnswerV2Tests(unittest.TestCase):
    def test_the_old_answers_still_hold(self):
        self.assertEqual(rs.parse_answer("ב-8"), {"answer": "time", "time": "08:00"})
        self.assertEqual(rs.parse_answer("לא צריך")["answer"], "no")

    def test_an_evening_block_reads_8_as_evening(self):
        self.assertEqual(rs.parse_answer("ב-8", prefer="evening"), {"answer": "time", "time": "20:00"})
        self.assertEqual(rs.parse_answer("בשמונה וחצי", prefer="evening")["time"], "20:30")
        self.assertEqual(rs.parse_answer("20:00", prefer="evening")["time"], "20:00")
        self.assertEqual(rs.parse_answer("ב-8 בבוקר", prefer="evening")["time"], "08:00")  # she said morning

    def test_a_morning_block_keeps_8_as_morning(self):
        self.assertEqual(rs.parse_answer("ב-8", prefer="morning")["time"], "08:00")
        self.assertEqual(rs.parse_answer("7", prefer="morning")["time"], "07:00")

    def test_day_parts(self):
        self.assertEqual(rs.parse_answer("בערב"), {"answer": "daypart", "time": None, "part": "evening"})
        self.assertEqual(rs.parse_answer("מחר בבוקר")["part"], "morning")
        self.assertEqual(rs.parse_answer("אחר הצהריים")["part"], "afternoon")

    def test_later_is_not_no(self):
        self.assertEqual(rs.parse_answer("אחר כך")["answer"], "later")
        self.assertEqual(rs.parse_answer("later")["answer"], "later")
        self.assertEqual(rs.parse_answer("לא")["answer"], "no")

    def test_another_hour(self):
        self.assertEqual(rs.parse_answer("שעה אחרת")["answer"], "other")
        self.assertEqual(rs.parse_answer("another time")["answer"], "other")

    def test_pick_in_day_part(self):
        slots = [{"start": "09:00", "end": "11:00"}, {"start": "18:00", "end": "22:00"}]
        self.assertEqual(rs.pick_in_part(slots, "evening", 120), "18:00")
        self.assertEqual(rs.pick_in_part(slots, "morning", 60), "09:00")
        self.assertIsNone(rs.pick_in_part(slots, "afternoon", 60))


class NudgeLevelTests(unittest.TestCase):
    def test_alarm_only_is_one_plain_reminder(self):
        n = rs.nudges_for("alarm", "20:00", "לימוד לקראת הראיון", True)
        self.assertEqual([t for t, _ in n], ["20:00"])

    def test_gentle_adds_a_heads_up(self):
        n = rs.nudges_for("gentle", "20:00", "לימוד", True)
        self.assertEqual([t for t, _ in n], ["19:30", "20:00"])

    def test_motivating_adds_cheer_and_a_check_in(self):
        n = rs.nudges_for("motivating", "20:00", "לימוד", False)
        self.assertEqual([t for t, _ in n], ["19:00", "20:00", "20:30"])
        self.assertTrue(all(text for _, text in n))

    def test_unknown_level_falls_back_to_gentle_and_midnight_is_safe(self):
        self.assertEqual(rs.normalize_level("whatever"), "gentle")
        self.assertEqual(rs.normalize_level(None), "gentle")
        late = rs.nudges_for("motivating", "23:50", "x", True)
        self.assertTrue(all("00:00" <= t <= "23:59" for t, _ in late))


class SuggestForChangeTests(unittest.TestCase):
    INTERVIEW = {"id": "w", "category": "interview", "text": "Phone screen at Workday", "fixed_time": "13:00"}

    def test_interview_moved_later_gets_an_hour_and_morning_options(self):
        r = rs.suggest_for_change(self.INTERVIEW, {"date": "2026-10-19"}, {"date": "2026-10-20", "time": "13:00"},
                                  [], TODAY, "10:00")
        self.assertTrue(r["prep"])
        self.assertEqual(r["kind"], "later")
        self.assertEqual((r["proposal"]["date"], r["proposal"]["time"]), ("2026-10-19", "20:00"))
        self.assertIn("20:00", r["starts"])
        self.assertEqual(r["morning"], ["07:00", "08:00", "09:00"])

    def test_a_same_day_shift_and_a_dentist_get_no_study_offer(self):
        same = rs.suggest_for_change(self.INTERVIEW, {"date": "2026-10-20"}, {"date": "2026-10-20", "time": "14:00"},
                                     [], TODAY, "10:00")
        self.assertEqual((same["kind"], same["proposal"]), ("sameDay", None))
        dentist = rs.suggest_for_change({"id": "d", "category": "doctor", "text": "רופא שיניים"},
                                        {"date": "2026-10-19"}, {"date": "2026-10-21"}, [], TODAY, "10:00")
        self.assertFalse(dentist["prep"])
        self.assertIsNone(dentist["proposal"])

    def test_moved_to_today_or_the_past_offers_nothing(self):
        r = rs.suggest_for_change(self.INTERVIEW, {"date": "2026-10-20"}, {"date": "2026-10-18"}, [], TODAY, "10:00")
        self.assertEqual((r["kind"], r["proposal"]), ("earlier", None))

    def test_a_full_evening_means_no_proposal_not_a_guess(self):
        rows = [{"id": "b%d" % i, "fixed_time": t, "duration_minutes": 120, "category": "meeting"}
                for i, t in enumerate(("08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"))]
        for r in rows:
            r["date"] = "2026-10-19"
        r = rs.suggest_for_change(self.INTERVIEW, {"date": "2026-10-19"}, {"date": "2026-10-20", "time": "13:00"},
                                  rows, TODAY, "07:00")
        self.assertIsNone(r["proposal"])
        self.assertTrue(r["prep"])


class AppEditMayShortenTests(unittest.TestCase):
    """21.10: a rename to a SHORTER title was silently put back by the server mirror."""

    def _fresh(self):
        import os, tempfile, user_memory
        self.tmp = tempfile.mkdtemp()
        self._old = user_memory._PATH
        user_memory._PATH = os.path.join(self.tmp, "user_memory.json")
        self.addCleanup(setattr, user_memory, "_PATH", self._old)
        return user_memory

    def test_app_push_can_shorten_the_title_but_a_chat_remention_cannot(self):
        um = self._fresh()
        first = um.add_task("0501234567", {"text": "תור להקפאת ביציות באסף הרופא ב10:30", "date": "2026-10-21",
                                             "fixed_time": "10:30", "duration_minutes": 60})
        # a chat re-mention with a shorter text keeps the fuller title (unchanged behaviour)
        again = um.add_task("0501234567", {"id": first["id"], "text": "תור לרופא", "date": "2026-10-21"})
        self.assertIn("הקפאת", again["text"])
        # the app's own push is her decision
        edited = um.add_task("0501234567", {"id": first["id"], "text": "תור לרופא", "date": "2026-10-21",
                                              "duration_minutes": 30}, trust_status=True)
        self.assertEqual(edited["text"], "תור לרופא")
        self.assertEqual(edited["duration_minutes"], 30)


class ReturnHomeToolWiringTests(unittest.TestCase):
    def test_tool_is_registered_and_taught(self):
        import lumi_agent
        names = {getattr(t, "name", "") for t in lumi_agent._make_tools("0500000000", "x")}
        self.assertIn("plan_return_home", names)
        self.assertIn("plan_return_home", lumi_agent.ROUTE_TOOLS)
        self.assertIn("NOT route_now", lumi_agent._STATIC_RULES)


class RoutineLinesSavedTests(unittest.TestCase):
    def test_a_named_routine_with_a_day_or_an_hour_is_saved_even_if_the_place_is_missing(self):
        import profile_extract as pe
        lines = pe.routine_lines_to_save([
            {"what": "יוגה", "days": "יום חמישי", "time": "18:00", "place": None, "transport": None},
            {"what": "pilates", "days": None, "time": None},          # nothing to show on a day
            {"what": "ציור", "days": "שלישי", "time": None},
        ])
        self.assertEqual(len(lines), 2)
        self.assertIn("יוגה", lines[0])
        self.assertIn("18:00", lines[0])


class ReturnLaterRoutingTests(unittest.TestCase):
    def test_a_later_trip_home_is_not_the_leave_now_lookup(self):
        import agent_turn
        self.assertTrue(agent_turn.asks_return_later("מתי אני חוזרת הביתה היום מאסף הרופא?"))
        self.assertTrue(agent_turn.asks_return_later("when am I back home tomorrow from the dentist?"))
        self.assertFalse(agent_turn.asks_return_later("איך אני חוזרת מפה הביתה?"))      # leaving now: the lookup
        self.assertFalse(agent_turn.asks_return_later("תוסיפי אימון מחר ב-7"))
