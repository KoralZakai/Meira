"""persona_sim — run a made-up person's week past the real agent and watch.

The four things the app still cannot do — plan from where you ACTUALLY are,
ask how you travel and remember it, remember where your gym is, and tell you
when you get home — are all scheduling judgement, not parsing. Judgement is
hard to argue about in the abstract and easy to argue about in front of a
specific person's Tuesday.

So: Dana Levi, invented, co-parenting half the week, meetings around the
country (personas/dana.json). Her week is the shape that breaks naive
schedulers — the constraints change by weekday and the driving dominates
everything. Three cases:

    cancellation   a meeting drops, what fills the hole
    schedule_new   where does a new 90-minute meeting in Jerusalem go
    am_i_free      friends want Wednesday evening — yes or no

This is a DIAGNOSTIC, not a test: it calls the live model, so it is not
deterministic and must never gate CI. It answers "what does Lumi do today",
which is the only honest place to start building from.

    python persona_sim.py            # all three cases
    python persona_sim.py am_i_free  # just one

Writes nothing to a real user: it seeds a scratch phone and clears it after.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PERSONA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "personas", "dana.json")
SCRATCH_PHONE = "000000000000"   # never a real number


def load_persona() -> dict:
    with open(PERSONA, encoding="utf-8") as f:
        return json.load(f)


def seed(persona: dict) -> None:
    """Put the week into the scratch user's memory, the way real tasks arrive.

    The PROFILE matters as much as the tasks. check_availability reads
    defaultWakeTime, sleepTime and homeAddress off it — and user_profile's
    _DEFAULTS has none of the first two and an empty third. Seeding only the
    tasks meant the first run of this harness measured a day hardcoded to
    08:00-22:00 (Dana's 06:30/23:00 ignored) with every travel leg returning
    None, because _travel() short-circuits without a home address. Half the
    engine was switched off and the failures were being blamed on the agent.
    """
    import user_memory
    import user_profile
    data = user_memory._load()
    data.pop(SCRATCH_PHONE, None)
    user_memory._save(data)

    user_profile.update_profile(
        SCRATCH_PHONE,
        name=persona["name"],
        language="he",
        homeAddress=persona["home"],
        transportType=persona.get("transport_default") or "car",
        defaultWakeTime=persona["wake"],
        sleepTime=persona["sleep"],
        # The tool's docstring tells the model to read this and refuse a slot
        # that lands on one, by name. Empty, it had nothing to read.
        routinesNotes="; ".join(c["note"] for c in persona["constraints"]),
        onboarded=True,
        routineVerified=True,
    )

    for day in persona["week"]:
        for t in day["tasks"]:
            task = {
                "text": t["text"],
                "date": day["date"],
                "category": "general",
                "priority": "must" if t.get("fixed") else "need_to",
                "duration_minutes": t.get("duration", 60),
                "status": "pending",
            }
            if t.get("time"):
                task["fixed_time"] = t["time"]
            if t.get("place"):
                task["location"] = t["place"]
            user_memory.add_task(SCRATCH_PHONE, task)

    # What Lumi is supposed to already know about her.
    for line in persona["constraints"]:
        kind = "routine" if line["kind"] in ("routine", "kids") else "preference"
        user_memory.add_insight(SCRATCH_PHONE, kind, line["note"])
    try:
        import known_places
        for activity, address in persona["known_places"].items():
            known_places.remember(SCRATCH_PHONE, activity, address)
    except Exception as exc:  # noqa: BLE001
        print(f"  (known_places seed skipped: {exc})")


def cleanup() -> None:
    import user_memory
    import user_profile
    data = user_memory._load()
    data.pop(SCRATCH_PHONE, None)
    user_memory._save(data)
    profiles = user_profile._load()
    if profiles.pop(SCRATCH_PHONE, None) is not None:
        user_profile._save(profiles)


async def run_case(persona: dict, case: dict) -> None:
    import lumi_agent
    print("\n" + "=" * 72)
    print(f"CASE  {case['id']}")
    print(f"ASK   {case['prompt']}")
    print("-" * 72)
    user = {"id": SCRATCH_PHONE, "whatsapp_phone": SCRATCH_PHONE,
            "name": persona["name"], "language": "he"}
    try:
        result = await lumi_agent.handle_whatsapp_message(case["prompt"], user, None)
        print(result.get("text", "(no text)"))
    except Exception as exc:  # noqa: BLE001
        print(f"AGENT FAILED: {exc}")
    print("-" * 72)
    print("SHOULD HAVE:")
    for line in case["expects"]:
        print(f"  · {line}")


async def main() -> None:
    persona = load_persona()
    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    cases = [c for c in persona["cases"] if not wanted or c["id"] == wanted]
    if not cases:
        print(f"no case named {wanted!r}; have: "
              + ", ".join(c["id"] for c in persona["cases"]))
        return

    print(f"persona: {persona['name']} — {persona['note']}")
    seed(persona)
    try:
        for case in cases:
            await run_case(persona, case)
    finally:
        cleanup()
    print("\n" + "=" * 72)
    print("Diagnostic only — live model, not deterministic. Never gate CI on this.")


if __name__ == "__main__":
    asyncio.run(main())
