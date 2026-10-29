"""'The fastest beach by car from home' — Meira chooses, door to door.

7.10, the app mic: "what's the fastest beach to reach by car from home?" got
"which beach?" and then "where do you live?". Then Koral listed what a
secretary is for: the closest post office, the nearest Clalit clinic, car vs
bike vs bus to the sea, "how do I get home from here?". Google is mocked; what
is tested is what the CODE decides: the ranking (drive + parking + walk, wait
for the bus), where the trip starts, and that every failure says why.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import geo  # noqa: E402
import lumi_agent  # noqa: E402
import place_ranker  # noqa: E402

HOME = {"lat": 32.0853, "lng": 34.7818, "formatted": "Home St 1"}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _place(pid, name, lat, lng):
    return {"place_id": pid, "name": name, "formatted_address": f"{name} addr",
            "geometry": {"location": {"lat": lat, "lng": lng}}}


# Two beaches: Gordon is the shorter drive but has no car park near it; Hilton
# is a longer drive with a car park 120 m away. Door to door, Hilton wins.
GORDON = _place("g", "חוף גורדון", 32.0830, 34.7680)
HILTON = _place("h", "חוף הילטון", 32.0880, 34.7700)
FAR = _place("f", "חוף רחוק", 32.4000, 34.8600)
LOT_BY_HILTON = _place("p", "חניון הילטון", 32.0890, 34.7710)   # ~140 m


def _drive(minutes_by_place):
    async def directions(origin, dest, mode, arrival):
        for (lat, lng), table in minutes_by_place.items():
            if abs(dest["lat"] - lat) < 1e-6 and abs(dest["lng"] - lng) < 1e-6:
                m = table.get(mode)
                if m is None:
                    return None, "no_route"
                route = {"minutes": m, "mode": mode}
                if mode in ("bus", "train"):
                    route.update({"departAt": "10:20", "arriveAtReal": "10:45",
                                  "transit": {"line": "18", "vehicle": "BUS", "departStop": "דיזנגוף"}})
                return route, None
        return None, "no_route"
    return directions


class Ranking(unittest.TestCase):
    def setUp(self):
        self.searches = []

        async def places_near(client, query, lat, lng, radius):
            self.searches.append(query)
            if query == place_ranker._PARKING_QUERY:
                return [LOT_BY_HILTON] if abs(lat - 32.0880) < 1e-6 else []
            return [FAR, GORDON, HILTON]

        self.patches = [
            mock.patch.object(place_ranker.config, "GOOGLE_MAPS_API_KEY", "k"),
            mock.patch.object(geo, "places_near", places_near),
            mock.patch.object(place_ranker._tz, "now_il",
                              lambda: __import__("datetime").datetime(2026, 10, 7, 10, 0)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def _rank(self, table, **kw):
        with mock.patch.object(geo, "directions_detailed", _drive(table)):
            return run(place_ranker.rank(origin=HOME, **kw))

    def test_door_to_door_beats_the_shorter_drive(self):
        out = self._rank({(32.0830, 34.7680): {"car": 14}, (32.0880, 34.7700): {"car": 16},
                          (32.4000, 34.8600): {"car": 40}},
                         modes=["car"], category="חוף ים")
        self.assertTrue(out["ok"])
        first, second = out["results"][0], out["results"][1]
        self.assertEqual(first["name"], "חוף הילטון")
        # 16 drive + 5 to find a space (a car park is close) + ~2 walking
        self.assertEqual(first["best"]["total_min"], 16 + 5 + 2)
        self.assertEqual(first["best"]["parking"], "חניון הילטון")
        self.assertTrue(first["best"]["parking_is_estimate"])
        # No car park near Gordon: street parking takes longer, and it says so.
        self.assertEqual(second["best"]["total_min"], 14 + 10)
        self.assertNotIn("parking", second["best"])

    def test_car_bike_or_bus_names_the_fastest_way(self):
        out = self._rank({(32.0830, 34.7680): {"car": 14, "bike": 15, "bus": 12},
                          (32.0880, 34.7700): {"car": 16, "bike": 30, "bus": 40},
                          (32.4000, 34.8600): {"car": 40, "bike": 90, "bus": 70}},
                         modes=["car", "bike", "bus"], category="חוף ים")
        best = out["results"][0]
        # Bus: 20 min until it leaves + 12 = 32; car 14 + 10 = 24; bike 15 + 2 = 17.
        self.assertEqual(best["name"], "חוף גורדון")
        self.assertEqual(best["best"]["mode"], "bike")
        self.assertEqual(best["by_mode"]["bus"]["wait_min"], 20)
        self.assertEqual(best["by_mode"]["bus"]["line"], "18")
        self.assertEqual(set(best["by_mode"]), {"car", "bike", "bus"})

    def test_home_needs_no_parking_search(self):
        dest = {"lat": 32.1, "lng": 34.8, "formatted": "Home St 1", "name": "home"}
        out = self._rank({(32.1, 34.8): {"car": 9}}, modes=["car"],
                         destination=dest, park_at_destination=False)
        self.assertEqual(out["results"][0]["best"]["total_min"], 9)
        self.assertNotIn(place_ranker._PARKING_QUERY, self.searches)

    def test_open_now_puts_closed_places_last(self):
        hours = {"g": {"open_now": False, "hours_today": "08:00–09:00"},
                 "h": {"open_now": True, "hours_today": "08:00–20:00"}}

        async def _hours(client, pid):
            return hours.get(pid, {})

        with mock.patch.object(place_ranker, "_hours", _hours):
            out = self._rank({(32.0830, 34.7680): {"walk": 5}, (32.0880, 34.7700): {"walk": 9},
                              (32.4000, 34.8600): {"walk": 90}},
                             modes=["walk"], category="סניף דואר", open_now=True)
        self.assertEqual(out["results"][0]["name"], "חוף הילטון")
        self.assertIs(out["results"][0]["open_now"], True)
        closed = next(r for r in out["results"] if r["name"] == "חוף גורדון")
        self.assertIs(closed["open_now"], False)


class EveryFailureSaysWhy(unittest.TestCase):
    """Silent-state rule 1: never a bare [] that could mean 'nothing nearby'."""

    def _rank(self, places_near, directions=None):
        patches = [mock.patch.object(place_ranker.config, "GOOGLE_MAPS_API_KEY", "k"),
                   mock.patch.object(geo, "places_near", places_near)]
        if directions:
            patches.append(mock.patch.object(geo, "directions_detailed", directions))
        for p in patches:
            p.start()
        try:
            return run(place_ranker.rank(origin=HOME, modes=["car"], category="חוף ים"))
        finally:
            for p in patches:
                p.stop()

    def test_a_refused_key_is_not_an_empty_coast(self):
        async def refused(*a):
            raise geo.PlacesRefused("REQUEST_DENIED: key")
        self.assertEqual(self._rank(refused)["reason"], "places_refused")

    def test_nothing_found(self):
        async def empty(*a):
            return []
        self.assertEqual(self._rank(empty)["reason"], "nothing_found")

    def test_directions_refused(self):
        async def found(client, query, *a):
            return [] if query == place_ranker._PARKING_QUERY else [GORDON]

        async def refused(*a):
            return None, "refused"
        self.assertEqual(self._rank(found, refused)["reason"], "directions_refused")

    def test_no_key(self):
        with mock.patch.object(place_ranker.config, "GOOGLE_MAPS_API_KEY", ""):
            out = run(place_ranker.rank(origin=HOME, modes=["car"], category="x"))
        self.assertEqual(out["reason"], "not_configured")


class WhereTheTripStarts(unittest.TestCase):
    """'From home', 'near me', and no question when either is known."""

    def _tool(self, name, profile, here=None):
        tools = lumi_agent._make_tools("0500000999", "", here=here)
        tool = next(t for t in tools if t.name == name)
        seen = {}

        async def rank(**kw):
            seen.update(kw)
            return {"ok": True, "results": []}

        async def geocode(addr, bounds=None):
            if "," in addr and addr.replace(",", "").replace(".", "").isdigit():
                lat, lng = addr.split(",")
                return {"lat": float(lat), "lng": float(lng), "formatted": addr}
            return {"lat": 32.1, "lng": 34.8, "formatted": addr}

        patches = [mock.patch.object(lumi_agent.user_profile, "get_profile", lambda p: profile),
                   mock.patch.object(lumi_agent.place_ranker, "rank", rank),
                   mock.patch.object(lumi_agent.geo, "geocode", geocode)]
        return tool, seen, patches

    def _call(self, name, args, profile, here=None):
        tool, seen, patches = self._tool(name, profile, here)
        for p in patches:
            p.start()
        try:
            out = run(tool.ainvoke(args))
        finally:
            for p in patches:
                p.stop()
        return out, seen

    HERE = {"lat": 32.07, "lng": 34.79, "label": "רוטשילד"}

    def test_from_home_starts_at_home(self):
        out, seen = self._call("find_best_place", {"category": "חוף ים", "modes": ["car"], "origin": "home"},
                               {"homeAddress": "יגאל אלון 94", "transportType": "bike"}, self.HERE)
        self.assertEqual(out["origin_used"], "home")
        self.assertEqual(seen["origin"]["formatted"], "יגאל אלון 94")
        self.assertEqual(seen["modes"], ["car"])

    def test_no_home_saved_routes_from_here_and_says_so(self):
        out, seen = self._call("find_best_place", {"category": "חוף ים", "origin": "home"},
                               {"transportType": "bus"}, self.HERE)
        self.assertEqual(out["origin_used"], "here")
        self.assertEqual(out["origin_note"], "no_home_saved")
        self.assertEqual(seen["modes"], ["bus"])   # her usual way when she named none

    def test_near_me_is_where_she_is(self):
        out, _ = self._call("find_best_place", {"category": "סניף דואר"},
                            {"homeAddress": "יגאל אלון 94"}, self.HERE)
        self.assertEqual(out["origin_used"], "here")

    def test_nothing_known_is_the_only_question(self):
        out, seen = self._call("find_best_place", {"category": "חוף ים"}, {}, None)
        self.assertEqual(out["reason"], "need_origin")
        self.assertEqual(seen, {})

    def test_home_from_here_goes_home_without_parking(self):
        out, seen = self._call("route_now", {"destination": "הביתה"},
                               {"homeAddress": "יגאל אלון 94", "transportType": "car"}, self.HERE)
        self.assertEqual(out["origin_used"], "here")
        self.assertEqual(seen["destination"]["formatted"], "יגאל אלון 94")
        self.assertFalse(seen["park_at_destination"])

    def test_home_unknown_is_said(self):
        out, _ = self._call("route_now", {"destination": "home"}, {}, self.HERE)
        self.assertEqual(out["reason"], "no_home_saved")


class TheRouteGuardKnowsTheNewTools(unittest.TestCase):
    """Live, 7.10, right after deploy: "the nearest Clalit clinic" came back with
    no clinics and "want me to compute the route? 🚆". The anti-fabrication guard
    strips route lines unless a route tool ran — and it knew only plan_departure,
    so it deleted the answer find_best_place had just computed."""

    def test_every_route_tool_lets_its_answer_through(self):
        for name in ("plan_departure", "find_best_place", "route_now"):
            self.assertIn(name, lumi_agent.ROUTE_TOOLS)

    def test_no_stale_name_in_the_list(self):
        names = {t.name for t in lumi_agent._make_tools("0500000998", "")}
        self.assertLessEqual(set(lumi_agent.ROUTE_TOOLS), names)


class TaxiAndTheWordsSaid(unittest.TestCase):
    """'How do I get home from here?' → walk, bus, taxi, her own vehicle — and
    the sentence is written by code from the numbers."""

    def test_a_taxi_is_a_car_that_comes_to_her(self):
        leg = place_ranker._leg("taxi", {"minutes": 9}, "10:00", None)
        self.assertEqual(leg["total_min"], 9 + place_ranker._TAXI_PICKUP_MIN)
        self.assertTrue(leg["wait_is_estimate"])
        self.assertNotIn("park_min", leg)
        self.assertNotIn("price", leg)

    def test_the_bus_says_its_line_stop_and_when_to_walk(self):
        route = {"minutes": 16, "departAt": "10:06", "arriveAtReal": "10:22",
                 "transit": {"line": "18", "departStop": "דרך השלום", "departTime": "10:11"},
                 "legs": [{"type": "walk", "minutes": 5}, {"type": "bus", "minutes": 11}]}
        leg = place_ranker._leg("bus", route, "10:00", None)
        self.assertEqual((leg["line"], leg["from_stop"], leg["board_at"]), ("18", "דרך השלום", "10:11"))
        self.assertEqual(leg["walk_to_stop_min"], 5)
        self.assertEqual(leg["total_min"], 6 + 16)

    def test_every_way_home_when_she_named_none(self):
        self.assertEqual(place_ranker.route_modes({"transportType": "bike"}),
                         ["bike", "walk", "bus", "taxi"])
        self.assertEqual(place_ranker.route_modes({}), ["walk", "bus", "taxi"])
        self.assertEqual(place_ranker.normalize_modes(["מונית"], None), ["taxi"])

    def test_the_route_answer_names_the_fastest_and_the_rest(self):
        result = {"ok": True, "kind": "route", "results": [{"name": "home", "by_mode": {
            "bus": {"mode": "bus", "total_min": 22, "line": "18", "from_stop": "דרך השלום",
                    "board_at": "17:42"},
            "walk": {"mode": "walk", "total_min": 38, "ride_min": 38},
            "taxi": {"mode": "taxi", "total_min": 14, "ride_min": 9, "wait_min": 5}}}]}
        text = place_ranker.say(result, he=True)
        self.assertTrue(all(line.startswith("\u200f") for line in text.split("\n")),
                        "every line says it reads right-to-left")
        text = text.replace("\u200f", "")
        self.assertTrue(text.startswith("הכי מהיר: במונית — 14 דק׳"))
        self.assertIn("באוטובוס 22", text)
        self.assertIn("ברגל 38", text)
        self.assertNotIn("₪", text)
        bike = {"ok": True, "kind": "route", "results": [{"name": "home", "by_mode": {
            "bike": {"mode": "bike", "total_min": 9, "ride_min": 7, "lock_min": 2}}}]}
        self.assertIn("(7 רכיבה · 2 נעילה)", place_ranker.say(bike, he=True))
        en = place_ranker.say(result, he=False)
        self.assertTrue(en.startswith("\u200eFastest: by taxi — 14 min"),
                        "an English line is marked left-to-right")

    def test_the_places_answer_is_the_winner_and_the_next(self):
        result = {"ok": True, "kind": "places", "results": [
            {"name": "חוף עליה", "best": {"mode": "car", "total_min": 35, "ride_min": 25, "park_min": 10}},
            {"name": "טיילת חוף תל אביב", "best": {"mode": "car", "total_min": 36}}]}
        text = place_ranker.say(result, he=True)
        self.assertIn("חוף עליה — ~35 דק׳ באוטו (25 נסיעה · ~10 חניה)", text)
        self.assertIn("אחריו: טיילת חוף תל אביב ~36", text)
        self.assertNotIn("הרץ", text)


class TheFastPath(unittest.TestCase):
    """A place question is answered by code in seconds — no agent loop."""

    def _turn(self, payload, lookup_result, content="איך אני חוזרת מפה הביתה?", mode=None,
              persisted=None):
        import json
        from types import SimpleNamespace
        import agent_turn
        import understand
        reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content=json.dumps(payload)))], usage=None)
        client = mock.MagicMock()
        client.chat.completions.create = mock.AsyncMock(return_value=reply)
        appended = []

        async def lookup(**kw):
            lookup.kw = kw
            return lookup_result

        agent = mock.AsyncMock(return_value={"text": "agent", "tasks": []})
        with mock.patch.object(understand, "_client", lambda: client), \
                mock.patch.object(agent_turn, "handle_whatsapp_message", agent), \
                mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=[])), \
                mock.patch.object(agent_turn, "clash_note", mock.AsyncMock(return_value="")), \
                mock.patch.object(agent_turn, "meira_just_asked", lambda k: False), \
                mock.patch.object(agent_turn, "persist_agent_tasks",
                                  mock.AsyncMock(return_value=persisted or [])), \
                mock.patch.object(agent_turn, "rescue_turn", mock.AsyncMock(return_value=([], ""))), \
                mock.patch.object(agent_turn.conversation, "get_history", lambda k: []), \
                mock.patch.object(agent_turn.conversation, "append", lambda *a: appended.append(a)), \
                mock.patch.object(agent_turn.user_profile, "get_profile",
                                  lambda k: {"homeAddress": "יגאל אלון 94", "transportType": "bus"}), \
                mock.patch.object(agent_turn.place_ranker, "lookup", lookup):
            out = run(agent_turn.run_turn("p", content, {"id": "u1"}, mode=mode,
                                          here={"lat": 32.07, "lng": 34.79}))
        return out, agent, lookup, appended

    ROUTE = {"ok": True, "kind": "route", "results": [{"name": "home", "by_mode": {
        "bus": {"mode": "bus", "total_min": 22, "line": "18"},
        "walk": {"mode": "walk", "total_min": 38, "ride_min": 38}}}]}
    ASKED = {"understood": "איך לחזור הביתה", "kind": "question", "actions": [],
             "lookup": {"what": "route", "destination": "home", "modes": []}}

    def test_a_typed_route_question_never_reaches_the_agent(self):
        out, agent, lookup, appended = self._turn(self.ASKED, self.ROUTE)
        agent.assert_not_called()
        self.assertEqual(out["type"], "answer")
        self.assertEqual(out["answer"]["kind"], "route")
        self.assertTrue(out["text"].lstrip("\u200f").startswith("הכי מהיר: באוטובוס — 22"))
        self.assertEqual(lookup.kw["destination"], "home")
        self.assertEqual(len(appended), 1, "the answer is kept in the conversation")

    def test_the_mic_takes_the_same_path(self):
        out, agent, _, _ = self._turn(self.ASKED, self.ROUTE, mode="voice_plan")
        agent.assert_not_called()
        self.assertEqual(out["type"], "answer")

    def test_a_lookup_that_cannot_answer_goes_to_the_agent(self):
        out, agent, _, _ = self._turn(self.ASKED, {"ok": False, "reason": "need_origin"})
        agent.assert_called_once()

    def test_a_task_is_saved_by_code_with_no_lookup_and_no_agent(self):
        # 27.10: every typed message is understood first; a save never waits
        # on the agent loop, and is never mistaken for a route question.
        said = {"understood": "אימון מחר", "kind": "do",
                "actions": [{"do": "add", "title": "אימון", "date_expression": "מחר", "start": "07:00"}]}
        import agent_turn
        saved = [{"id": "t1", "text": "אימון", "date": "2026-10-28", "fixed_time": "07:00"}]
        with mock.patch.object(agent_turn.session, "set_last_saved", lambda *a: None):
            out, agent, lookup, _ = self._turn(said, self.ROUTE, content="תוסיפי אימון מחר ב-7",
                                               persisted=saved)
        agent.assert_not_called()
        self.assertFalse(hasattr(lookup, "kw"))
        self.assertIn("אימון", out["text"])
        self.assertIn("07:00", out["text"])


class NoTripFromHomeToHome(unittest.TestCase):
    """Live, 7.10: "how do I get home from Yigal Alon 94?" answered "on foot —
    1 min": the named start was dropped and the trip ran home → home."""

    def _lookup(self, profile, here, origin="auto"):
        async def geocode(addr, bounds=None):
            return {"lat": 32.1, "lng": 34.8, "formatted": addr} if "יגאל" not in addr else \
                {"lat": 32.07, "lng": 34.79, "formatted": addr}

        rank = mock.AsyncMock(return_value={"ok": True, "results": [{"name": "home", "best": {}}]})
        with mock.patch.object(geo, "geocode", geocode), \
                mock.patch.object(place_ranker, "rank", rank):
            return run(place_ranker.lookup(profile=profile, here=here, destination="home",
                                           origin=origin)), rank

    def test_home_from_home_asks_where_she_is(self):
        out, rank = self._lookup({"homeAddress": "Home St 1"}, None)
        self.assertEqual(out["reason"], "need_origin")
        rank.assert_not_called()

    def test_a_named_start_is_used(self):
        out, rank = self._lookup({"homeAddress": "Home St 1"}, None, origin="יגאל אלון 94")
        self.assertTrue(out["ok"])
        self.assertEqual(out["origin_used"], "named")
        self.assertEqual(rank.call_args.kwargs["origin"]["formatted"], "יגאל אלון 94")

    def test_standing_at_home_is_already_there(self):
        out, rank = self._lookup({"homeAddress": "Home St 1"}, {"lat": 32.1, "lng": 34.8})
        self.assertEqual(out["reason"], "already_there")
        rank.assert_not_called()

    def test_understand_keeps_the_start_she_named(self):
        import understand
        lk = understand.lookup_of({"what": "route", "destination": "home", "origin": "יגאל אלון 94"})
        self.assertEqual(lk["origin"], "יגאל אלון 94")
        self.assertEqual(understand.lookup_of({"what": "route", "destination": "home",
                                               "origin": "here"})["origin"], "auto")


