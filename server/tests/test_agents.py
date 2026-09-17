"""agents_store tests: next_fire schedule math, CRUD, cap, templates.

Each test redirects the store's _PATH to a temp file so agents.json on the
dev machine is never touched.
"""
import os
import tempfile
import unittest
from datetime import datetime

import agents_store
from agents_store import next_fire
from tz import IL


def _il(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=IL)


class NextFireTests(unittest.TestCase):
    def test_same_day_future_time(self):
        # Wednesday 2026-07-22 06:00 → Wed is weekday 2, 07:00 today.
        after = _il(2026, 7, 22, 6, 0)
        self.assertEqual(next_fire([2], "07:00", after), _il(2026, 7, 22, 7, 0))

    def test_past_time_rolls_to_next_selected_day(self):
        # Wed 08:00, schedule Wed 07:00 → next Wednesday.
        after = _il(2026, 7, 22, 8, 0)
        self.assertEqual(next_fire([2], "07:00", after), _il(2026, 7, 29, 7, 0))

    def test_il_weekend_wrap_fri_to_sun(self):
        # Fri 2026-07-24 10:00, schedule Sun-Thu [6,0,1,2,3] 07:00 → Sunday 26th.
        after = _il(2026, 7, 24, 10, 0)
        self.assertEqual(next_fire([6, 0, 1, 2, 3], "07:00", after), _il(2026, 7, 26, 7, 0))

    def test_dst_fall_back_keeps_local_time(self):
        # Israel DST ends Oct 25 2026. Fire the day after — still 07:00 local.
        after = _il(2026, 10, 25, 12, 0)
        nxt = next_fire([0], "07:00", after)  # Monday Oct 26
        self.assertEqual((nxt.year, nxt.month, nxt.day, nxt.hour), (2026, 10, 26, 7))
        self.assertEqual(nxt.utcoffset().total_seconds(), 2 * 3600)  # back to UTC+2

    def test_empty_days_none(self):
        self.assertIsNone(next_fire([], "07:00", _il(2026, 7, 22, 6, 0)))

    def test_bad_time_none(self):
        self.assertIsNone(next_fire([0], "7am", _il(2026, 7, 22, 6, 0)))

    def test_strictly_after(self):
        # `after` exactly at the slot → next week, never the same instant.
        after = _il(2026, 7, 22, 7, 0)
        self.assertEqual(next_fire([2], "07:00", after), _il(2026, 7, 29, 7, 0))


class StoreTests(unittest.TestCase):
    def setUp(self):
        fd, self._tmp = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(self._tmp)  # store handles missing file
        self._orig = agents_store._PATH
        agents_store._PATH = self._tmp

    def tearDown(self):
        agents_store._PATH = self._orig
        if os.path.exists(self._tmp):
            os.unlink(self._tmp)

    def test_create_list_update_delete(self):
        a = agents_store.create_agent(
            "9725551", name="Focus", soul="be strict", days=[0, 2], time="09:00",
            created_via="test")
        self.assertNotIn("error", a)
        self.assertTrue(a["id"].startswith("ag_"))
        self.assertIsNotNone(a["next_run"])  # precomputed
        self.assertEqual(agents_store.list_agents("9725551")[0]["name"], "Focus")
        self.assertEqual(agents_store.list_agents("other"), [])

        upd = agents_store.update_agent("9725551", a["id"], {"enabled": False})
        self.assertIsNone(upd["next_run"])  # disabled → no next fire
        upd = agents_store.update_agent("9725551", a["id"], {"enabled": True, "time": "10:30"})
        self.assertIn("10:30", upd["next_run"] or "")

        self.assertTrue(agents_store.delete_agent("9725551", a["id"]))
        self.assertFalse(agents_store.delete_agent("9725551", a["id"]))  # already gone

    def test_cap_five_per_user(self):
        for i in range(agents_store.MAX_AGENTS):
            r = agents_store.create_agent("972x", name=f"A{i}", soul="s",
                                          days=[0], time="09:00")
            self.assertNotIn("error", r)
        r = agents_store.create_agent("972x", name="A6", soul="s", days=[0], time="09:00")
        self.assertEqual(r.get("error"), "limit")
        # Other users unaffected by the cap.
        self.assertNotIn("error", agents_store.create_agent(
            "972y", name="B", soul="s", days=[0], time="09:00"))

    def test_template_install_prefills_and_dedups(self):
        a = agents_store.create_agent("972t", template="morning_planner",
                                      created_via="whatsapp")
        self.assertEqual(a["name"], "Morning Planner")
        self.assertEqual(a["emoji"], "🌅")
        self.assertEqual(a["schedule"]["days"], [0, 1, 2, 3, 6])
        self.assertTrue(a["soul"])
        dup = agents_store.create_agent("972t", template="morning_planner")
        self.assertEqual(dup.get("error"), "invalid")  # once per user
        self.assertEqual(
            agents_store.create_agent("972t", template="nope").get("error"), "invalid")

    def test_invalid_inputs(self):
        r = agents_store.create_agent("972i", name="X", soul="s", days=[9], time="09:00")
        self.assertEqual(r.get("error"), "invalid")  # day out of range filtered → empty
        r = agents_store.create_agent("972i", name="X", soul="s", days=[0], time="25:99")
        self.assertEqual(r.get("error"), "invalid")

    def test_due_and_mark_ran_advances(self):
        a = agents_store.create_agent("972d", name="D", soul="s",
                                      days=[0, 1, 2, 3, 4, 5, 6], time="07:00")
        # Force next_run into the past to simulate "due now".
        items = agents_store._load()
        items[0]["next_run"] = _il(2026, 7, 22, 7, 0).isoformat()
        agents_store._save(items)

        now = _il(2026, 7, 22, 7, 1)
        due = agents_store.due_agents(now)
        self.assertEqual([d["id"] for d in due], [a["id"]])

        agents_store.mark_ran(a["id"], now)
        after = agents_store.get_agent("972d", a["id"])
        self.assertEqual(after["run_count"], 1)
        # Daily schedule → advanced to tomorrow 07:00, no longer due.
        self.assertEqual(after["next_run"], _il(2026, 7, 23, 7, 0).isoformat())
        self.assertEqual(agents_store.due_agents(now), [])


if __name__ == "__main__":
    unittest.main()


class UsageLedgerTests(unittest.TestCase):
    def setUp(self):
        import llm_usage as lu
        self._lu = lu
        fd, self._tmp = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(self._tmp)
        self._orig = lu._PATH
        lu._PATH = self._tmp

    def tearDown(self):
        self._lu._PATH = self._orig
        if os.path.exists(self._tmp):
            os.unlink(self._tmp)

    def test_record_and_summary(self):
        self._lu.record("chat", 5000, 500)
        self._lu.record("chat", 5000, 500)
        self._lu.record("agent", 2000, 400)
        s = self._lu.summary()
        self.assertEqual(s["today"]["tokens_in"], 12000)
        self.assertEqual(s["today"]["tokens_out"], 1400)
        self.assertEqual(s["today"]["calls"], 3)
        self.assertEqual(s["today"]["by_source"]["chat"]["calls"], 2)
        self.assertGreaterEqual(s["month"]["tokens_in"], s["today"]["tokens_in"])
        if s["priced"]:
            self.assertGreater(s["today"]["est_cost_usd"], 0)

    def test_zero_tokens_not_recorded(self):
        self._lu.record("chat", 0, 0)
        self.assertEqual(self._lu.summary()["today"]["calls"], 0)
