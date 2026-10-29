"""group_time — find time together (Feature 3, 20.10).

What is pinned: free/busy comes from the member's OWN tasks only after she
joined; a manual answer wins; an unreadable day is ? never ✗; the organizer
never learns what the busy thing is, nor which contacts are on Meira; a
stranger gets not_found; lock adds the slot only to the yeses.

Supabase is an in-memory fake that understands eq./neq. filters.
"""
import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import group_time as gt  # noqa: E402

NOW = datetime(2026, 10, 21, 12, 0)
FRI, SAT = "2026-10-23", "2026-10-24"


def run(c):
    return asyncio.run(c)


class FakeDB:
    def __init__(self):
        self.t = {k: [] for k in ("lumi_groups", "lumi_group_members", "lumi_group_slots", "lumi_group_answers")}
        self.fail_reads = False

    def _match(self, row, params):
        for k, v in params.items():
            if k in ("select", "limit", "order"):
                continue
            v = str(v)
            if v.startswith("eq.") and str(row.get(k)) != v[3:]:
                return False
            if v.startswith("neq.") and str(row.get(k)) == v[4:]:
                return False
        return True

    async def get(self, table, params):
        if self.fail_reads:
            return None
        rows = [dict(r) for r in self.t[table] if self._match(r, params)]
        return rows[: int(params["limit"])] if "limit" in params else rows

    async def upsert(self, table, rows, on_conflict=None):
        keys = (on_conflict or "id").split(",")
        for r in rows:
            existing = next((x for x in self.t[table] if all(x.get(k) == r.get(k) for k in keys)), None)
            if existing:
                existing.update(r)
            else:
                self.t[table].append(dict(r))
        return True

    async def delete(self, table, params):
        self.t[table] = [r for r in self.t[table] if not self._match(r, params)]
        return True


