"""Python and TypeScript must resolve the same day the same way.

`resolveClashes` lived only on the phone, so a day the app called impossible
was a day WhatsApp had no opinion about. Porting it to `server/clashes.py`
fixes that and creates the older problem in its place: two copies of one rule,
which is the entire history of this codebase.

So neither copy is trusted on its own. `tests/run-clash-parity.ts` runs the
TypeScript over `tests/fixtures/clash-days.json` and writes the answers to
`clash-golden.json`; this runs the SAME fixtures through Python and compares
option kinds, times, labels and the question text, clash by clash.

If this fails, one of the two changed. Regenerate the golden
(`npx tsx tests/run-clash-parity.ts`) and read the diff — it names the rule.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import clashes  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_FIXTURES = os.path.join(_ROOT, "tests", "fixtures", "clash-days.json")
_GOLDEN = os.path.join(_ROOT, "tests", "fixtures", "clash-golden.json")


def _load():
    with open(_FIXTURES, encoding="utf-8") as handle:
        days = json.load(handle)["days"]
    with open(_GOLDEN, encoding="utf-8") as handle:
        golden = json.load(handle)
    assert len(days) == len(golden), "fixtures and golden disagree — regenerate the golden"
    return list(zip(days, golden))


CASES = _load()


@pytest.mark.parametrize("day,expected", CASES, ids=[d["name"] for d, _ in CASES])
def test_python_matches_the_typescript(day, expected):
    actual = clashes.resolve_clashes(day["tasks"], day["dayEnd"])

    assert len(actual) == len(expected["clashes"]), (
        f'{day["name"]}: found {len(actual)} clashes, TypeScript found '
        f'{len(expected["clashes"])}')

    for got, want in zip(actual, expected["clashes"]):
        pair = f'{want["a"]}×{want["b"]}'
        assert got["a"]["id"] == want["a"] and got["b"]["id"] == want["b"], \
            f"{pair}: different pair, or a different order"
        # The verdict the screen and Meira act on. 30.9: the server reported the
        # 18:30 overlap and the phone hid it — this line is what stops that.
        assert got["kind"] == want["kind"], f"{pair}: kind {got['kind']} vs {want['kind']}"
        assert got["overlapMinutes"] == want["overlapMinutes"], f"{pair}: overlap"
        assert got["travelShortfall"] == want["travelShortfall"], f"{pair}: travel shortfall"
        assert got["questionEn"] == want["questionEn"], f"{pair}: English question"
        assert got["questionHe"] == want["questionHe"], f"{pair}: Hebrew question"

        assert [o["kind"] for o in got["options"]] == [o["kind"] for o in want["options"]], (
            f'{pair}: option kinds, or their ORDER — the order is the ranking, '
            f'best first')
        for a, b in zip(got["options"], want["options"]):
            assert a["taskId"] == b["taskId"], f'{pair}: {a["kind"]} acts on a different task'
            assert a.get("newTime") == b["newTime"], f'{pair}: {a["kind"]} proposes a different time'
            assert a["labelEn"] == b["labelEn"], f'{pair}: {a["kind"]} English label'
            assert a["labelHe"] == b["labelHe"], f'{pair}: {a["kind"]} Hebrew label'


def test_the_fixtures_actually_exercise_something():
    """A parity suite that resolves nothing passes for the wrong reason."""
    total = sum(len(g["clashes"]) for _, g in CASES)
    kinds = {o["kind"] for _, g in CASES for c in g["clashes"] for o in c["options"]}
    assert total >= 4, "too few clashes to prove anything"
    assert {"end-earlier", "choose"} <= kinds, f"missing the interesting cases: {kinds}"


def test_a_real_leg_lookup_beats_the_home_route_heuristic():
    """travel_minutes_between reads the route computed for the SECOND task,
    which is a route from home — right when both places are near home, wrong
    otherwise. `leg_lookup` is the seam for a real origin→destination estimate,
    and it must win when it answers."""
    first = {"id": "a", "text": "a", "fixed_time": "09:00", "duration_minutes": 60,
             "location": "Haifa"}
    second = {"id": "b", "text": "b", "fixed_time": "10:00", "duration_minutes": 60,
              "location": {"address": "Eilat", "travelMinutes": 20}}

    assert clashes.travel_minutes_between(first, second) == 20      # the heuristic
    assert clashes.travel_minutes_between(first, second, lambda f, s: 300) == 300
    # An estimator that cannot answer, or throws, falls back rather than breaking.
    assert clashes.travel_minutes_between(first, second, lambda f, s: None) == 20
    assert clashes.travel_minutes_between(
        first, second, lambda f, s: (_ for _ in ()).throw(RuntimeError("no route"))) == 20
