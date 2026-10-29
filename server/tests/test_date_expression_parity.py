"""The phone reads "ביום ראשון" / "20.10" / "8 באוקטובר" the way the server does.

The Add screen shows a date chip while she types (src/utils/dateExpression.ts,
17.10). A chip is only honest if it names the day the save will use, and the
save path resolves dates in tz.resolve_date. tests/fixtures/
date-expression-golden.json is generated FROM this file's resolver; the phone
half is tests/run-live-parse.ts, which reads the same fixture.

If this fails, the server's rule changed: regenerate the fixture on purpose
and make src/utils/dateExpression.ts agree — never edit one side to pass.
"""
import json
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tz  # noqa: E402

_FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures",
                        "date-expression-golden.json")


class DateExpressionGolden(unittest.TestCase):
    def test_fixture_is_what_the_server_says(self):
        with open(_FIXTURE, encoding="utf-8") as fh:
            fx = json.load(fh)
        today = date.fromisoformat(fx["today"])
        self.assertGreater(len(fx["cases"]), 30)
        for c in fx["cases"]:
            with self.subTest(text=c["text"]):
                got = tz.resolve_date(c["text"], today)
                self.assertEqual(got.isoformat() if got else None, c["date"])


if __name__ == "__main__":
    unittest.main()
