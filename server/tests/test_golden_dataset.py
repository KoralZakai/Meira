"""The golden dataset (evals/datasets/golden.jsonl) stays well-formed — see evals/GOLDEN.md."""
import json
import os
import re
import unittest

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "evals", "datasets", "golden.jsonl")
STATUSES = {"draft", "approved", "rejected"}


def _rows():
    with open(PATH, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class GoldenDatasetTests(unittest.TestCase):
    def test_every_case_is_complete(self):
        for row in _rows():
            with self.subTest(row.get("id")):
                self.assertRegex(row["id"], r"^g\d{3}$")
                self.assertIn(row["status"], STATUSES)
                self.assertTrue(row.get("area"))
                self.assertTrue(row.get("origin"))
                self.assertTrue(row.get("must_not"), "a case must name the wrong reaction")
                self.assertTrue(row["turns"])
                for turn in row["turns"]:
                    self.assertTrue(turn.get("user"))
                    self.assertTrue(turn.get("meira"), "what Meira DOES is the checked part")

    def test_ids_are_unique(self):
        ids = [row["id"] for row in _rows()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_bug_cases_say_when(self):
        # A case born from a bug names its date, so the history can be traced back.
        for row in _rows():
            if row["origin"].startswith("bug "):
                with self.subTest(row["id"]):
                    self.assertTrue(re.search(r"\d", row["origin"]) or "fix" in row["origin"],
                                    row["origin"])


if __name__ == "__main__":
    unittest.main()
