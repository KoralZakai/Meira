"""user_quota — one person cannot spend everyone's AI budget.

7.10: Meira goes to people with many trips and meetings. Without a per-person
cap, one heavy tester could run the month's bill on their own. The rules that
must hold:
  * every recorded call is charged to the person it served, in dollars;
  * near the limit that person runs on the small tier, everyone else is untouched;
  * past it, the chat turn is not run and she is TOLD so — never a silent no;
  * the owner can be exempt.
"""
import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import llm_usage  # noqa: E402
import model_router  # noqa: E402
import user_quota  # noqa: E402

MEDIUM = model_router.MODELS["medium"]   # $0.30 in / $0.90 out per 1M


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [
            mock.patch.object(user_quota, "_PATH", os.path.join(self.tmp.name, "people.json")),
            mock.patch.object(llm_usage, "_PATH", os.path.join(self.tmp.name, "usage.json")),
            mock.patch("database_service.shadow_write"),
            mock.patch("database_service.record_usage", new=mock.MagicMock()),
            mock.patch("identity_keys.canonical", side_effect=lambda k: str(k)),
            mock.patch.dict(os.environ, {"USER_LLM_DAILY_USD": "0.10", "USER_LLM_MONTHLY_USD": "1.00",
                                         "USER_LLM_EXEMPT": "owner", "USER_LLM_FREE_SEATS": "0"}),
            mock.patch("config.LLM_MONTHLY_BUDGET_USD", 0),
        ]
        for p in self.patches:
            p.start()
        self.token = user_quota._current.set(None)

    def tearDown(self):
        user_quota._current.reset(self.token)
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def spend(self, person: str, usd: float):
        """Record medium-tier calls for `person` worth about `usd`."""
        user_quota.set_person(person)
        tokens_in = int(usd / 0.30 * 1_000_000)
        llm_usage.record("chat", tokens_in, 0, MEDIUM)


class Charging(Base):
    def test_a_recorded_call_is_charged_to_the_person_it_served(self):
        self.spend("dana", 0.03)
        day, month = user_quota.spent("dana")
        self.assertAlmostEqual(day, 0.03, places=4)
        self.assertAlmostEqual(month, 0.03, places=4)
        self.assertEqual(user_quota.spent("yossi"), (0.0, 0.0))

    def test_a_call_with_no_person_charges_nobody(self):
        llm_usage.record("chat", 100_000, 0, MEDIUM)
        self.assertEqual(user_quota.top(), [])


class Levels(Base):
    def test_under_the_soft_line_nothing_changes(self):
        self.spend("dana", 0.05)
        self.assertEqual(user_quota.state("dana")["level"], "ok")
        self.assertEqual(model_router.pick("chat"), MEDIUM)

    def test_near_the_limit_her_calls_run_small_and_others_do_not(self):
        self.spend("dana", 0.085)                       # 85% of the day
        self.assertEqual(user_quota.state("dana")["level"], "soft")
        self.assertEqual(model_router.pick("chat"), model_router.MODELS["small"])
        user_quota.set_person("yossi")
        self.assertEqual(model_router.pick("chat"), MEDIUM)

    def test_past_the_limit_she_is_over_and_told_when_it_resets(self):
        self.spend("dana", 0.12)
        st = user_quota.state("dana")
        self.assertEqual((st["level"], st["period"]), ("over", "day"))
        he = user_quota.blocked_reply("dana", "מה יש לי מחר?")
        self.assertIn("מכסת השיחה היומית", he)
        self.assertIn("ההתראות ממשיכים לעבוד", he)
        self.assertIn("Back tomorrow", user_quota.blocked_reply("dana", "what's tomorrow?"))

    def test_the_month_is_checked_too(self):
        with mock.patch.dict(os.environ, {"USER_LLM_DAILY_USD": "0"}):
            self.spend("dana", 1.2)
            st = user_quota.state("dana")
            self.assertEqual((st["level"], st["period"]), ("over", "month"))
            self.assertIn("1st", user_quota.blocked_reply("dana", "hi"))

    def test_the_owner_is_exempt(self):
        self.spend("owner", 5.0)
        self.assertEqual(user_quota.state("owner")["level"], "ok")
        self.assertIsNone(user_quota.blocked_reply("owner", "hi"))

    def test_zero_means_no_limit(self):
        with mock.patch.dict(os.environ, {"USER_LLM_DAILY_USD": "0", "USER_LLM_MONTHLY_USD": "0"}):
            self.spend("dana", 50.0)
            self.assertEqual(user_quota.state("dana")["level"], "ok")


