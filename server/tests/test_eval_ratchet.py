"""thresholds.json is a ratchet: the findings the harness reported must not come back quietly.

The first offline matrix (15.10) measured hallucination 15.6%, graceful 79.3%,
a hung tool and 6 wrong categories - all YELLOW, because the thresholds were set
just beyond what was measured. After those were fixed the same numbers sit at
their ceiling (0% / 100% / 0 / 100%), and `fail` was moved to the target so a
single slip is RED (fails CI), not a yellow nobody opens.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TheRatchetHolds(unittest.TestCase):
    """thresholds.json must turn the findings above RED if they ever come back."""

    def test_each_old_finding_would_fail_the_build(self):
        from evals import report
        rules = report.load_thresholds()
        # (metric, the value the OLD behaviour measured on the offline matrix)
        for metric_id, old_value in [
            ("reliability.hallucination_rate", 5 / 32),      # 5 unbacked claims in 32 no-action turns
            ("reliability.timeout_rate", 1 / 56),            # the hung web_search
            ("reliability.graceful_rate", 0.793),            # 6 fault cases not handled
            ("accuracy.category", 48 / 54),                  # 6 of 54 labelled wrong
            ("accuracy.category_confident_wrong", 2 / 54),   # "דחוף"->leisure, "brunch"->gym
        ]:
            self.assertEqual(report.judge(old_value, rules[metric_id]), report.RED, metric_id)

    def test_a_single_slip_is_red_not_yellow(self):
        from evals import report
        rules = report.load_thresholds()
        self.assertEqual(report.judge(1 / 100, rules["reliability.hallucination_rate"]), report.RED)
        self.assertEqual(report.judge(1 / 100, rules["reliability.timeout_rate"]), report.RED)
        self.assertEqual(report.judge(53 / 54, rules["accuracy.category"]), report.RED)
        self.assertEqual(report.judge(0.0, rules["reliability.hallucination_rate"]), report.GREEN)
        self.assertEqual(report.judge(1.0, rules["accuracy.category"]), report.GREEN)


if __name__ == "__main__":
    unittest.main()
