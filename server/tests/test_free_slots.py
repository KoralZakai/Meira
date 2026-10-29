import unittest
import free_slots


class FreeSlotsTests(unittest.TestCase):
    ROWS = [
        {"date": "2026-10-20", "text": "ראיון עבודה", "category": "interview", "fixed_time": "10:00", "duration_minutes": 60},
        {"date": "2026-10-19", "text": "gym", "fixed_time": "18:00", "duration_minutes": 60},
    ]

    def _find(self):
        return free_slots.find(self.ROWS, "2026-10-19", "2026-10-21", 120,
                               now_date="2026-10-17", now_hhmm="09:00", limit=50)

    def test_evening_before_an_interview_is_out(self):
        out = self._find()
        eve = [s for s in out["slots"] if s["date"] == "2026-10-19"]
        self.assertTrue(eve)
        self.assertTrue(all(free_slots._mins(s["end"]) <= 17 * 60 for s in eve))
        self.assertTrue(any(r["date"] == "2026-10-19" for r in out["ruled_out"]))

    def test_run_up_to_the_interview_is_out(self):
        day = [s for s in self._find()["slots"] if s["date"] == "2026-10-20"]
        for s in day:
            self.assertTrue(free_slots._mins(s["end"]) <= 10 * 60 - 90
                            or free_slots._mins(s["start"]) >= 11 * 60)

    def test_nothing_before_now(self):
        out = free_slots.find([], "2026-10-17", "2026-10-17", 60, now_date="2026-10-17", now_hhmm="15:07")
        self.assertEqual(out["slots"][0]["start"], "15:10")


class FreeSlotsDaysTests(unittest.TestCase):
    def test_every_day_listed_days_off_first(self):
        rows = [{"date": "2026-10-21", "text": "doctor", "fixed_time": "10:30", "duration_minutes": 60}]
        out = free_slots.find(rows, "2026-10-19", "2026-10-24", 180, now_date="2026-10-18",
                              now_hhmm="09:00", off_days=free_slots.days_off("ימי שישי ושבת הם ימי החופש שלי"))
        self.assertEqual({d["date"] for d in out["days"]}, {f"2026-10-{n}" for n in range(19, 25)})
        self.assertEqual([d["weekday"] for d in out["days"][:2]], ["יום שישי", "יום שבת"])
        self.assertTrue(all(d["windows"] or d["why_not"] for d in out["days"]))

    def test_days_off_parsing(self):
        self.assertEqual(free_slots.days_off("Fri-Sat are days off"), {4, 5})
        self.assertEqual(free_slots.days_off("gym Monday 18:00"), set())


class WorkdayEmployerTests(unittest.TestCase):
    """Workday is the employer AND an ATS vendor: only its mailers are the vendor."""

    def test_phone_screen_at_workday_names_workday(self):
        import meeting_brief
        ev = {"title": "Your Phone Screen at Workday for JR-0104334 Senior Applied AI Engineer (Paradox) (Open) is tomorrow!",
              "organizer": "me@gmail.com",
              "description": "Recruiter: Joan\nScheduling Contact: joan@workday.com"}
        self.assertEqual(meeting_brief.subjects(ev)["company"], "Workday")

    def test_vendor_mailer_is_still_not_the_employer(self):
        import meeting_brief
        ev = {"title": "Interview with Dana Cohen (Recruiter)", "organizer": "me@gmail.com",
              "description": "Scheduling Contact: x@myworkday.com"}
        self.assertEqual(meeting_brief.subjects(ev)["company"], "")

    def test_role_is_the_job_name_after_the_requisition_number(self):
        import meeting_brief
        ev = {"title": "Your Phone Screen at Workday for JR-0104334 Senior Applied AI Engineer (Paradox) (Open) (JR-0104334) is tomorrow!",
              "organizer": "me@gmail.com", "description": ""}
        r = meeting_brief.subjects(ev)
        self.assertEqual((r["company"], r["role"]), ("Workday", "Senior Applied AI Engineer"))


class HollowTitleTests(unittest.TestCase):
    def test_day_only_title_is_replaced_by_a_real_one(self):
        import task_rescue
        self.assertTrue(task_rescue.hollow_title("🗓️ שבת | |"))
        self.assertFalse(task_rescue.hollow_title("פיקניק"))
        patch = task_rescue.changed_fields({"text": "🗓️ שבת | |", "date": "2026-10-24"},
                                           {"text": "פיקניק בפארק החורשות", "date": "2026-10-24"})
        self.assertEqual(patch.get("text"), "פיקניק בפארק החורשות")

    def test_a_real_title_is_left_alone(self):
        import task_rescue
        self.assertNotIn("text", task_rescue.changed_fields({"text": "קריוקי באלנבי"}, {"text": "לקריוקי"}))


class NotesTests(unittest.TestCase):
    def test_notes_reach_the_row_and_the_twin_update(self):
        import supabase_tasks, task_rescue
        row = supabase_tasks._task_row("u", {"text": "פיקניק", "notes": "להביא משהו טעים וכוס רב־פעמית"})
        self.assertEqual(row["progress"], "להביא משהו טעים וכוס רב־פעמית")
        self.assertEqual(task_rescue.changed_fields({"text": "פיקניק"}, {"text": "פיקניק", "notes": "x"}).get("notes"), "x")
        self.assertEqual(supabase_tasks._PATCH_MAP["notes"], "progress")


class PreviousMeetingTests(unittest.TestCase):
    def test_earlier_meeting_becomes_a_citable_source(self):
        import meeting_brief
        ev = {"previous": [{"title": "Intro call with Joan", "date": "2026-10-12", "notes": "Talked about LLM work"},
                           {"title": "", "date": "2026-10-01"}]}
        src = meeting_brief._previous_sources(ev)
        self.assertEqual(len(src), 1)
        self.assertIn("2026-10-12", src[0]["title"])
        self.assertIn("LLM", src[0]["snippet"])
        self.assertEqual(src[0]["kind"], "history")

    def test_history_alone_is_enough_to_brief(self):
        import meeting_brief
        self.assertTrue(meeting_brief._has_history({"previous": [{"title": "x", "date": "d"}]}))
        self.assertFalse(meeting_brief._has_history({}))

    def test_previous_comes_through_history_sources(self):
        import meeting_brief
        out = meeting_brief._history_sources({"previous": [{"title": "Sync", "date": "2026-10-10", "notes": ""}],
                                              "history": [{"subject": "CV", "snippet": "sent", "date": "d"}]})
        self.assertEqual([s["title"].split(":")[0] for s in out], ["Your earlier meeting", "Your email"])
