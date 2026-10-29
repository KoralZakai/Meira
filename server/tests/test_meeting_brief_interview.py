"""meeting_brief for INTERVIEWS — the job and the questions, not only the company.

Koral, 17.10: an interview tomorrow at 13:30, "koral Technical Interview", at
"רפאל מכון דוד". "Do you want to prepare? What about collecting knowledge about
the interviewer? About the job! Search for questions that were asked there."

Before this the brief was never built for that event at all: the title names no
company and the venue is Hebrew, so subjects() found nothing and build()
returned "nothing_to_research" — which the app turned into NO CARD. The tests
pin the three things that make the feature trustworthy:

  * the company is found from the venue, and a non-interview still is not;
  * the interview searches run, within the cost ceiling, and no search carries
    HER name (the title does);
  * a question nobody reported is dropped, and every way of having nothing to
    show comes back as a reason, never as an empty card.
"""
import asyncio
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import meeting_brief  # noqa: E402

# The real shape of the event: typed by her, so no organiser domain, no
# "with <Company>", no position line — only a title and a Hebrew venue.
RAFAEL = {
    "id": "evt-rafael",
    "title": "koral Technical Interview",
    "date": "2026-10-18", "time": "13:30",
    "location": "רפאל מכון דוד",
}


def _result(i: int) -> dict:
    return {"title": f"Source {i}", "link": f"https://example.com/{i}", "snippet": f"snippet {i}"}


class FakeSearch:
    """tavily_search.search, recording every query and how many results it asked for."""

    def __init__(self, per_query: int = 5, fail: str = ""):
        self.calls: list[tuple[str, int, dict]] = []
        self.per_query = per_query
        self.fail = fail
        self._n = 0

    async def __call__(self, query, *, max_results=5, **kw):
        self.calls.append((query, max_results, kw))
        if self.fail:
            return {"ok": False, "error": self.fail}
        out = []
        for _ in range(min(max_results, self.per_query)):
            self._n += 1
            out.append(_result(self._n))
        return {"ok": True, "results": out}


class SubjectTests(unittest.TestCase):
    def test_the_company_comes_from_the_hebrew_venue(self):
        s = meeting_brief.subjects(RAFAEL)
        self.assertTrue(s["interview"])
        self.assertEqual(s["company"], "רפאל")
        self.assertEqual(s["name_he"], "רפאל")
        self.assertEqual(s["name_en"], "Rafael Advanced Defense Systems")
        self.assertEqual(s["company_from"], "venue")
        # the whole venue is kept as a hint for the model
        self.assertEqual(s["venue"], "רפאל מכון דוד")

    def test_the_role_is_the_kind_of_interview_the_title_says(self):
        s = meeting_brief.subjects(RAFAEL)
        self.assertEqual(s["role"], "Technical")
        self.assertEqual(s["interview_kind"], "Technical")

    def test_the_position_line_beats_the_kind_of_interview(self):
        s = meeting_brief.subjects({**RAFAEL, "description": "Position: Embedded Software Engineer"})
        self.assertEqual(s["role"], "Embedded Software Engineer")

    def test_a_hebrew_prefix_does_not_hide_a_known_employer(self):
        s = meeting_brief.subjects({"title": "ראיון עבודה", "location": "במשרדי רפאל, חיפה"})
        self.assertEqual(s["name_en"], "Rafael Advanced Defense Systems")

    def test_a_known_employer_survives_a_street_in_the_same_field(self):
        s = meeting_brief.subjects({"title": "Interview", "location": "Rafael, Derech Hashalom 53, Haifa"})
        self.assertEqual(s["name_en"], "Rafael Advanced Defense Systems")

    def test_an_unknown_employer_is_the_venues_first_words(self):
        s = meeting_brief.subjects({"title": "Interview", "location": "Acme Robotics, Herzl 5, Haifa"})
        self.assertEqual(s["company"], "Acme Robotics")
        self.assertEqual(s["name_en"], "Acme Robotics")
        self.assertEqual(s["name_he"], "")

    def test_a_street_or_a_video_call_is_not_an_employer(self):
        for loc in ("Derech Hashalom 53, Tel Aviv", "https://meet.google.com/abc-defg-hij", "Zoom"):
            s = meeting_brief.subjects({"title": "Technical Interview", "location": loc})
            self.assertEqual(s["company"], "", loc)

    def test_the_invite_still_wins_over_the_venue(self):
        s = meeting_brief.subjects({"title": "Your phone interview with Ceva", "location": "רפאל"})
        self.assertEqual(s["company"], "Ceva")
        self.assertEqual(s["company_from"], "invite")

    def test_a_non_interview_never_reads_the_venue(self):
        """Rule 8: a gym is called 'Space Gym', not an employer."""
        s = meeting_brief.subjects({"title": "אימון", "location": "Space Gym, Ra'anana"})
        self.assertEqual(s["company"], "")
        self.assertFalse(s["interview"])

    def test_the_category_alone_makes_it_an_interview(self):
        s = meeting_brief.subjects({"title": "Rafael 13:30", "category": "interview", "location": "רפאל"})
        self.assertTrue(s["interview"])

    def test_our_own_study_blocks_are_not_interviews(self):
        for title in ("Prep for the Ceva interview — company, role, questions",
                      "הכנה לראיון ברפאל — החברה, התפקיד, שאלות",
                      "Morning study for Rafael — up early, then out the door"):
            self.assertFalse(meeting_brief.is_interview({"title": title}), title)


