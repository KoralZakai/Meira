"""model_router — tier by job size, tier by money left.

The two rules that must never regress:
  * a prompt too big for a tier escalates rather than being truncated;
  * spend past the budget downshifts rather than going dark.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import model_router  # noqa: E402


class TierDefaultsTests(unittest.TestCase):
    def test_extraction_runs_small_and_chat_runs_medium(self):
        self.assertEqual(model_router.pick("task_extract"), model_router.MODELS["small"])
        self.assertEqual(model_router.pick("chat"), model_router.MODELS["medium"])

    def test_unknown_source_defaults_to_medium(self):
        self.assertEqual(model_router.pick("something_new"), model_router.MODELS["medium"])


class TokenEscalationTests(unittest.TestCase):
    def test_prompt_that_overflows_small_escalates(self):
        chars = int(model_router.CONTEXT["small"] * model_router._CHARS_PER_TOKEN) + 10_000
        self.assertEqual(model_router.pick("task_extract", prompt_chars=chars),
                         model_router.MODELS["medium"])

    def test_prompt_that_overflows_medium_reaches_large(self):
        chars = int(model_router.CONTEXT["medium"] * model_router._CHARS_PER_TOKEN) + 10_000
        self.assertEqual(model_router.pick("chat", prompt_chars=chars),
                         model_router.MODELS["large"])

    def test_it_never_climbs_past_large(self):
        """Beyond the biggest context there is nowhere to go — we still return a
        model rather than raising, and the provider reports the overflow."""
        self.assertEqual(model_router.pick("research", prompt_chars=10**9),
                         model_router.MODELS["large"])


class BudgetTests(unittest.TestCase):
    @staticmethod
    def _spent(usd):
        return {"month": {"est_cost_usd": usd}}

    def test_no_budget_means_no_downshift(self):
        with mock.patch.object(model_router.config, "LLM_MONTHLY_BUDGET_USD", 0):
            self.assertEqual(model_router.pick("research"), model_router.MODELS["large"])

    def test_soft_limit_withdraws_the_large_tier(self):
        import llm_usage
        with mock.patch.object(model_router.config, "LLM_MONTHLY_BUDGET_USD", 10.0), \
                mock.patch.object(model_router.config, "LLM_BUDGET_SOFT_PCT", 0.8), \
                mock.patch.object(llm_usage, "summary", lambda: self._spent(8.5)):
            self.assertEqual(model_router.pick("research"), model_router.MODELS["medium"])

    def test_over_budget_forces_small_but_still_answers(self):
        import llm_usage
        with mock.patch.object(model_router.config, "LLM_MONTHLY_BUDGET_USD", 10.0), \
                mock.patch.object(llm_usage, "summary", lambda: self._spent(12.0)):
            self.assertEqual(model_router.pick("chat"), model_router.MODELS["small"])
            self.assertEqual(model_router.pick("research"), model_router.MODELS["small"])

    def test_a_broken_ledger_never_blocks_a_reply(self):
        """Accounting is not allowed to gate the assistant: if spend can't be
        read we assume unlimited rather than refusing or downshifting."""
        import llm_usage

        def _boom():
            raise RuntimeError("ledger unreadable")

        with mock.patch.object(model_router.config, "LLM_MONTHLY_BUDGET_USD", 10.0), \
                mock.patch.object(llm_usage, "summary", _boom):
            self.assertEqual(model_router.pick("research"), model_router.MODELS["large"])

    def test_budget_beats_token_escalation(self):
        """A huge prompt must not buy its way past the budget ceiling."""
        import llm_usage
        chars = int(model_router.CONTEXT["medium"] * model_router._CHARS_PER_TOKEN) + 10_000
        with mock.patch.object(model_router.config, "LLM_MONTHLY_BUDGET_USD", 10.0), \
                mock.patch.object(llm_usage, "summary", lambda: self._spent(12.0)):
            self.assertEqual(model_router.pick("chat", prompt_chars=chars),
                             model_router.MODELS["small"])


if __name__ == "__main__":
    unittest.main()
