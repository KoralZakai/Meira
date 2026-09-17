"""meeting_brief — who we research, and what we refuse to say.

The load-bearing guarantees:
  * a personal errand triggers NO search and NO model call;
  * a scheduling-tool sender ("comeet-notifications.com") is never mistaken
    for the company we are meeting;
  * a bullet that cites nothing, or cites a source we never fetched, is
    dropped — an invented fact about a person you are about to meet is worse
    than no fact at all;
  * one person's cached brief is never served to another. Two users can hold
    the same calendar event id, and which meetings someone has is personal
    even when every fact in the brief came off a public page.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import meeting_brief  # noqa: E402

CEVA = {
    "id": "evt-ceva",
    "title": "Your phone interview with Ceva",
    "date": "2026-09-17", "time": "11:00",
    "organizer": "scheduler@comeet-notifications.com",
    "description": ("Position:C++ Software Engineer – AI & DSP Processor Simulators\n"
                    "Interview with Marika Klubakov (Core Simulator and Debugger Team Leader)"),
}


class SubjectTests(unittest.TestCase):
    def test_pulls_company_person_and_role_from_an_ats_invite(self):
        s = meeting_brief.subjects(CEVA)
        self.assertEqual(s["company"], "Ceva")
        self.assertEqual(s["person"], "Marika Klubakov")
        self.assertIn("Core Simulator", s["person_role"])
        self.assertIn("C++", s["role_title"])

    def test_the_scheduling_tool_is_never_the_company(self):
        """comeet-notifications.com sent the mail; it is not who we are meeting."""
        s = meeting_brief.subjects(CEVA)
        self.assertNotIn("comeet", s["company"].lower())

    def test_a_personal_gmail_organiser_identifies_nobody(self):
        s = meeting_brief.subjects({"title": "Gym", "organizer": "someone@gmail.com"})
        self.assertEqual(s["company"], "")
        self.assertEqual(s["person"], "")


class SkipTests(unittest.TestCase):
    def test_an_errand_costs_no_search_and_no_model_call(self):
        called = []
        with mock.patch.object(meeting_brief.tavily_search, "search",
                               lambda *a, **k: called.append(1)):
            res = asyncio.run(meeting_brief.build({"id": "e1", "title": "אימון בחדר כושר"}, "user-a"))
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "nothing_to_research")
        self.assertEqual(called, [])

    def test_it_says_so_when_search_is_unconfigured(self):
        with mock.patch.object(meeting_brief.tavily_search, "is_configured", lambda: False):
            res = asyncio.run(meeting_brief.build(CEVA, "user-a", force=True))
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "search_not_configured")


class CitationTests(unittest.TestCase):
    def test_uncited_and_out_of_range_bullets_are_dropped(self):
        brief = meeting_brief._clean({
            "company_en": ["Sells processor IP [1]",
                           "Revenue tripled last quarter",      # no citation
                           "Founded on Mars [9]"],              # source 9 never existed
            "company_he": ["מוכרת IP של מעבדים [1]"],
            "person_en": [], "person_he": [],
            "confidence": "high",
        }, n_sources=3)
        self.assertEqual(brief["company_en"], ["Sells processor IP [1]"])
        self.assertEqual(brief["dropped_bullets"], 2)
        self.assertEqual(brief["confidence"], "high")  # 2 dropped is not yet "low"

    def test_many_dropped_bullets_downgrade_confidence(self):
        brief = meeting_brief._clean({
            "company_en": ["a", "b", "c", "d [1]"],
            "company_he": [], "person_en": [], "person_he": [],
            "confidence": "high",
        }, n_sources=2)
        self.assertEqual(brief["confidence"], "low")


class CacheTests(unittest.TestCase):
    def test_a_cached_brief_skips_the_network_entirely(self):
        cached = {"headline_en": "known", "sources": []}
        called = []
        with mock.patch.object(meeting_brief, "_cache_read", lambda _u, _id: cached), \
                mock.patch.object(meeting_brief.tavily_search, "search",
                                  lambda *a, **k: called.append(1)):
            res = asyncio.run(meeting_brief.build(CEVA, "user-a"))
        self.assertTrue(res["ok"])
        self.assertTrue(res["cached"])
        self.assertEqual(called, [])

    def test_force_ignores_the_cache(self):
        with mock.patch.object(meeting_brief, "_cache_read", lambda _u, _id: {"headline_en": "stale"}), \
                mock.patch.object(meeting_brief.tavily_search, "is_configured", lambda: False):
            res = asyncio.run(meeting_brief.build(CEVA, "user-a", force=True))
        self.assertFalse(res["ok"])   # went past the cache and hit the real path


class IsolationTests(unittest.TestCase):
    def test_one_users_brief_is_never_served_to_another(self):
        store: dict = {}
        with mock.patch.object(meeting_brief, "_load", lambda: store), \
                mock.patch.object(meeting_brief, "_save", lambda d: store.update(d)):
            meeting_brief._cache_write("user-a", "shared-event-id", {"headline_en": "A's brief"})
            self.assertIsNotNone(meeting_brief._cache_read("user-a", "shared-event-id"))
            self.assertIsNone(meeting_brief._cache_read("user-b", "shared-event-id"))

    def test_the_store_is_shaped_for_account_deletion(self):
        """purge_local_stores drops data[user_key] — so the top level must be
        the user key, or deletion silently removes nothing."""
        store: dict = {}
        with mock.patch.object(meeting_brief, "_load", lambda: store), \
                mock.patch.object(meeting_brief, "_save", lambda d: store.update(d)):
            meeting_brief._cache_write("user-a", "e1", {"headline_en": "x"})
        self.assertIn("user-a", store)
        self.assertIn("e1", store["user-a"])


class GmailHistoryTests(unittest.TestCase):
    """Koral, 2026-09-17: "collect data from Gmail — if they had a conversation
    there, remind what they talked about."

    The web can say what Ceva builds. Only her mailbox knows what she and this
    team leader already agreed, and that is what she actually needs in the
    first minute of the call.
    """

    def test_her_own_email_becomes_a_numbered_source(self):
        rows = meeting_brief._history_sources({"history": [
            {"date": "Mon, 15 Sep 2026", "subject": "DSP C++ role — next steps",
             "from": "lead@ceva.com", "snippet": "Happy to talk Thursday. Send your CV."},
        ]})
        self.assertEqual(len(rows), 1)
        self.assertIn("DSP C++ role", rows[0]["title"])
        self.assertIn("Send your CV", rows[0]["snippet"])

    def test_it_never_offers_a_link_into_her_mailbox(self):
        rows = meeting_brief._history_sources({"history": [
            {"subject": "s", "snippet": "x"}]})
        self.assertEqual(rows[0]["link"], "")

    def test_it_is_capped_so_a_brief_is_not_a_thread_export(self):
        rows = meeting_brief._history_sources({"history": [
            {"subject": f"s{i}", "snippet": "x" * 5000} for i in range(50)]})
        self.assertLessEqual(len(rows), meeting_brief._MAX_HISTORY)
        self.assertLessEqual(len(rows[0]["snippet"]), meeting_brief._MAX_HISTORY_CHARS)

    def test_no_history_is_not_an_error(self):
        for event in ({}, {"history": None}, {"history": []}, {"history": "nope"}):
            self.assertEqual(meeting_brief._history_sources(event), [])

    def test_an_empty_row_contributes_nothing(self):
        """A message with neither a subject nor a snippet is not a memory of a
        conversation — it is a source the model could cite for anything."""
        self.assertEqual(
            meeting_brief._history_sources({"history": [{"date": "x", "from": "y"}]}), [])

    def test_history_bullets_obey_the_same_citation_rule(self):
        """A bullet about what they last agreed must cite its source exactly
        like a bullet about the company. An uncited one is dropped, not
        softened — an invented past conversation is worse than none."""
        cleaned = meeting_brief._clean({
            "history_en": ["You agreed to send the CV [1]", "He liked your thesis"],
            "history_he": ["סוכם שתשלחי קורות חיים [1]"],
        }, 1)
        self.assertEqual(cleaned["history_en"], ["You agreed to send the CV [1]"])
        self.assertEqual(len(cleaned["history_he"]), 1)


if __name__ == "__main__":
    unittest.main()
