"""Deterministic date resolution + the task-date override that feeds it.

Guards the bug where the model wrote '24.7' for the day after 26.7: the task
landed in the PAST, every `date >= today` path dropped it, and the route
planner silently fell back to the model inventing a route.
"""
import unittest
from datetime import date

import main
from tz import resolve_date


SUN = date(2026, 7, 26)  # a Sunday


class ResolveDateTests(unittest.TestCase):
    def test_hebrew_relative(self):
        self.assertEqual(resolve_date("מחר", SUN), date(2026, 7, 27))
        self.assertEqual(resolve_date("מחרתיים", SUN), date(2026, 7, 28))
        self.assertEqual(resolve_date("היום", SUN), SUN)
        self.assertEqual(resolve_date("בעוד 3 ימים", SUN), date(2026, 7, 29))

    def test_english_relative(self):
        self.assertEqual(resolve_date("tomorrow", SUN), date(2026, 7, 27))
        self.assertEqual(resolve_date("in 2 days", SUN), date(2026, 7, 28))
        self.assertEqual(resolve_date("next week", SUN), date(2026, 8, 2))

    def test_longest_form_wins(self):
        # 'מחרתיים' contains 'מחר' — must not resolve to tomorrow.
        self.assertEqual(resolve_date("מחרתיים בבוקר", SUN), date(2026, 7, 28))

    def test_explicit_day_month_rolls_to_next_year_when_past(self):
        self.assertEqual(resolve_date("29.7", SUN), date(2026, 7, 29))
        self.assertEqual(resolve_date("24.7", SUN), date(2027, 7, 24))

    def test_weekday_is_next_occurrence(self):
        self.assertEqual(resolve_date("יום שני", SUN), date(2026, 7, 27))
        self.assertEqual(resolve_date("monday", SUN), date(2026, 7, 27))

    def test_unparseable(self):
        self.assertIsNone(resolve_date("sometime soon", SUN))


class OverrideTaskDateTests(unittest.TestCase):
    def test_hallucinated_date_is_corrected(self):
        task = {"text": "תור לרופא", "date": "2026-07-24", "fixed_time": "11:40"}
        fixed = main._override_task_date(task, "מחר תור לרופא ב 11:40 בחולון")
        self.assertEqual(fixed["date"], resolve_date("מחר").isoformat())

    def test_no_relative_expression_leaves_task_alone(self):
        task = {"text": "gym", "date": "2026-08-01"}
        self.assertEqual(main._override_task_date(task, "gym at eight")["date"],
                         "2026-08-01")

    def test_multi_date_message_is_not_flattened(self):
        # Two expressions → per-task dates stay the model's.
        task = {"text": "ראיון", "date": "2026-07-30"}
        out = main._override_task_date(task, "מחר חדר כושר, ביום חמישי ראיון")
        self.assertEqual(out["date"], "2026-07-30")


class RouteModeTests(unittest.TestCase):
    def test_defaults_to_rail_so_both_options_are_offered(self):
        self.assertEqual(main._route_mode("תור לרופא בחולון"), ("train", "rail"))

    def test_explicit_modes(self):
        self.assertEqual(main._route_mode("איזה אוטובוס לקחת"), ("bus", "bus"))
        self.assertEqual(main._route_mode("I'll drive"), ("car", None))
        self.assertEqual(main._route_mode("באופניים"), ("bike", None))

    def test_car_prefixes_do_not_swallow_bus_and_train(self):
        # 'אוטו' ⊂ 'אוטובוס', 'רכב' ⊂ 'רכבת' — these must NOT be car.
        self.assertEqual(main._route_mode("אוטובוס"), ("bus", "bus"))
        self.assertEqual(main._route_mode("ברכבת"), ("train", "rail"))
        self.assertEqual(main._route_mode("ברכב"), ("car", None))
        self.assertEqual(main._route_mode("באוטו"), ("car", None))


class ModelRouteStripTests(unittest.TestCase):
    def test_strips_the_exact_fabricated_lines(self):
        text = "\n".join([
            "נמצאה משימה: תור לרופא ב 11:40",
            "📍 מוצא: מורדי הגטאות 23, תל אביב",
            "📍 יעד: מרכז בריאות האישה חולון",
            "טרם נמצאו נתיבי תחבורה ציבורית רלוונטיים. אנא נסה שוב מאוחר יותר.",
            "רוצה שאחשב מסלול מדויק בזמן אמת? 🚆",
        ])
        kept = [ln for ln in text.split("\n") if not main._MODEL_ROUTE_RE.search(ln)]
        self.assertEqual(kept, ["נמצאה משימה: תור לרופא ב 11:40"])


if __name__ == "__main__":
    unittest.main()
