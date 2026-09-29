"""The kickboxing message, 2026-09-28.

Koral: "I wrote 'קיקבוקס'. I expected Meira to know where it is — Yigal Alon
94, Tel Aviv. I ride by bike. It has a time, 20:30-21:30 — it's in my
routines!" What happened instead, in the app chat:

  1. "where are you leaving from?" — the app had sent her live position with
     the turn; plan_departure ignored it and refused until she said "home".
  2. "how are you getting there?" — the transport she had already given, and
     the one on her Profile screen, never reached the agent.
  3. "where is the gym?" — her routines had the address; nothing read them,
     and "קיקבוקס" was not a word known_places knew.
  4. The task was saved as "קיקבוקס ב 8 וחצי" with NO hour: "8 וחצי" is how
     8:30 is said, and the parser only knew ":30".
  5. Every failure mid-turn re-ran the WHOLE turn — prompt, history, every
     tool — which she saw as Meira "reading everything again".

Each class below is one of those, run against what the tools actually do.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import known_places  # noqa: E402
import lumi_agent  # noqa: E402
import react_loop  # noqa: E402
import routine_match  # noqa: E402
import task_extract  # noqa: E402
import travel_prefs  # noqa: E402
import user_profile  # noqa: E402
from react_loop import AgentCallError, create_react_agent, tool  # noqa: E402

HOME = "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo, Tel Aviv District"
ROUTINES = "kids 16:00 every day; קיקבוקס 20:30-21:30 ביגאל אלון 94"
HERE = {"lat": 32.0791, "lng": 34.7925, "label": "Rothschild 1"}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _tool(name, phone="kick-phone", content="קיקבוקס ב 8 וחצי", here=None):
    for t in lumi_agent._make_tools(phone, content, here=here):
        if t.name == name:
            return t
    raise AssertionError(name)


# ── 4. the hour, as she says it ─────────────────────────────────────────────

class HebrewHalfHour(unittest.TestCase):
    def test_eight_and_a_half(self):
        self.assertEqual(task_extract.parse_clock_time("קיקבוקס ב 8 וחצי"), "08:30")

    def test_evening_word_still_lifts_it(self):
        self.assertEqual(task_extract.parse_clock_time("ב 8 וחצי בערב"), "20:30")

    def test_quarter_past_and_quarter_to(self):
        self.assertEqual(task_extract.parse_clock_time("ב-7 ורבע"), "07:15")
        self.assertEqual(task_extract.parse_clock_time("ברבע ל-9"), "08:45")

    def test_a_house_number_is_not_an_hour(self):
        self.assertIsNone(task_extract.parse_clock_time("רחוב 8"))
        self.assertIsNone(task_extract.parse_clock_time("יגאל אלון 94"))


# ── 3. her routines already say ─────────────────────────────────────────────

class RoutineMatch(unittest.TestCase):
    def test_the_routine_gives_hour_length_and_address(self):
        r = routine_match.find("קיקבוקס ב 8 וחצי", ROUTINES, "2026-09-28")
        self.assertEqual(r["match"], "exact")
        self.assertTrue(r["time_applies"])
        self.assertEqual((r["time"], r["minutes"]), ("20:30", 60))
        self.assertEqual(r["address"], "יגאל אלון 94")

    def test_english_routine_hebrew_task(self):
        r = routine_match.find("קיקבוקס", "Kickbox Mon/Wed 20:30-21:30 at Yigal Alon 94, Tel Aviv",
                               "2026-09-28")   # a Monday
        self.assertEqual(r["match"], "exact")
        self.assertEqual(r["address"], "Yigal Alon 94, Tel Aviv")

    def test_not_on_a_day_it_does_not_run(self):
        r = routine_match.find("קיקבוקס", "קיקבוקס ימי שני 20:30-21:30 יגאל אלון 94", "2026-09-29")
        self.assertFalse(r["time_applies"])            # Tuesday: the address, not the hour
        self.assertEqual(r["address"], "יגאל אלון 94")

    def test_a_different_class_at_the_same_gym_borrows_only_the_address(self):
        r = routine_match.find("יוגה", ROUTINES, "2026-09-28")
        self.assertEqual(r["match"], "concept")
        self.assertFalse(r["time_applies"])
        self.assertEqual(r["address"], "יגאל אלון 94")

    def test_unrelated_task_matches_nothing(self):
        self.assertIsNone(routine_match.find("רופא שיניים", ROUTINES, "2026-09-28"))

    def test_the_address_gets_her_city(self):
        self.assertEqual(routine_match.complete_address("יגאל אלון 94", HOME),
                         "יגאל אלון 94, Tel Aviv-Yafo")

    def test_kickboxing_is_a_known_place_concept(self):
        self.assertEqual(known_places.concept_of("קיקבוקס"), "fitness")
        self.assertEqual(known_places.activity_key("קיקבוקס ב 8 וחצי"),
                         known_places.activity_key("חדר כושר"))


class InferFromRoutine(unittest.TestCase):
    def setUp(self):
        user_profile.update_profile("kick-phone", homeAddress=HOME, routinesNotes=ROUTINES,
                                    transportType="bike")

    def test_bare_kickbox_becomes_a_placed_timed_task(self):
        seen = []

        async def _place(q):
            seen.append(q)
            return {"formatted": "Yigal Alon St 94, Tel Aviv-Yafo", "lat": 32.07, "lng": 34.79,
                    "name": "Yigal Alon 94"}

        with mock.patch.object(lumi_agent.geo, "find_place", _place):
            res = run(_tool("infer_task_details").ainvoke(
                {"task_text": "קיקבוקס ב 8 וחצי", "date": "2026-09-28"}))
        self.assertEqual(res["fixed_time"], "20:30")          # not 08:30, not None
        self.assertEqual(res["duration_minutes"], 60)
        self.assertEqual(res["location"], "Yigal Alon St 94, Tel Aviv-Yafo")
        self.assertEqual(seen, ["יגאל אלון 94, Tel Aviv-Yafo"])
        self.assertIn("place", res)                           # coordinates kept
        self.assertEqual(res["recalled"]["time"]["from"], "routine")

    def test_what_she_says_now_wins(self):
        async def _none(q):
            return None
        with mock.patch.object(lumi_agent.geo, "find_place", _none):
            res = run(_tool("infer_task_details").ainvoke(
                {"task_text": "קיקבוקס", "fixed_time": "18:00", "location": "Space Gym",
                 "date": "2026-09-28"}))
        self.assertEqual(res["fixed_time"], "18:00")
        self.assertEqual(res["location"], "Space Gym")


# ── 1 + 2. where from, and how — without asking ─────────────────────────────

class PlanWithoutQuestions(unittest.TestCase):
    def setUp(self):
        user_profile.update_profile("0500000123", homeAddress=HOME, transportType="bike")
        self.calls = []

        async def _plan(**kw):
            self.calls.append(kw)
            return {"ok": True, "plan": {"leaveHomeBy": "20:05", "travelMinutes": 12}}
        self.patch = mock.patch.object(lumi_agent.geo, "plan_departure", _plan)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()

    def _plan(self, here=None, **args):
        from tz import today_il
        args.setdefault("task_date", today_il().isoformat())
        return run(_tool("plan_departure", phone="0500000123", here=here).ainvoke(
            {"destination": "יגאל אלון 94", "arrival_time": "20:30", **args}))

    def test_today_starts_where_she_is(self):
        res = self._plan(here=HERE)
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.calls[0]["start_address"], "32.07910,34.79250")
        self.assertEqual(res["plan"]["startKind"], "here")

    def test_another_day_starts_at_home_without_asking(self):
        res = self._plan(here=HERE, task_date="2099-01-01")
        self.assertTrue(res["ok"], res)
        self.assertIsNone(self.calls[0]["start_address"])
        self.assertEqual(res["plan"]["startKind"], "home")

    def test_no_position_today_is_home_not_a_question(self):
        res = self._plan()
        self.assertTrue(res["ok"], res)
        self.assertNotEqual(res.get("need"), "start_confirmation")

    def test_transport_comes_from_her_profile(self):
        user_profile.update_profile("0500000456", homeAddress=HOME, transportType="bike")
        from tz import today_il
        res = run(_tool("plan_departure", phone="0500000456", here=HERE).ainvoke(
            {"destination": "יגאל אלון 94", "arrival_time": "20:30",
             "task_date": today_il().isoformat()}))
        self.assertEqual(self.calls[0]["transport"], "bike")
        self.assertTrue(res["plan"]["usedDefaultTransport"])

    def test_a_mode_she_names_is_remembered_for_the_place(self):
        self._plan(here=HERE, transport="walk")
        self.assertEqual(travel_prefs.preferred("0500000123", "יגאל אלון 94"), "walk")
        self._plan(here=HERE)
        self.assertEqual(self.calls[-1]["transport"], "walk")


class AppProfileReachesTheAgent(unittest.TestCase):
    def test_transport_and_routines_are_adopted(self):
        changed = agent_turn.sync_app_profile("sync-phone", {
            "transportType": "bike", "routinesNotes": ROUTINES, "homeAddress": HOME})
        self.assertEqual(set(changed), {"transportType", "appRoutinesNotes", "homeAddress"})
        prof = user_profile.get_profile("sync-phone")
        self.assertEqual(prof["transportType"], "bike")
        self.assertIn("קיקבוקס", routine_match.notes_of(prof))

    def test_the_phone_never_erases_what_she_told_the_chat(self):
        """Her real data on 2026-09-28: the chat held the kickboxing line, the
        phone's Routines box held her morning routine."""
        user_profile.update_profile("sync-3", routinesNotes=ROUTINES)
        agent_turn.sync_app_profile("sync-3", {"routinesNotes": "מקלחת בוקר, קפה, להתלבש קצת איפור"})
        prof = user_profile.get_profile("sync-3")
        self.assertEqual(prof["routinesNotes"], ROUTINES)
        notes = routine_match.notes_of(prof)
        self.assertIn("קיקבוקס", notes)
        self.assertIn("מקלחת בוקר", notes)
        self.assertEqual(routine_match.find("קיקבוקס", notes, "2026-09-28")["time"], "20:30")

    def test_blanks_and_junk_are_refused(self):
        agent_turn.sync_app_profile("sync-2", {"transportType": "bike"})
        agent_turn.sync_app_profile("sync-2", {"transportType": "", "name": "x",
                                               "homeAddress": "   ", "hobbies": 5})
        prof = user_profile.get_profile("sync-2")
        self.assertEqual(prof["transportType"], "bike")
        self.assertNotEqual(prof.get("name"), "x")
        self.assertEqual(agent_turn.sync_app_profile("sync-2", {"transportType": "rocket"}), {})


