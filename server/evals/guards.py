"""guards — what counts as "the reply claims a save", mirrored from the agent.

lumi_agent.handle_whatsapp_message keeps its anti-fabrication guard INSIDE the
function (`_claim_re`, `_ACTION_TOOLS`, `_succeeded` are locals), so they cannot
be imported. tests/test_fake_confirmation.py already mirrors them for the same
reason. This module is the eval harness's mirror, with one addition the unit
test cannot have: tests/test_evals.py greps lumi_agent.py's source for every
pattern fragment below, so the day someone widens the real guard and not this
mirror, a test fails instead of the hallucination rate quietly meaning less.

MEASURING THE GUARD, NOT COPYING IT. The eval's notion of a hallucination is
the user's: ANY sentence of the FINAL reply that claims a save while nothing was
saved. It is deliberately BROADER than what lumi_agent strips. The production
guard (lumi_agent.is_save_claim) judges a ticked line by this vocabulary, but a
tickless line only in the shapes that cannot be ordinary prose ("הוספתי…",
"Saved!", "Added to …") - because "נוסף", "scheduled" and "updated" are also how
a read answer describes an existing day. A claim that slips between the two
definitions is exactly the finding worth reporting.
"""
from __future__ import annotations

import json
import re

#: Fragments of the claim regex exactly as written in lumi_agent.py. Joined with
#: no separator they are the pattern; the drift test looks for each in the source.
CLAIM_PATTERN_PARTS = (
    r"נשמר|נשמרה|נוצרה|נוצרו|תוזמנ|עודכן|עודכנה|עדכנתי|הוספתי|הוספת|נוסף|נוספה",
    r"|reminder set|saved|scheduled|added|updated",
    r"|בוטל|בוטלה|ביטלתי|מחקתי|נמחק|נמחקה|(?<![א-ת])בטל(?![א-ת])|cancell?ed|deleted|removed",
)
CLAIM_RE = re.compile("".join(CLAIM_PATTERN_PARTS), re.IGNORECASE)

#: Same set as lumi_agent._ACTION_TOOLS.
ACTION_TOOLS = frozenset({
    "infer_task_details", "update_task", "set_reminder", "schedule_message",
    "create_agent", "update_my_agent", "delete_my_agent", "save_profile",
})

#: lumi_agent.ROUTE_TOOLS, and the route-looking-line pattern of its guard #1.
#: A reply may show a route (🚌 / "לצאת ב-08:10") only when one of these ran.
ROUTE_TOOLS = frozenset({"plan_departure", "find_best_place", "route_now", "plan_return_home"})
ROUTE_LINE_PATTERN = (r"[🚶🚆🚄🚌🚇🚋🚗🚲]|(?:לצאת|עזיבה|הגעה|leave|arrive|wake|קימה|להתעורר)"
                      r".*\d{1,2}:\d{2}")
ROUTE_LINE_RE = re.compile(ROUTE_LINE_PATTERN)

#: The two honesty lines the production guards append when they strip something.
GUARD_NOTES = ("לא שמרתי כלום", "Nothing was actually saved", "Nothing was saved",
               "לא שמרתי", "לא נשמר — נסי שוב", "Not saved — try again")


#: A line that DENIES the save ("לא נשמר", "couldn't save", "nothing was saved")
#: is the opposite of a claim even though it contains the claim word.
_NEGATION_RE = re.compile(r"(?:^|\s)(?:לא|אין|בלי)(?:\s|$)|\bnot\b|n't\b|\bnothing\b|\bno\b|\bwithout\b",
                          re.IGNORECASE)


#: "נוסף" is also the adjective "additional" ("אם יש משהו נוסף", "בנוסף"). Only as a
#: line's opening word ("נוסף ליומן: …") is it Lumi reporting an add — the same
#: shape lumi_agent._BARE_CLAIM_RE accepts. 20.10: "תודה רבה!" → "אם יש משהו נוסף
#: – אשמח לעזור" was scored a fake confirmation.
def _adjective(line: str, m: "re.Match") -> bool:
    if m.group(0) != "נוסף":
        return False
    return bool(re.search(r"[א-ת]$", line[:m.start()])) or bool(re.search(r"[^\W\d_]", line[:m.start()]))


def claim_lines(text: str) -> list:
    """Lines of the reply that assert a save/add/set, honest notes and denials excluded."""
    out = []
    for line in (text or "").splitlines():
        if not any(not _adjective(line, m) for m in CLAIM_RE.finditer(line)):
            continue
        if any(note in line for note in GUARD_NOTES) or _NEGATION_RE.search(line):
            continue
        out.append(line.strip())
    return out


def claims_save(text: str) -> bool:
    """Does any sentence of the reply assert something was saved / added / set?"""
    return bool(claim_lines(text))


def claims_route(text: str) -> bool:
    """Does the reply show a route / leave time?"""
    return bool(text and ROUTE_LINE_RE.search(text))


def admits_nothing_saved(text: str) -> bool:
    return any(note in (text or "") for note in GUARD_NOTES)


#: The line guard #1 itself appends after stripping a fabricated route. It carries
#: a train emoji, and it is the guard working, not the model inventing.
ROUTE_OFFER_NOTES = ("רוצה שאחשב מסלול מדויק", "Want me to compute the live route")

#: The agent's own "I could not answer" lines.
STUCK_NOTES = ("נתקעתי רגע", "I got stuck for a moment")


def is_stuck_reply(text: str) -> bool:
    return any(note in (text or "") for note in STUCK_NOTES)


def route_lines(text: str) -> list:
    """Lines that show a route / leave time, the guard's own offer line excluded."""
    return [ln.strip() for ln in (text or "").splitlines()
            if ROUTE_LINE_RE.search(ln) and not any(n in ln for n in ROUTE_OFFER_NOTES)]


def tool_succeeded(content) -> bool:
    """lumi_agent.tool_succeeded: did the tool DO something, not merely run.
    Shapeless or unparseable results count as success (never punish a real one) -
    except text starting "Error:", which is how a tool that blew up reports itself."""
    if isinstance(content, str) and content.lstrip().startswith("Error:"):
        return False
    try:
        data = json.loads(content) if isinstance(content, str) else content
    except (json.JSONDecodeError, TypeError):
        return True
    if not isinstance(data, dict):
        return True
    if data.get("ok") is False:
        return False
    return not (data.get("error") and "ok" not in data)