class TheVoiceQuestionOfTheEvening(unittest.TestCase):
    """Live on her phone, 7.10: the mic heard "ליאלה חוף מגיעים הכי מהר באוטו
    מהבית?"; the model answered with no "actions" key (it is a question) and
    no modes. Read as a failure, it went down the 50 s path, with no card."""

    def test_a_question_without_an_actions_key_is_understood(self):
        import json
        from types import SimpleNamespace
        import understand
        payload = {"understood": "לאיזה חוף מגיעים הכי מהר מהבית", "kind": "question", "ask": None,
                   "lookup": {"what": "places", "category": "חוף ים", "origin": "home", "modes": []}}
        reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content=json.dumps(payload)))], usage=None)
        client = mock.MagicMock()
        client.chat.completions.create = mock.AsyncMock(return_value=reply)
        with mock.patch.object(understand, "_client", lambda: client):
            out = run(understand.understand("ליאלה חוף מגיעים הכי מהר באוטו מהבית?", [], []))
        self.assertIsNotNone(out)
        self.assertEqual(out["actions"], [])
        self.assertEqual(out["lookup"]["modes"], ["car"], "she said באוטו")
        self.assertEqual(out["lookup"]["origin"], "home")

    def test_named_modes(self):
        self.assertEqual(place_ranker.named_modes("באוטו או באופניים?"), ["car", "bike"])
        self.assertEqual(place_ranker.named_modes("איך אני חוזרת הביתה"), [])
        self.assertEqual(place_ranker.named_modes("by bus or taxi"), ["taxi", "bus"])
        self.assertEqual(place_ranker.named_modes("אוטובוסים"), [], "a whole word, not a prefix of one")


