"""mcp_server — Meira as an MCP server, the third door to one brain.

What is tested is what the CODE guarantees, with the agent, Supabase and the
network mocked:
  - no token, a wrong token and a revoked token are all 401 (fail closed);
  - the handshake speaks MCP (initialize → tools/list → tools/call) and a
    notification gets 202 with no body;
  - identity comes from the token, never from a tool argument;
  - get_my_day hands back the leave/wake times the phone computed;
  - add_task saves through the SAME persistence the agent uses, mirrors to
    the token's account, and reports the clash it created;
  - an app-only account (keyed by its Supabase UUID) reaches Supabase at all.
"""
import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import mcp_server  # noqa: E402

CALLER = {"key": "972500000001", "userId": "11111111-2222-3333-4444-555555555555",
          "phone": "972500000001", "email": "k@x.co"}


def _app() -> TestClient:
    app = FastAPI()
    app.include_router(mcp_server.router)
    return TestClient(app)


def rpc(method, params=None, id_=1):
    m = {"jsonrpc": "2.0", "method": method, "id": id_}
    if params is not None:
        m["params"] = params
    return m


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = mock.patch.object(mcp_server, "_PATH", os.path.join(self.tmp.name, "mcp.json"))
        self.p.start()
        self.client = _app()
        self.token = mcp_server.issue_token(CALLER, "Claude")["token"]
        self.auth = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()


class Auth(Base):
    def test_no_token_is_401_with_a_challenge(self):
        r = self.client.post("/mcp", json=rpc("initialize"))
        self.assertEqual(r.status_code, 401)
        self.assertIn("Bearer", r.headers.get("www-authenticate", ""))

    def test_unknown_token_is_401(self):
        r = self.client.post("/mcp", json=rpc("ping"), headers={"Authorization": "Bearer meira_mcp_nope"})
        self.assertEqual(r.status_code, 401)

    def test_revoked_token_is_401(self):
        self.assertEqual(self.client.post("/mcp", json=rpc("ping"), headers=self.auth).status_code, 200)
        self.assertEqual(mcp_server.revoke_tokens(CALLER["key"]), 1)
        self.assertEqual(self.client.post("/mcp", json=rpc("ping"), headers=self.auth).status_code, 401)

    def test_the_plaintext_token_is_never_stored(self):
        raw = open(mcp_server._PATH, "rb").read()
        self.assertNotIn(self.token.encode(), raw)

    def test_a_token_resolves_to_the_person_who_made_it(self):
        caller = asyncio.run(mcp_server.authenticate(f"Bearer {self.token}"))
        self.assertEqual(caller["key"], CALLER["key"])
        self.assertEqual(caller["userId"], CALLER["userId"])

    def test_at_most_five_live_tokens(self):
        for i in range(7):
            mcp_server.issue_token(CALLER, f"t{i}")
        self.assertEqual(len(mcp_server.list_tokens(CALLER["key"])), mcp_server.MAX_TOKENS_PER_USER)


class Protocol(Base):
    def test_initialize(self):
        r = self.client.post("/mcp", headers=self.auth,
                             json=rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                     "clientInfo": {"name": "claude", "version": "1"}}))
        res = r.json()["result"]
        self.assertEqual(res["protocolVersion"], "2025-06-18")
        self.assertEqual(res["serverInfo"]["name"], "meira")
        self.assertIn("tools", res["capabilities"])

    def test_unknown_version_gets_ours(self):
        res = self.client.post("/mcp", headers=self.auth,
                               json=rpc("initialize", {"protocolVersion": "1999-01-01"})).json()["result"]
        self.assertIn(res["protocolVersion"], mcp_server.SUPPORTED_VERSIONS)

    def test_notification_is_202_without_body(self):
        r = self.client.post("/mcp", headers=self.auth,
                             json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.content, b"")

    def test_tools_list_has_schemas(self):
        tools = self.client.post("/mcp", headers=self.auth, json=rpc("tools/list")).json()["result"]["tools"]
        names = {t["name"] for t in tools}
        self.assertTrue({"get_my_day", "add_task", "check_availability", "plan_journey", "ask_meira"} <= names)
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object", t["name"])
            self.assertTrue(t["description"], t["name"])

    def test_unknown_tool_and_method(self):
        r = self.client.post("/mcp", headers=self.auth, json=rpc("tools/call", {"name": "rm_rf"})).json()
        self.assertEqual(r["error"]["code"], -32602)
        r = self.client.post("/mcp", headers=self.auth, json=rpc("resources/list")).json()
        self.assertEqual(r["error"]["code"], -32601)

    def test_batch(self):
        r = self.client.post("/mcp", headers=self.auth, json=[
            rpc("ping", id_=1), {"jsonrpc": "2.0", "method": "notifications/initialized"}, rpc("tools/list", id_=2)])
        self.assertEqual([m["id"] for m in r.json()], [1, 2])

    def test_get_is_405(self):
        self.assertEqual(self.client.get("/mcp").status_code, 405)

    def test_a_tool_that_throws_is_an_error_result_not_a_500(self):
        with mock.patch.object(mcp_server, "call_tool", mock.AsyncMock(side_effect=RuntimeError("boom"))):
            r = self.client.post("/mcp", headers=self.auth,
                                 json=rpc("tools/call", {"name": "get_my_day", "arguments": {}}))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["result"]["isError"])