class GatherTests(unittest.TestCase):
    def _gather(self, event=RAFAEL, **kw):
        search = FakeSearch(**kw)
        subj = meeting_brief.subjects(event)
        with mock.patch.object(meeting_brief.tavily_search, "search", search):
            out = asyncio.run(meeting_brief._gather(subj))
        return search, out

    def test_the_interview_searches_run(self):
        search, _ = self._gather()
        queries = [c[0] for c in search.calls]
        self.assertIn("Rafael Advanced Defense Systems interview questions Technical", queries)
        self.assertIn("שאלות ראיון עבודה רפאל", queries)
        self.assertTrue(any("job requirements careers" in q for q in queries), queries)
        self.assertTrue(any("company what they do" in q for q in queries), queries)

    def test_the_cost_ceiling_holds(self):
        # the worst case: a person to look up as well
        event = {**RAFAEL, "description": "Interview with Dana Levi (Team Lead)\nPosition: Embedded Engineer"}
        search, out = self._gather(event)
        self.assertLessEqual(len(search.calls), meeting_brief._MAX_SEARCHES)
        self.assertLessEqual(len(out), meeting_brief._MAX_RESULTS)

    def test_her_name_never_reaches_the_search_engine(self):
        """The title is 'koral Technical Interview'. The queries are about the company."""
        search, _ = self._gather()
        for query, _n, _kw in search.calls:
            self.assertNotIn("koral", query.lower())

    def test_no_hebrew_search_for_an_english_only_invite(self):
        event = {"title": "Your phone interview with Ceva", "organizer": "x@comeet-notifications.com"}
        search, _ = self._gather(event)
        self.assertFalse(any("שאלות" in c[0] for c in search.calls))

    def test_a_plain_meeting_keeps_its_three_searches(self):
        event = {"title": "Call with Directeam", "description": "Meeting with Yuval Shitrit (CTO)"}
        search, out = self._gather(event)
        self.assertEqual(len(search.calls), 3)
        self.assertFalse(any("interview" in c[0] for c in search.calls))
        self.assertLessEqual(len(out), meeting_brief._MAX_RESULTS_PLAIN)

    def test_failed_searches_are_reported_not_swallowed(self):
        errors: list = []
        subj = meeting_brief.subjects(RAFAEL)
        with mock.patch.object(meeting_brief.tavily_search, "search", FakeSearch(fail="rate_limited")):
            out = asyncio.run(meeting_brief._gather(subj, errors))
        self.assertEqual(out, [])
        self.assertTrue(errors)
        self.assertEqual(set(errors), {"rate_limited"})