class Base(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.links = {"972501111111": "dana-uid", "972502222222": "yossi-uid"}
        self.tasks = {"dana-uid": [{"date": FRI, "fixedTime": "19:30", "durationMinutes": 120,
                                    "text": "therapy", "status": "pending"}],
                      "yossi-uid": [], "owner-uid": []}
        self.pushed = []
        self.saved_tasks = []

        async def tasks(key, a, b):
            if key not in self.tasks:
                return None, "http_500"
            return self.tasks[key], None

        async def push(key, title, body):
            self.pushed.append(key)
            return True

        async def upsert_task(uid, task):
            self.saved_tasks.append((uid, task))
            return task["id"]

        for p in [
            mock.patch.object(gt.database_service, "_get", self.db.get),
            mock.patch.object(gt.database_service, "_upsert", self.db.upsert),
            mock.patch.object(gt.database_service, "_delete", self.db.delete),
            mock.patch.object(gt.identity_keys, "canonical", side_effect=lambda k: str(k or "")),
            mock.patch.object(gt.phone_links, "user_for", side_effect=lambda d: self.links.get(d)),
            mock.patch.object(gt.history_store, "tasks", tasks),
            mock.patch.object(gt, "_notify", push),
            mock.patch.object(gt.supabase_tasks, "user_id_for_phone", mock.AsyncMock(side_effect=lambda k: k)),
            mock.patch.object(gt.supabase_tasks, "upsert_task", upsert_task),
            mock.patch.object(gt, "now_il", return_value=NOW),
            mock.patch.object(gt, "today_il", return_value=NOW.date()),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def make(self, members=None):
        res = run(gt.create("owner-uid", "קורל", "מסיבה", 180,
                            [{"day": FRI, "start": "20:00"}, {"day": SAT, "start": "20:30"}],
                            members or [{"name": "דנה", "phone": "050-111-1111"},
                                        {"name": "יוסי", "phone": "+972 50 222 2222"},
                                        {"name": "מאיה", "phone": "0503333333"}],
                            "https://x.example"))
        self.assertTrue(res["ok"], res)
        return res

    def member(self, name):
        return next(m for m in self.db.t["lumi_group_members"] if m["displayName"] == name)

    def slot(self, day):
        return next(s for s in self.db.t["lumi_group_slots"] if s["day"] == day)


class Pure(unittest.TestCase):
    def test_israeli_numbers_become_international(self):
        self.assertEqual(gt.intl_digits("050-123 4567"), "972501234567")
        self.assertEqual(gt.intl_digits("+972 50 123 4567"), "972501234567")
        self.assertEqual(gt.intl_digits("00972501234567"), "972501234567")

    def test_busy_is_an_overlap_with_a_timed_task(self):
        rows = [{"date": FRI, "fixedTime": "19:30", "durationMinutes": 60, "status": "pending"},
                {"date": FRI, "text": "untimed to-do", "status": "pending"},
                {"date": FRI, "fixedTime": "21:00", "durationMinutes": 60, "status": "complete"}]
        self.assertTrue(gt.slot_busy(rows, FRI, "20:00", 120))
        self.assertFalse(gt.slot_busy(rows, FRI, "20:30", 60))     # ends 20:30, done one ignored
        self.assertFalse(gt.slot_busy(rows, SAT, "20:00", 120))

    def test_slots_in_the_past_or_malformed_are_dropped(self):
        got = gt.clean_slots([{"day": "2026-10-01", "start": "20:00"}, {"day": FRI, "start": "25:00"},
                              {"day": FRI, "start": "20:00"}, {"day": FRI, "start": "20:00"}], NOW.date())
        self.assertEqual(got, [{"day": FRI, "start": "20:00"}])


class Create(Base):
    def test_every_member_gets_a_link_and_nothing_says_who_is_on_meira(self):
        res = self.make()
        self.assertEqual(len(res["invites"]), 3)
        self.assertTrue(all(i["link"].startswith("https://x.example/g/") for i in res["invites"]))
        self.assertNotIn("onMeira", str(res))
        self.assertNotIn("memberKey", str(res))
        self.assertEqual(sorted(self.pushed), ["dana-uid", "yossi-uid"])

    def test_the_organizer_is_a_joined_member_and_adding_herself_is_skipped(self):
        self.links["972509999999"] = "owner-uid"
        self.make([{"name": "me", "phone": "0509999999"}, {"name": "דנה", "phone": "0501111111"}])
        owners = [m for m in self.db.t["lumi_group_members"] if m["role"] == "owner"]
        self.assertEqual(len(owners), 1)
        self.assertEqual(owners[0]["status"], "joined")
        self.assertEqual(len(self.db.t["lumi_group_members"]), 2)

    def test_tokens_are_stored_hashed(self):
        res = self.make()
        token = res["invites"][0]["link"].rsplit("/", 1)[1]
        self.assertFalse(any(m.get("tokenHash") == token for m in self.db.t["lumi_group_members"]))
        self.assertTrue(any(m.get("tokenHash") == gt.token_hash(token) for m in self.db.t["lumi_group_members"]))

    def test_no_valid_slot_is_refused(self):
        res = run(gt.create("owner-uid", "", "x", 60, [{"day": "2020-01-01", "start": "20:00"}],
                            [{"name": "a", "phone": "0501111111"}], "https://x"))
        self.assertEqual(res, {"ok": False, "reason": "no_valid_slots"})


class Grid(Base):
    def test_invited_is_waiting_joined_is_auto_and_the_reason_never_shows(self):
        res = self.make()
        gid = res["groupId"]
        run(gt.respond(gid, "dana-uid", True, None))
        v = run(gt.view(gid, "owner-uid"))
        self.assertEqual(v["role"], "owner")
        by = {r["name"]: [c for c in r["cells"]] for r in v["rows"]}
        self.assertEqual([c["value"] for c in by["דנה"]], ["no", "yes"])        # therapy Fri 19:30
        self.assertEqual([c["source"] for c in by["דנה"]], ["auto", "auto"])
        self.assertEqual([c["source"] for c in by["יוסי"]], ["waiting", "waiting"])
        self.assertNotIn("therapy", str(v))

    def test_a_manual_answer_beats_auto(self):
        gid = self.make()["groupId"]
        fri = self.slot(FRI)["id"]
        run(gt.respond(gid, "dana-uid", True, {fri: "yes"}))
        dana = next(r for r in run(gt.view(gid, "owner-uid"))["rows"] if r["name"] == "דנה")
        self.assertEqual(dana["cells"][0], {"slotId": fri, "value": "yes", "source": "manual"})

    def test_an_unreadable_day_is_a_question_mark_not_a_no(self):
        gid = self.make()["groupId"]
        run(gt.respond(gid, "yossi-uid", True, None))
        del self.tasks["yossi-uid"]
        yossi = next(r for r in run(gt.view(gid, "owner-uid"))["rows"] if r["name"] == "יוסי")
        self.assertEqual({c["value"] for c in yossi["cells"]}, {"unknown"})
        self.assertEqual({c["source"] for c in yossi["cells"]}, {"no_data"})

    def test_best_slot_is_the_most_yes(self):
        gid = self.make()["groupId"]
        for k in ("dana-uid", "yossi-uid"):
            run(gt.respond(gid, k, True, None))
        v = run(gt.view(gid, "owner-uid"))
        self.assertEqual(v["best"], self.slot(SAT)["id"])
        sat = next(s for s in v["slots"] if s["day"] == SAT)
        self.assertEqual((sat["yes"], sat["no"], sat["unknown"]), (3, 0, 1))

    def test_a_member_sees_only_her_row_and_a_stranger_sees_nothing(self):
        gid = self.make()["groupId"]
        run(gt.respond(gid, "dana-uid", True, None))
        mine = run(gt.view(gid, "dana-uid"))
        self.assertEqual(mine["role"], "member")
        self.assertNotIn("rows", mine)
        self.assertEqual(mine["organizer"], "קורל")
        self.assertEqual(run(gt.view(gid, "stranger"))["reason"], "not_found")

    def test_a_failed_read_is_a_reason(self):
        gid = self.make()["groupId"]
        self.db.fail_reads = True
        self.assertFalse(run(gt.view(gid, "owner-uid"))["ok"])

    def test_my_groups_lists_owned_and_invited(self):
        self.make()
        self.assertEqual(run(gt.my_groups("owner-uid"))["groups"][0]["role"], "owner")
        self.assertEqual(run(gt.my_groups("dana-uid"))["groups"][0]["myStatus"], "invited")
        run(gt.respond(self.db.t["lumi_groups"][0]["id"], "dana-uid", False, None))
        self.assertEqual(run(gt.my_groups("dana-uid"))["groups"], [])


class Token(Base):
    def test_someone_not_on_meira_answers_by_link(self):
        res = self.make()
        maya = next(i for i in res["invites"] if i["name"] == "מאיה")
        token = maya["link"].rsplit("/", 1)[1]
        sat = self.slot(SAT)["id"]
        self.assertTrue(run(gt.answer_by_token(token, {sat: "yes", "forged": "yes"}))["ok"])
        row = next(r for r in run(gt.view(res["groupId"], "owner-uid"))["rows"] if r["name"] == "מאיה")
        self.assertEqual(row["cells"][1]["source"], "manual")
        self.assertEqual(len(self.db.t["lumi_group_answers"]), 1)        # forged slot ignored

    def test_an_expired_link_says_so(self):
        res = self.make()
        token = res["invites"][0]["link"].rsplit("/", 1)[1]
        for m in self.db.t["lumi_group_members"]:
            m["tokenExpires"] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        self.assertEqual(run(gt.answer_by_token(token, {}))["reason"], "expired")

    def test_a_wrong_token_is_not_found(self):
        self.make()
        self.assertEqual(run(gt.answer_by_token("nope", {}))["reason"], "not_found")


class Lock(Base):
    def test_lock_adds_the_slot_only_for_the_yeses(self):
        gid = self.make()["groupId"]
        fri = self.slot(FRI)["id"]
        run(gt.respond(gid, "dana-uid", True, None))       # auto: busy Friday → no
        run(gt.respond(gid, "yossi-uid", True, None))      # auto: free → yes
        res = run(gt.lock(gid, "owner-uid", fri))
        self.assertTrue(res["ok"])
        who = sorted(uid for uid, _ in self.saved_tasks)
        self.assertEqual(who, ["owner-uid", "yossi-uid"])
        task = self.saved_tasks[0][1]
        self.assertEqual((task["date"], task["fixed_time"], task["duration_minutes"]), (FRI, "20:00", 180))
        self.assertEqual(self.db.t["lumi_groups"][0]["status"], "locked")

    def test_only_the_organizer_can_lock(self):
        gid = self.make()["groupId"]
        run(gt.respond(gid, "dana-uid", True, None))
        self.assertEqual(run(gt.lock(gid, "dana-uid", self.slot(SAT)["id"]))["reason"], "not_found")


if __name__ == "__main__":
    unittest.main()