class Tools(Base):
    def _call(self, name, args):
        r = self.client.post("/mcp", headers=self.auth, json=rpc("tools/call", {"name": name, "arguments": args}))
        return r.json()["result"]

    def test_get_my_day_carries_the_phones_leave_and_wake_times(self):
        rows = [
            {"id": "a", "text": "Meeting — Nebius team", "fixed_time": "13:00", "duration_minutes": 60,
             "date": "2030-10-01", "status": "pending", "category": "meeting", "priority": "must",
             "location": {"address": "Azrieli Center", "leaveHomeBy": "12:18", "wakeUpBy": "07:30",
                          "transitPlan": {"legs": [{"type": "walk"}, {"type": "bus", "lineNumber": "251"}]}}},
            {"id": "b", "text": "Old thing", "fixed_time": "09:00", "date": "2030-10-01", "status": "complete"},
        ]
        seen = {}

        async def fetch(key, d1, d2, include_location=False):
            seen["key"] = key
            return rows
        with mock.patch("task_store.fetch_task_rows", fetch):
            res = self._call("get_my_day", {"date": "2030-10-01"})
        data = res["structuredContent"]
        self.assertEqual(seen["key"], CALLER["key"], "identity must come from the token")
        self.assertEqual(data["done"], 1)
        [t] = data["tasks"]
        self.assertEqual((t["leave_by"], t["route"], t["source"]), ("12:18", "bus 251", "phone"))
        # ONE wake time for the day — a per-task one said "wake at 17:27" for an
        # 18:30 meetup. The phone's own wake for the first trip wins.
        self.assertEqual(data["wake_by"], "07:30")
        self.assertNotIn("wake_by", t)

    def test_date_words_go_through_the_one_parser(self):
        self.assertRegex(mcp_server._resolve_date("tomorrow"), r"^\d{4}-\d\d-\d\d$")
        self.assertRegex(mcp_server._resolve_date("מחר"), r"^\d{4}-\d\d-\d\d$")
        with self.assertRaises(ValueError):
            mcp_server._resolve_date("the twelfth of never")

    def test_bad_time_is_an_error_the_model_can_read(self):
        res = self._call("add_task", {"text": "Dentist", "time": "25:99"})
        self.assertTrue(res["isError"])
        self.assertIn("HH:MM", res["content"][0]["text"])

    def test_add_task_saves_mirrors_plans_and_reports_the_clash(self):
        inferred = {"text": "Dentist", "date": "2026-10-01", "fixed_time": "13:30", "duration_minutes": 45,
                    "category": "doctor", "priority": "must", "location": "Ibn Gabirol 30, Tel Aviv",
                    "clashes": [{"with": "Meeting — Nebius team", "overlap_minutes": 30}]}
        infer = mock.AsyncMock(return_value=inferred)
        plan = mock.AsyncMock(return_value={"ok": True, "plan": {
            "transport": "bus", "travelMinutes": 22, "leaveHomeBy": "13:02", "wakeUpBy": "08:00",
            "overviewPolyline": "x" * 500, "lat": 32.1}})
        fake_tools = {"infer_task_details": mock.Mock(ainvoke=infer), "plan_departure": mock.Mock(ainvoke=plan)}
        persist = mock.AsyncMock(return_value=[{**inferred, "id": "t-9"}])
        upsert = mock.AsyncMock(return_value="t-9")
        with mock.patch.object(mcp_server, "_agent_tools", mock.AsyncMock(return_value=(fake_tools, {}))), \
             mock.patch("agent_turn.persist_agent_tasks", persist), \
             mock.patch("supabase_tasks.upsert_task", upsert):
            res = self._call("add_task", {"text": "Dentist", "date": "2026-10-01", "time": "13:30",
                                          "location": "Ibn Gabirol 30, Tel Aviv"})
        data = res["structuredContent"]
        self.assertFalse(res["isError"])
        self.assertEqual(data["task"]["id"], "t-9")
        self.assertEqual(persist.call_args.kwargs.get("channel"), "mcp")
        upsert.assert_awaited_once()
        self.assertEqual(upsert.call_args.args[0], CALLER["userId"])
        self.assertEqual(data["clashes"][0]["with"], "Meeting — Nebius team")
        self.assertEqual(data["journey"]["leaveHomeBy"], "13:02")
        self.assertNotIn("overviewPolyline", data["journey"])
        self.assertEqual(infer.call_args.args[0]["fixed_time"], "13:30")


class AppOnlyAccount(unittest.TestCase):
    def test_a_uuid_key_is_its_own_supabase_user(self):
        import supabase_tasks
        uid = "8f14e45f-ceea-467a-9575-1b2b8a3a1c10"
        with mock.patch.object(supabase_tasks, "_enabled", return_value=True), \
             mock.patch("httpx.AsyncClient") as client:
            got = asyncio.run(supabase_tasks.user_id_for_phone(uid))
        self.assertEqual(got, uid)
        client.assert_not_called()   # never suffix-matched against strangers' numbers


if __name__ == "__main__":
    unittest.main()
