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