# ── 5. a failure repeats one call, not the turn ─────────────────────────────

class _Fn:
    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments


class _Call:
    def __init__(self, call_id, name, arguments):
        self.id, self.function = call_id, _Fn(name, arguments)


class _Resp:
    def __init__(self, content="", tool_calls=None):
        self.message = self
        self.content, self.tool_calls = content, tool_calls
        self.choices = [self]
        self.usage = None


class _Transient(Exception):
    pass


class FlakyLLM:
    """Scripted replies; an Exception in the script is raised for that call."""

    def __init__(self, script):
        self.script, self.sent = list(script), []

    async def complete(self, messages, tools):
        self.sent.append(len(messages))
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


class RetryInPlace(unittest.TestCase):
    def _counting_tool(self):
        self.ran = 0

        @tool
        async def save(value: str) -> dict:
            """Save."""
            self.ran += 1
            return {"ok": True}
        return save

    def test_a_blip_after_the_tool_repeats_only_that_call(self):
        llm = FlakyLLM([
            _Resp(tool_calls=[_Call("c1", "save", '{"value": "x"}')]),
            _Transient("503 overloaded"),
            _Resp(content="saved ✓"),
        ])
        agent = create_react_agent(llm, [self._counting_tool()], prompt="sys",
                                   retry_if=lambda e: isinstance(e, _Transient))
        agent.backoff_s = 0
        out = run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}))
        self.assertEqual(self.ran, 1)                        # the tool ran ONCE
        self.assertEqual(out["messages"][-1].content, "saved ✓")
        self.assertEqual(llm.sent, [2, 4, 4])                # retried from the same wire

    def test_a_permanent_failure_keeps_what_already_ran(self):
        llm = FlakyLLM([
            _Resp(tool_calls=[_Call("c1", "save", '{"value": "x"}')]),
            ValueError("400 bad request"),
        ])
        agent = create_react_agent(llm, [self._counting_tool()], prompt="sys",
                                   retry_if=lambda e: isinstance(e, _Transient))
        with self.assertRaises(AgentCallError) as ctx:
            run(agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}))
        names = [getattr(m, "name", "") for m in ctx.exception.state["messages"]]
        self.assertIn("save", names)
        self.assertEqual(len(ctx.exception.state["wire"]), 4)

    def test_resume_continues_without_running_tools_again(self):
        first = FlakyLLM([
            _Resp(tool_calls=[_Call("c1", "save", '{"value": "x"}')]),
            _Resp(content=""),                                # the empty answer
        ])
        save = self._counting_tool()
        out = run(create_react_agent(first, [save], prompt="sys").ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        second = FlakyLLM([_Resp(content="saved ✓")])
        again = run(create_react_agent(second, [save], prompt="sys").ainvoke(
            {"wire": out["wire"]}))
        self.assertEqual(self.ran, 1)
        self.assertEqual(second.sent, [4])                   # sys, user, call, result
        self.assertEqual(again["messages"][-1].content, "saved ✓")


if __name__ == "__main__":
    unittest.main()
