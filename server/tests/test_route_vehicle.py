import unittest

from geo import _vehicle_of, format_route_message


class VehicleClassificationTests(unittest.TestCase):
    def test_feeder_bus_then_train_is_train(self):
        # Real Israeli trip: walk → feeder bus → train. First-leg logic called
        # this 'bus' and the rail filter dropped it (the reported mix).
        alt = {"legs": [
            {"type": "walk"}, {"type": "bus"}, {"type": "heavy_rail"},
        ]}
        self.assertEqual(_vehicle_of(alt), "train")

    def test_pure_bus_stays_bus(self):
        alt = {"legs": [{"type": "walk"}, {"type": "bus"}]}
        self.assertEqual(_vehicle_of(alt), "bus")

    def test_rail_filter_excludes_pure_bus(self):
        plan = {
            "alternatives": [
                {"legs": [{"type": "bus"}], "leaveBy": "08:00", "arriveAt": "09:00"},
                {"legs": [{"type": "bus"}, {"type": "train"}], "leaveBy": "08:10", "arriveAt": "09:00"},
            ],
            "startResolved": "A", "destResolved": "B", "arriveBy": "09:00",
        }
        msg = format_route_message(plan, pref="rail", lang="en")
        self.assertEqual(msg.count("Option"), 1)  # pure bus filtered out
        self.assertIn("🚆", msg)  # the surviving option is the train
        self.assertNotIn("No direct train", msg)  # a real train existed — no fallback

    def test_no_train_says_so_instead_of_silent_mix(self):
        plan = {
            "alternatives": [{"legs": [{"type": "bus"}], "routeText": "BUS", "leaveBy": "08:00", "arriveAt": "09:00"}],
            "startResolved": "A", "destResolved": "B", "arriveBy": "09:00",
        }
        msg = format_route_message(plan, pref="rail", lang="en")
        self.assertIn("No direct train", msg)


if __name__ == "__main__":
    unittest.main()
