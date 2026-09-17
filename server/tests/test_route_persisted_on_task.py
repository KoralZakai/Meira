"""A route Lumi computes must land ON the task, not only in the reply.

The yoga task created over WhatsApp was stored as:

    location = 'יגאל אלון 94'        <- a bare string

No coordinates, no transitPlan, no leaveHomeBy, no wakeUpBy. The AUTO-ROUTE in
main.py did compute a real Google route for it — but that plan only fed the
reminder scheduler and the reply text. The task itself kept the address string
the model extracted, so the app had to re-plan the whole trip on next open, and
until it did there was no leave alarm at all.

_location_from_departure already builds the exact TaskLocation shape the app
reads; nothing on this path was calling it.
"""
import unittest

from lumi_agent import _location_from_departure


def _plan():
    """A geo.plan_departure result, in its internal leg shape."""
    return {
        "destination": "יגאל אלון 94",
        "destResolved": "יגאל אלון 94, תל אביב-יפו",
        "lat": 32.0705, "lng": 34.7925,
        "travelMinutes": 17,
        "leaveHomeBy": "10:43",
        "arriveBy": "11:00",
        "wakeUpBy": "09:48",
        "legs": [
            {"type": "walk", "from": "home", "to": "ארלוזורוב",
             "minutes": 4, "departTime": "10:43", "arriveTime": "10:47"},
            {"type": "bus", "from": "ארלוזורוב", "to": "יגאל אלון", "line": "189",
             "minutes": 9, "departTime": "10:51", "arriveTime": "11:00"},
        ],
    }


class LocationShapeTests(unittest.TestCase):
    def test_the_app_gets_an_object_not_a_bare_string(self):
        loc = _location_from_departure(_plan())
        self.assertIsInstance(loc, dict)
        self.assertEqual(loc["address"], "יגאל אלון 94")

    def test_the_backward_times_are_present(self):
        # These are the whole product: when to get up, when to walk out.
        loc = _location_from_departure(_plan())
        self.assertEqual(loc["leaveHomeBy"], "10:43")
        self.assertEqual(loc["wakeUpBy"], "09:48")
        self.assertEqual(loc["travelMinutes"], 17)

    def test_coordinates_survive(self):
        loc = _location_from_departure(_plan())
        self.assertAlmostEqual(loc["lat"], 32.0705)
        self.assertAlmostEqual(loc["lng"], 34.7925)

    def test_the_legs_are_translated_to_the_apps_shape(self):
        # geo's keys (minutes/departTime/line) are not the app's
        # (durationMinutes/departureTime/lineNumber) — TaskDetail renders
        # nothing if they arrive untranslated.
        legs = _location_from_departure(_plan())["transitPlan"]["legs"]
        self.assertEqual(len(legs), 2)
        walk, bus = legs
        self.assertEqual(walk["type"], "walk")
        self.assertEqual(walk["durationMinutes"], 4)
        self.assertEqual(bus["type"], "bus")
        self.assertEqual(bus["lineNumber"], "189")
        self.assertEqual(bus["departureTime"], "10:51")
        self.assertEqual(bus["arrivalTime"], "11:00")

    def test_the_first_ride_is_summarised_for_the_alert(self):
        tp = _location_from_departure(_plan())["transitPlan"]
        self.assertEqual(tp["firstBusDeparture"], "10:51")
        self.assertEqual(tp["firstBusStop"], "ארלוזורוב")
        self.assertEqual(tp["walkToStopMinutes"], 4)
        self.assertEqual(tp["leaveHomeAt"], "10:43")
        self.assertEqual(tp["arriveAt"], "11:00")

    def test_rail_vehicle_types_map_onto_the_apps_union(self):
        plan = _plan()
        plan["legs"][1]["type"] = "heavy_rail"
        legs = _location_from_departure(plan)["transitPlan"]["legs"]
        self.assertEqual(legs[1]["type"], "train")

    def test_a_walk_only_trip_has_no_ride_and_still_works(self):
        plan = _plan()
        plan["legs"] = [{"type": "walk", "from": "home", "to": "יגאל אלון 94",
                         "minutes": 12, "departTime": "10:48", "arriveTime": "11:00"}]
        tp = _location_from_departure(plan)["transitPlan"]
        self.assertIsNone(tp["firstBusDeparture"])
        self.assertEqual(tp["walkToStopMinutes"], 12)

    def test_source_is_marked_google_so_it_is_not_mistaken_for_a_guess(self):
        self.assertEqual(_location_from_departure(_plan())["transitPlan"]["source"], "google")


if __name__ == "__main__":
    unittest.main()


class OriginAddressTests(unittest.TestCase):
    """The app decides staleness from transitPlan.originAddress.

    GoogleSync re-plans a trip whose recorded origin is not the previous stop in
    the day's chain. When the field was absent it fell back to assuming the plan
    started at home — true for server-made plans today, but agreement by luck
    rather than by record.
    """

    def test_the_origin_is_recorded_on_the_plan(self):
        plan = _plan()
        plan["originAddress"] = "בן יהודה 12, תל אביב"
        loc = _location_from_departure(plan)
        self.assertEqual(loc["transitPlan"]["originAddress"], "בן יהודה 12, תל אביב")

    def test_an_unstamped_plan_reports_no_origin_rather_than_a_wrong_one(self):
        # Older rows predate the field. None keeps the app on its documented
        # from-home fallback; inventing an address here would suppress a
        # re-plan that genuinely needs to happen.
        self.assertIsNone(_location_from_departure(_plan())["transitPlan"]["originAddress"])