class Modes(unittest.TestCase):
    def test_her_words_become_modes(self):
        self.assertEqual(place_ranker.normalize_modes(["אוטו", "אופניים", "אוטובוס"], None),
                         ["car", "bike", "bus"])
        self.assertEqual(place_ranker.normalize_modes(None, "train"), ["train"])
        self.assertEqual(place_ranker.normalize_modes([], None), ["car"])


class DrivingNeverCarriesArrivalTime(unittest.TestCase):
    """geo sent arrival_time AND departure_time for every timed car trip — a
    request Google refuses. route_proxy already knew; geo did not."""

    def test_driving_with_an_arrival_departs_instead(self):
        p = geo._time_params("driving", "23:59")
        self.assertNotIn("arrival_time", p)
        self.assertIn("departure_time", p)

    def test_driving_now(self):
        self.assertEqual(geo._time_params("driving", None), {"departure_time": "now"})

    def test_transit_arrives_and_does_not_depart(self):
        p = geo._time_params("transit", "23:59")
        self.assertIn("arrival_time", p)
        self.assertNotIn("departure_time", p)

    def test_walking_and_cycling_take_no_clock(self):
        self.assertEqual(geo._time_params("walking", "09:00"), {})
        self.assertEqual(geo._time_params("bicycling", "09:00"), {})