class CleanTests(unittest.TestCase):
    def _brief(self, **over):
        base = {
            "headline_en": "h", "headline_he": "ה",
            "company_en": ["Builds missiles [1]"], "company_he": ["מפתחת טילים [1]"],
            "role_en": ["Embedded C++ [2]", "No source here"], "role_he": ["C++ משובץ [2]"],
            "likely_questions_en": ["Reverse a linked list [3]",
                                    "How would you design a rate limiter?",       # nobody reported it
                                    "Explain RTOS scheduling [9]"],                # source 9 never existed
            "likely_questions_he": ["הפוך רשימה מקושרת [3]"],
            "prep_en": ["Revise pointers [3]"], "prep_he": ["חזור על מצביעים [3]"],
            "confidence": "high",
        }
        base.update(over)
        return base

    def test_uncited_likely_questions_are_dropped(self):
        brief = meeting_brief._clean(self._brief(), n_sources=4, n_web=4)
        self.assertEqual(brief["likely_questions_en"], ["Reverse a linked list [3]"])
        self.assertEqual(brief["role_en"], ["Embedded C++ [2]"])

    def test_the_new_sections_count_toward_confidence(self):
        brief = meeting_brief._clean(self._brief(), n_sources=4, n_web=4)
        self.assertEqual(brief["dropped_bullets"], 3)
        self.assertEqual(brief["confidence"], "low")

    def test_her_own_email_cannot_back_a_reported_question(self):
        """Source 5 is 'Your email: …'. A recruiter's mail is not evidence that
        candidates are asked something."""
        brief = meeting_brief._clean(self._brief(
            likely_questions_en=["Reverse a list [5]", "Reverse a list too [3,5]"],
        ), n_sources=5, n_web=4)
        self.assertEqual(brief["likely_questions_en"], ["Reverse a list too [3,5]"])

    def test_the_sections_are_capped(self):
        many = [f"q{i} [1]" for i in range(9)]
        brief = meeting_brief._clean(self._brief(likely_questions_en=many, prep_en=many, role_en=many),
                                     n_sources=2, n_web=2)
        self.assertEqual(len(brief["likely_questions_en"]), 5)
        self.assertEqual(len(brief["prep_en"]), 3)
        self.assertEqual(len(brief["role_en"]), 3)

    def test_a_plain_brief_grows_no_interview_keys(self):
        brief = meeting_brief._clean({"company_en": ["a [1]"], "company_he": []}, n_sources=1, n_web=1)
        self.assertNotIn("likely_questions_en", brief)

    def test_an_empty_section_is_named(self):
        brief = {"role_he": ["x"], "role_en": [], "likely_questions_he": [], "likely_questions_en": [],
                 "prep_he": [], "prep_en": ["step"]}
        self.assertEqual(meeting_brief._missing(brief), ["likely_questions"])


class FakeModel:
    """ai_gate.client() stand-in returning one canned JSON answer."""

    def __init__(self, payload: dict):
        self.payload = payload
        self.prompts: list[dict] = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kw):
        self.prompts.append(kw)
        msg = SimpleNamespace(content=json.dumps(self.payload))
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None)


GOOD = {
    "headline_he": "ראיון טכני ברפאל", "headline_en": "Technical interview at Rafael",
    "company_he": ["חברת ביטחון [1]"], "company_en": ["Defense company [1]"],
    "role_he": ["פיתוח תוכנה [3]"], "role_en": ["Software development [3]"],
    "likely_questions_he": ["הפוך רשימה מקושרת [2]", "תכנן מערכת בזמן אמת"],
    "likely_questions_en": ["Reverse a linked list [2]", "Design a real-time system"],
    "prep_he": ["חזור על מבני נתונים [2]"], "prep_en": ["Revise data structures [2]"],
    "questions_he": ["a", "b", "c"], "questions_en": ["a", "b", "c"],
    "confidence": "medium",
}


