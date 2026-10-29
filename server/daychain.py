"""Order the day's trips into a chain and decide which need re-planning.

The server used to route only the trips ONE message created, each from home.
But the day is a chain: an 18:00 gym then a 20:00 party means the party starts
at the gym, not at home — and inserting a task in the middle shifts the leave
time of everything after it. The app's ensureTravelChain has always done this
on the phone; moving it here is the "one brain" step, so a WhatsApp-only user
gets the same correct chain the app user does.

The key that makes this cheap: a trip's origin is the previous trip's ADDRESS,
which is known from the task itself whether or not that leg's route was ever
computed. So the whole day can be chained without routing every leg, and a leg
is re-planned only when its recorded origin no longer matches the chain — which
is exactly what the server now stamps as transitPlan.originAddress.

Pure: no I/O, no LLM, no network. main.py does the Google fetch and the
persistence; this decides order and staleness. That keeps the expensive,
OOM-sensitive part gated by a testable rule.
"""
import re
from typing import Optional

# A location that is a URL / meeting link is not somewhere to travel to.
_LINK_RE = re.compile(r"https?://|zoom\.|meet\.|teams\.|\.us/j/", re.IGNORECASE)


def address_of(task: dict) -> Optional[str]:
    """The place to travel to, or None (no location, or a meeting link)."""
    loc = task.get("location")
    if isinstance(loc, str):
        addr = loc
    elif isinstance(loc, dict):
        addr = loc.get("address") or loc.get("displayName")
    else:
        addr = None
    if not addr or _LINK_RE.search(addr):
        return None
    return without_appended_street(addr)


_STREET_END = re.compile(r"(?:^|\s)(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|רחוב|רח')$", re.I)


def without_appended_street(addr: str) -> str:
    """Undo the phone's old cityOf (13.10): it read the STREET of a home written
    "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo" as the city and glued it onto
    venues — "רפאל מכון דוד, Mordei ha-Geta'ot Street" could not be found
    (route_failed: destination). A last segment that is a bare street name is
    never how a place ends. Mirrors utils/addressCompletion.withoutAppendedStreet."""
    parts = [p.strip() for p in str(addr).split(",")]
    if len(parts) >= 2 and not re.search(r"\d", parts[-1]) and _STREET_END.search(parts[-1]):
        return ", ".join(parts[:-1])
    return addr


def _time_of(task: dict) -> Optional[str]:
    t = task.get("fixed_time")
    return str(t)[:5] if t else None


def recorded_origin(task: dict) -> Optional[str]:
    """Where this task's stored plan was computed FROM, if it has one."""
    loc = task.get("location")
    if isinstance(loc, dict):
        plan = loc.get("transitPlan")
        if isinstance(plan, dict):
            return plan.get("originAddress")
    return None


def day_chain(tasks: list, home_address: str, date: str) -> list:
    """The located + timed pending trips for `date`, in clock order, each paired
    with the address the trip starts FROM (the previous trip's place; home for
    the first).

    Returns [(task, origin_address)]. A task with no address or no time is not a
    trip and is left out — but a non-trip never sits between two trips in a way
    that changes origins, because origin is carried by the previous TRIP only.
    """
    trips = [
        t for t in tasks
        if t.get("status", "pending") == "pending"
        and t.get("date") == date
        and address_of(t)
        and _time_of(t)
    ]
    trips.sort(key=lambda t: _time_of(t) or "99:99")

    out = []
    prev = home_address
    for t in trips:
        out.append((t, prev))
        prev = address_of(t)
    return out


def needs_replan(task: dict, origin: str, home_address: str) -> bool:
    """True when this trip's stored route no longer matches the chain.

    Re-plan when there is no route yet, or when the origin it was computed from
    is not the chain's current previous stop. An unchanged origin means the
    stored leave time is still correct — so it is left alone, which is what
    keeps a message from re-hitting Google for every trip of the day.
    """
    loc = task.get("location")
    has_plan = isinstance(loc, dict) and isinstance(loc.get("transitPlan"), dict)
    if not has_plan:
        return True
    rec = recorded_origin(task)
    if rec is None:
        # A plan from before origin was stamped assumed home. Only re-plan if
        # the chain now says the trip starts somewhere else.
        return origin != home_address
    return rec != origin


def chosen_mode(row: Optional[dict]) -> Optional[str]:
    """The vehicle SHE picked for a saved appointment on her phone (the card's chips,
    or the evening-before question), or None.

    18.10: the chat planned a bus while the task stood on a car — the phone's choice
    is hers, and the chat must say the same. A stored vehicle with no `transportTypeBy`
    predates the ladder: it was hers too. A ladder's own pick is not a choice."""
    loc = (row or {}).get("location")
    if not isinstance(loc, dict):
        return None
    mode = loc.get("transportType")
    by = loc.get("transportTypeBy")
    return mode if mode in ("bus", "train", "car", "walk", "bike") and by in (None, "her") else None