class TheSeaIsABeach(unittest.TestCase):
    """8.10, live: "how do I get to the sea fastest — car, bike or bus?" searched
    Google for "ים" and answered with a pet shop called "ים דגי נוי", by bike
    only — the comparison she asked for was not in the reply."""

    def test_a_bare_sea_word_is_searched_as_a_beach(self):
        for word in ("ים", "הים", "לים", "sea", "The Sea"):
            self.assertIn(place_ranker.search_query(word), ("חוף ים", "beach"), word)
        self.assertEqual(place_ranker.search_query("קופת חולים כללית"), "קופת חולים כללית")

    def test_lookup_asks_google_for_the_beach(self):
        seen = {}

        async def rank(**kw):
            seen.update(kw)
            return {"ok": True, "results": []}

        async def geocode(addr):
            return dict(HOME)

        with mock.patch.object(place_ranker, "rank", rank), mock.patch.object(geo, "geocode", geocode):
            run(place_ranker.lookup(profile={"homeAddress": "Home St 1"},
                                    here=None, category="ים", modes=["car", "bike", "bus"],
                                    origin="home"))
        self.assertEqual(seen["category"], "חוף ים")

    def test_car_bike_or_bus_is_answered_with_all_three(self):
        result = {"kind": "places", "origin_used": "home", "results": [
            {"name": "חוף גורדון", "best": {"mode": "bike", "total_min": 17, "ride_min": 15, "lock_min": 2},
             "by_mode": {"bike": {"mode": "bike", "total_min": 17, "ride_min": 15, "lock_min": 2},
                         "car": {"mode": "car", "total_min": 24, "ride_min": 14, "park_min": 10},
                         "bus": {"mode": "bus", "total_min": 32}}},
            {"name": "חוף הילטון", "best": {"mode": "bike", "total_min": 20, "ride_min": 18}}]}
        lines = place_ranker.say(result, he=True).split("\n")
        self.assertEqual(len(lines), 2)
        self.assertIn("חוף גורדון — ~17 דק׳ באופניים", lines[0])
        self.assertTrue(lines[1].endswith("אחרות: באוטו 24 · באוטובוס 32"), lines[1])

    def test_one_way_asked_still_names_the_next_place(self):
        result = {"kind": "places", "results": [
            {"name": "חוף גורדון", "best": {"mode": "car", "total_min": 24, "ride_min": 14, "park_min": 10},
             "by_mode": {"car": {"mode": "car", "total_min": 24}}},
            {"name": "חוף הילטון", "best": {"mode": "car", "total_min": 26}}]}
        self.assertTrue(place_ranker.say(result, he=True).split("\n")[1].endswith("אחריו: חוף הילטון ~26 דק׳"))


if __name__ == "__main__":
    unittest.main()