class BuildTests(unittest.TestCase):
    def _build(self, event=RAFAEL, payload=GOOD, search=None, configured=True):
        model = FakeModel(payload)
        store: dict = {}
        with mock.patch.object(meeting_brief.tavily_search, "is_configured", lambda: configured), \
                mock.patch.object(meeting_brief.tavily_search, "search", search or FakeSearch()), \
                mock.patch.object(meeting_brief.ai_gate, "client", lambda: model), \
                mock.patch.object(meeting_brief, "_load", lambda: store), \
                mock.patch.object(meeting_brief, "_save", lambda d: store.update(d)):
            res = asyncio.run(meeting_brief.build(event, "user-a"))
        return res, model, store

    def test_the_real_event_now_gets_a_brief(self):
        res, _model, _ = self._build()
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["interview"])
        self.assertEqual(res["subjects"]["company"], "רפאל")

    def test_uncited_questions_are_dropped_from_the_returned_brief(self):
        res, _m, _ = self._build()
        self.assertEqual(res["likely_questions_en"], ["Reverse a linked list [2]"])
        self.assertEqual(res["likely_questions_he"], ["הפוך רשימה מקושרת [2]"])
        self.assertEqual(res["prep_en"], ["Revise data structures [2]"])
        self.assertEqual(res["role_en"], ["Software development [3]"])

    def test_the_model_is_told_it_is_an_interview_and_gets_the_venue(self):
        _res, model, _ = self._build()
        system = model.prompts[0]["messages"][0]["content"]
        user = model.prompts[0]["messages"][1]["content"]
        self.assertIn("INTERVIEW MODE", system)
        self.assertIn("likely_questions_", system)
        self.assertIn("WHERE: רפאל מכון דוד", user)
        self.assertIn("EMPLOYER GUESSED FROM THE VENUE: yes", user)

    def test_a_plain_meeting_gets_the_plain_prompt(self):
        event = {"id": "m1", "title": "Call with Directeam", "description": "Meeting with Yuval Shitrit (CTO)"}
        payload = {"headline_en": "h", "company_en": ["x [1]"], "company_he": [],
                   "questions_en": [], "questions_he": []}
        res, model, _ = self._build(event, payload)
        self.assertTrue(res["ok"], res)
        self.assertNotIn("INTERVIEW MODE", model.prompts[0]["messages"][0]["content"])
        self.assertNotIn("missing", res)

    def test_an_empty_section_is_named_not_left_to_look_like_a_bug(self):
        payload = {**GOOD, "likely_questions_he": [], "likely_questions_en": ["Guess what [99]"]}
        res, _m, _ = self._build(payload=payload)
        self.assertTrue(res["ok"])
        self.assertEqual(res["missing"], ["likely_questions"])

    def test_nothing_cited_is_a_reason_not_an_empty_brief(self):
        payload = {"headline_he": "ה", "headline_en": "h", "company_en": ["x"], "company_he": ["y"],
                   "likely_questions_en": ["q"], "likely_questions_he": ["q"],
                   "role_en": [], "role_he": [], "prep_en": [], "prep_he": [],
                   "questions_en": ["a"], "questions_he": ["a"]}
        res, _m, store = self._build(payload=payload)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "nothing_cited")
        self.assertEqual(store, {})          # a refusal is not cached for a week

    def test_the_brief_is_cached_with_its_version(self):
        _res, _m, store = self._build()
        row = store["user-a"]["evt-rafael"]
        self.assertEqual(row["v"], meeting_brief._VERSION)