class Gates(Base):
    def test_an_over_limit_turn_never_reaches_the_model(self):
        import agent_turn
        self.spend("dana", 0.2)
        with mock.patch.object(agent_turn, "handle_whatsapp_message") as agent:
            out = asyncio.run(agent_turn.run_turn("dana", "מה יש לי מחר?", {"id": "dana"}))
        agent.assert_not_called()
        self.assertEqual(out["quota"], "over")
        self.assertIn("מכסת השיחה", out["text"])
        self.assertEqual(out["tasks"], [])

    def test_whatsapp_is_gated_before_the_profile_extraction_call(self):
        import lumi_agent
        self.spend("dana", 0.2)
        with mock.patch.object(lumi_agent, "_extract_profile") as extract:
            out = asyncio.run(lumi_agent.handle_whatsapp_message("hi", {"id": "dana"}, None))
        extract.assert_not_called()
        self.assertEqual(out["quota"], "over")

    def test_admin_sees_who_is_spending(self):
        self.spend("dana", 0.12)
        self.spend("yossi", 0.02)
        top = user_quota.top()
        self.assertEqual([t["person"] for t in top], ["dana", "yossi"])
        self.assertEqual(top[0]["level"], "over")


    def test_deleting_the_account_deletes_her_counters(self):
        import account_deletion
        self.spend("dana", 0.05)
        self.spend("yossi", 0.05)
        with mock.patch.object(account_deletion, "_STORE_MODULES", ("user_quota",)):
            result = account_deletion.purge_local_stores("dana")
        self.assertEqual(result["user_quota"], "deleted")
        self.assertEqual(user_quota.spent("dana"), (0.0, 0.0))
        self.assertGreater(user_quota.spent("yossi")[0], 0)



class FreeSeats(Base):
    """7.10: the first 20 testers get Meira without limits — no cap, no cheaper model."""

    def test_the_first_people_have_no_limit_and_the_next_one_does(self):
        with mock.patch.dict(os.environ, {"USER_LLM_FREE_SEATS": "2"}):
            self.spend("dana", 0.5)          # 5x the daily limit
            self.spend("yossi", 0.09)
            self.spend("avi", 0.12)          # third person: no seat left
            self.assertEqual(user_quota.state("dana")["level"], "ok")
            self.assertIsNone(user_quota.blocked_reply("dana", "hi"))
            user_quota.set_person("yossi")
            self.assertEqual(model_router.pick("chat"), MEDIUM)   # never moved to small
            self.assertEqual(user_quota.state("avi")["level"], "over")

    def test_a_newcomer_takes_a_seat_while_seats_are_left(self):
        with mock.patch.dict(os.environ, {"USER_LLM_FREE_SEATS": "2"}):
            self.spend("dana", 0.01)
            self.assertTrue(user_quota.state("new-person").get("seat"))
            self.spend("yossi", 0.01)
            self.assertFalse(user_quota.state("new-person").get("seat"))

    def test_her_seat_survives_old_days_being_pruned(self):
        with mock.patch.dict(os.environ, {"USER_LLM_FREE_SEATS": "1"}):
            self.spend("dana", 0.01)
            data = user_quota._load()
            data["dana"] = {"_first": "2020-01-01"}           # every day pruned away
            user_quota._save(data)
            self.spend("yossi", 0.01)
            self.assertTrue(user_quota.state("dana").get("seat"))
            self.assertFalse(user_quota.state("yossi").get("seat"))


if __name__ == "__main__":
    unittest.main()
