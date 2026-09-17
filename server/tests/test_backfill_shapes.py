"""The backfill reads the shapes the files ACTUALLY have.

Every handler in migrate_json_to_supabase.py was written from the store's
docstring rather than from its bytes, and three of them were wrong in the same
quiet way: they matched nothing and reported "0 rows" — which reads as "nothing
to migrate" and means "your data is about to be left behind".

The fixtures here are the real shapes, taken from the live /data volume:

  conversations.json  {phone: [{role, content}]}          — `content`, not `text`
  known_places.json   {phone: {activity: {address, ...}}} — the activity is the KEY
  travel_prefs.json   {phone: {places|categories: {k: {mode: count}}}} — two levels,
                                                            and counts, not a mode

A dry run counts without writing, so each test asserts the COUNT — which is
exactly the number a human reads off the console before letting it write.
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config                          # noqa: E402
import migrate_json_to_supabase as bf  # noqa: E402


def _with_store(name: str, payload) -> str:
    tmp = tempfile.mkdtemp(prefix="lumi-backfill-")
    with open(os.path.join(tmp, name), "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    config.DATA_DIR = tmp
    return tmp


def test_conversation_turns_use_content_not_text():
    _with_store("conversations.json", {
        "972500000001": [
            {"role": "user", "content": "היי לומי מהממת מה הולך??"},
            {"role": "assistant", "content": "הכל טוב!"},
        ],
    })
    assert asyncio.run(bf._conversations(dry=True)) == 2


def test_a_known_place_is_named_by_its_key():
    _with_store("known_places.json", {
        "500000000": {"@work": {"address": "יגאל אלון 94", "lat": 32.07,
                                "lng": 34.79, "count": 3, "words": []}},
    })
    assert asyncio.run(bf._places(dry=True)) == 1


def test_a_place_with_no_address_is_not_a_place():
    _with_store("known_places.json", {"500000000": {"@nowhere": {"count": 1}}})
    assert asyncio.run(bf._places(dry=True)) == 0


def test_travel_prefs_are_two_levels_deep_and_hold_counts():
    _with_store("travel_prefs.json", {
        "500000000": {
            "places": {"space gym": {"bus": 3, "car": 1}, "work": {"car": 2}},
            "categories": {"gym": {"bus": 4}, "work": {"car": 2}},
        },
    })
    assert asyncio.run(bf._travel(dry=True)) == 4


def test_the_winning_travel_mode_is_the_most_used_one():
    _with_store("travel_prefs.json", {
        "500000000": {"places": {"space gym": {"bus": 5, "car": 1}}},
    })
    captured = {}

    async def capture(user_key, route, mode, mirror=None):
        captured[route] = mode
        return True

    original = bf.db.remember_travel_mode
    bf.db.remember_travel_mode = capture
    try:
        asyncio.run(bf._travel(dry=False))
    finally:
        bf.db.remember_travel_mode = original
    assert captured == {"place:space gym": "bus"}


def test_mirrored_tasks_are_deliberately_left_out_of_memories():
    """30 mirrored tasks and 3 real insights must yield 3, not 33 — the tasks
    already live in Supabase's tasks table, and a third copy is how they
    diverge. This asserts the decision so nobody 'fixes' it later."""
    _with_store("user_memory.json", {
        "972500000001": {
            "tasks": [{"text": f"task {i}"} for i in range(30)],
            "preferences": ["3h study blocks"],
            "contacts": [{"name": "אמא", "number": "0501234567"}],
            "behaviors": ["always studies after 21:00"],
            "routines": [],
        },
    })
    assert asyncio.run(bf._memories(dry=True)) == 3


def test_rerunning_cannot_duplicate_conversation_turns():
    """The two tables with surrogate keys had nothing to conflict on, so a
    second run turned 18 turns into 36. Each backfilled row now carries a
    stable dedupeKey, and the same file must always produce the same key."""
    _with_store("conversations.json", {
        "972500000001": [{"role": "user", "content": "היי"},
                         {"role": "assistant", "content": "שלום"}],
    })
    seen = []

    async def capture(user_key, role, text, channel="whatsapp",
                      dedupe_key=None, mirror=None):
        seen.append(dedupe_key)
        return True

    original = bf.db.append_turn
    bf.db.append_turn = capture
    try:
        asyncio.run(bf._conversations(dry=False))
        first = list(seen)
        seen.clear()
        asyncio.run(bf._conversations(dry=False))
    finally:
        bf.db.append_turn = original

    assert all(first), "every backfilled turn needs a dedupe key"
    assert len(set(first)) == 2, "two different turns must not share a key"
    assert first == seen, "the same file must produce the same keys every run"


def test_rerunning_cannot_duplicate_sessions():
    _with_store("sessions.json", {
        "500000000": {"whatsapp": {"id": "whatsapp-abc123", "turns": 4}},
    })
    seen = []

    async def capture(user_key, kind, payload, dedupe_key=None, mirror=None):
        seen.append(dedupe_key)
        return True

    original = bf.db.record_session
    bf.db.record_session = capture
    try:
        asyncio.run(bf._sessions(dry=False))
        asyncio.run(bf._sessions(dry=False))
    finally:
        bf.db.record_session = original

    assert seen[0] and seen[0] == seen[1], "one session, one stable key"


def test_an_empty_data_dir_moves_nothing_rather_than_erroring():
    _with_store("unrelated.json", {})
    for handler in bf.HANDLERS.values():
        assert asyncio.run(handler(True)) == 0