class ReasonTests(unittest.TestCase):
    """Every way of having no brief says why (silent-state rule 1/3)."""

    def test_an_interview_with_no_employer_says_no_company(self):
        called = []
        with mock.patch.object(meeting_brief.tavily_search, "search", lambda *a, **k: called.append(1)):
            res = asyncio.run(meeting_brief.build(
                {"id": "e", "title": "koral Technical Interview", "location": "Zoom"}, "user-a"))
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "no_company")
        self.assertEqual(called, [])         # and it cost nothing

    def test_a_gym_session_is_still_nothing_to_research(self):
        res = asyncio.run(meeting_brief.build({"id": "g", "title": "אימון", "location": "Space Gym"}, "u"))
        self.assertEqual(res["reason"], "nothing_to_research")

    def test_search_unavailable_is_search_not_configured(self):
        with mock.patch.object(meeting_brief.tavily_search, "is_configured", lambda: False):
            res = asyncio.run(meeting_brief.build(RAFAEL, "user-a"))
        self.assertEqual(res["reason"], "search_not_configured")

    def test_searches_that_all_fail_are_search_failed_not_no_sources(self):
        with mock.patch.object(meeting_brief.tavily_search, "is_configured", lambda: True), \
                mock.patch.object(meeting_brief.tavily_search, "search", FakeSearch(fail="rate_limited")):
            res = asyncio.run(meeting_brief.build(RAFAEL, "user-a"))
        self.assertEqual(res["reason"], "search_failed")

    def test_an_empty_web_is_no_sources(self):
        with mock.patch.object(meeting_brief.tavily_search, "is_configured", lambda: True), \
                mock.patch.object(meeting_brief.tavily_search, "search", FakeSearch(per_query=0)):
            res = asyncio.run(meeting_brief.build(RAFAEL, "user-a"))
        self.assertEqual(res["reason"], "no_sources")


class CacheVersionTests(unittest.TestCase):
    def test_a_v1_brief_is_refetched(self):
        store = {"user-a": {"evt": {"brief": {"headline_en": "old"}, "fetched_at": __import__("time").time()}}}
        with mock.patch.object(meeting_brief, "_load", lambda: store):
            self.assertIsNone(meeting_brief._cache_read("user-a", "evt"))

    def test_a_current_brief_is_served(self):
        store = {"user-a": {"evt": {"brief": {"headline_en": "new"}, "fetched_at": __import__("time").time(),
                                    "v": meeting_brief._VERSION}}}
        with mock.patch.object(meeting_brief, "_load", lambda: store):
            self.assertEqual(meeting_brief._cache_read("user-a", "evt"), {"headline_en": "new"})

    def test_a_brief_about_another_employer_is_not_served_after_the_venue_changes(self):
        cached = {"headline_en": "Elbit", "subjects": {"company": "אלביט"}}
        self.assertFalse(meeting_brief._cache_matches(cached, meeting_brief.subjects(RAFAEL)))
        self.assertTrue(meeting_brief._cache_matches({"headline_en": "x"}, meeting_brief.subjects(RAFAEL)))



class TypedInterviewTitleTests(unittest.TestCase):
    """29.10: "I have an interview for AI Engineer in Nebuis on" — no organiser,
    no venue name, so the card said "why none?". The employer is in her words."""

    def _s(self, title, location="4, Yitzhak Sadeh Street, Tel Aviv-Yafo"):
        return meeting_brief.subjects({"title": title, "location": location})

    def test_her_title(self):
        s = self._s("I have an interview for AI Engineer in Nebuis on")
        self.assertEqual(s["company"], "Nebuis")
        self.assertEqual(s["role"], "AI Engineer")

    def test_hebrew_title(self):
        s = self._s("ראיון לתפקיד מפתחת בוויקס")
        self.assertEqual(s["name_en"], "Wix")
        self.assertEqual(self._s("ראיון בNebius")["company"], "Nebius")

    def test_a_city_or_a_day_is_not_an_employer(self):
        for t in ("interview in Tel Aviv", "Job interview in Monday", "ראיון בחיפה",
                  "ראיון בשבוע הבא", "ראיון בבאר שבע", "interview in Person"):
            self.assertEqual(self._s(t)["company"], "", t)


if __name__ == "__main__":
    unittest.main()
