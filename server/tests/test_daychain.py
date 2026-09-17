"""The day is a chain: each trip starts where the previous one was.

The server used to route only the trips one message created, each from home.
So "gym at 18:00" then, in a later message, "party at 20:00" gave the party a
from-home leave time it could not possibly make — she is at the gym at 20:00,
not at home. And inserting an earlier task never shifted the leave time of the
later ones. This is what ensureTravelChain does on the phone; these tests pin
the same behaviour on the server.
"""
import unittest

import daychain as dc

HOME = "בית 1, תל אביב"


def trip(tid, time, addr, origin=None):
    loc = addr
    if origin is not None:
        loc = {"address": addr, "transitPlan": {"originAddress": origin}}
    return {"id": tid, "date": "2026-08-29", "fixed_time": time,
            "location": loc, "status": "pending"}


class ChainOrderTests(unittest.TestCase):
    def test_each_trip_starts_where_the_previous_one_was(self):
        tasks = [trip("party", "20:00", "פלורנטין 3"),
                 trip("gym", "18:00", "יגאל אלון 94")]
        chain = dc.day_chain(tasks, HOME, "2026-08-29")
        self.assertEqual([(t["id"], o) for t, o in chain],
                         [("gym", HOME), ("party", "יגאל אלון 94")])

    def test_the_first_trip_starts_at_home(self):
        chain = dc.day_chain([trip("a", "09:00", "מקום")], HOME, "2026-08-29")
        self.assertEqual(chain[0][1], HOME)

    def test_only_the_named_date_is_chained(self):
        tasks = [trip("today", "10:00", "A"),
                 {**trip("tmrw", "09:00", "B"), "date": "2026-08-30"}]
        chain = dc.day_chain(tasks, HOME, "2026-08-29")
        self.assertEqual([t["id"] for t, _ in chain], ["today"])

    def test_a_meeting_link_is_not_a_trip(self):
        tasks = [trip("zoom", "10:00", "https://zoom.us/j/123"),
                 trip("gym", "18:00", "יגאל אלון 94")]
        chain = dc.day_chain(tasks, HOME, "2026-08-29")
        self.assertEqual([t["id"] for t, _ in chain], ["gym"])
        # And the gym still starts at home, not at the zoom "address".
        self.assertEqual(chain[0][1], HOME)

    def test_a_task_with_no_time_is_not_a_trip(self):
        chain = dc.day_chain([{"id": "x", "date": "2026-08-29",
                               "location": "A", "status": "pending"}], HOME, "2026-08-29")
        self.assertEqual(chain, [])

    def test_a_completed_trip_is_left_out(self):
        tasks = [{**trip("done", "09:00", "A"), "status": "complete"},
                 trip("gym", "18:00", "B")]
        chain = dc.day_chain(tasks, HOME, "2026-08-29")
        self.assertEqual([t["id"] for t, _ in chain], ["gym"])


class ReplanDecisionTests(unittest.TestCase):
    def test_a_trip_with_no_route_must_be_planned(self):
        self.assertTrue(dc.needs_replan(trip("a", "10:00", "A"), HOME, HOME))

    def test_a_trip_whose_origin_still_matches_is_left_alone(self):
        t = trip("a", "10:00", "A", origin="יגאל אלון 94")
        self.assertFalse(dc.needs_replan(t, "יגאל אלון 94", HOME))

    def test_a_trip_whose_origin_changed_is_replanned(self):
        t = trip("a", "10:00", "A", origin=HOME)
        self.assertTrue(dc.needs_replan(t, "יגאל אלון 94", HOME))

    def test_an_old_plan_with_no_origin_is_left_if_the_chain_says_home(self):
        # Predates originAddress; home is what it would have assumed.
        t = {"id": "a", "date": "2026-08-29", "fixed_time": "10:00",
             "location": {"address": "A", "transitPlan": {"leaveHomeAt": "09:00"}},
             "status": "pending"}
        self.assertFalse(dc.needs_replan(t, HOME, HOME))
        self.assertTrue(dc.needs_replan(t, "יגאל אלון 94", HOME))


if __name__ == "__main__":
    unittest.main()
