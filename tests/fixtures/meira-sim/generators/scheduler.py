"""
Meira's decision layer: insert / cancel / rank. Pure functions, no LLM, no I/O.

Three questions this answers:
  can_insert()             a new meeting arrives at a location - does it fit? if not, when?
  on_cancel()              a meeting is dropped - what does that free, and what now fits?
  review_interview_slots() the user offers candidate times - rank them, propose three

Why deterministic: these are constrained searches over a small space with a scoring
function. An LLM asked "which slot is best" gives a different answer on rerun, can't be
unit-tested, and costs a round trip per candidate. Same argument as keeping the
personality scorer zero-LLM. The LLM's job is to phrase the result, not compute it.

Everything here uses predict_* only. Realized travel is not visible to a planner.
"""
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from personas import LOC, TZ, haversine_km, ll, local, predict_minutes, rush_factor

# ---------------------------------------------------------------- tuning
# One visible block. Costs are in "penalty minutes" so they stay comparable.
WEIGHTS = dict(
    travel=1.0,        # per minute of door-to-door travel the slot creates
    dead_time=0.6,     # per minute of idle waiting it creates (less bad than travelling)
    early_wake=1.5,    # per minute the required wake is before the user's normal wake
    rush=0.4,          # per minute of travel that departs inside a rush window
    tightness=2.0,     # per minute of margin the slot is SHORT of comfortable
    cluster_bonus=25.0,  # flat credit when the slot sits next to a meeting in the same area
)
CLUSTER_RADIUS_KM = 2.5      # "same area" for the clustering credit
COMFORT_FACTOR = 2.0         # slack >= margin * this is comfortable; below it costs
SLOT_GRANULARITY_MIN = 15    # search step when looking for the earliest feasible start
DAY_END_LOCAL = "22:00"      # nothing is scheduled to start after this
HORIZON_DAYS = 7             # how far ahead to look once the requested day fails
WORKDAYS = (6, 0, 1, 2, 3)   # Sun..Thu


# ---------------------------------------------------------------- types
@dataclass(frozen=True)
class Proposal:
    title: str
    location_id: int | None        # None = online
    duration_min: int
    category: str = "meeting"

    @property
    def is_online(self) -> bool:
        return self.location_id is None


@dataclass
class Transition:
    from_id: object
    to_id: object
    gap_min: int | None
    travel_min: int
    margin_min: float
    status: str
    required_wake: str = ""


@dataclass
class Verdict:
    feasible: bool
    status: str                       # OK | TIGHT | INFEASIBLE_TRAVEL | OVERLAP | WAKE_CONFLICT | OUTSIDE_DAY
    blocking: list = field(default_factory=list)   # the Transitions that failed
    detail: str = ""


@dataclass
class SlotOption:
    day: str
    start_local: str
    end_local: str
    cost: float
    travel_in: int
    travel_out: int
    dead_min: int
    required_wake: str
    reasons: list = field(default_factory=list)


# ---------------------------------------------------------------- helpers
def margin_for(person, profile=None) -> float:
    """buffer + learned departure delay. Never learned from arrival lateness."""
    learned = (profile or {}).get("avg_depart_delay", 0.0)
    return person["buffer"] + max(0.0, learned)


def _pos_of(person, m):
    return person["home"] if m is None else ll(m["location_id"])


def _sorted_day(meetings):
    return sorted(meetings, key=lambda m: m["start_local"])


def evaluate_timeline(person, day: date, meetings, profile=None) -> list[Transition]:
    """
    Walk one day and label every transition. Position is the last PHYSICAL location,
    home at day start; an online meeting occupies time but does not move you.
    """
    margin = margin_for(person, profile)
    out, pos, pos_id, free_at = [], person["home"], "home", None
    for m in _sorted_day(meetings):
        if m["is_online"]:
            travel, dest_id, use_margin = 0, "online", 0.0
        else:
            dest_id = m["location_id"]
            dest = ll(dest_id)
            depart_guess = free_at or (m["start_local"] - timedelta(hours=1))
            travel = predict_minutes(pos, dest, person["mode"], depart_guess)
            use_margin = margin
        if free_at is None:
            if not m["is_online"]:
                wake = m["start_local"] - timedelta(minutes=travel + use_margin + person["routine"])
                earliest = local(day, person["earliest_wake"])
                out.append(Transition("home", dest_id, None, travel, use_margin,
                                      "WAKE_CONFLICT" if wake < earliest else "OK",
                                      wake.strftime("%H:%M")))
        else:
            gap = (m["start_local"] - free_at).total_seconds() / 60
            status = ("OVERLAP" if gap < 0 else
                      "INFEASIBLE_TRAVEL" if gap < travel else
                      "TIGHT" if gap < travel + use_margin else "OK")
            out.append(Transition(pos_id, dest_id, int(gap), travel, use_margin, status))
        if not m["is_online"]:
            pos, pos_id = ll(dest_id), dest_id
        free_at = max(free_at, m["end_local"]) if free_at else m["end_local"]
    return out


# ---------------------------------------------------------------- 1. insertion
def _as_meeting(prop: Proposal, start: datetime) -> dict:
    return dict(id="__proposed__", title=prop.title, category=prop.category,
                location_id="" if prop.is_online else prop.location_id,
                is_online=int(prop.is_online),
                start_local=start, end_local=start + timedelta(minutes=prop.duration_min))


def can_insert(person, day: date, meetings, prop: Proposal, start: datetime,
               profile=None) -> Verdict:
    """Would this proposal fit at exactly this start time, given the day as it stands?"""
    if start > local(day, DAY_END_LOCAL):
        return Verdict(False, "OUTSIDE_DAY", [], f"starts after {DAY_END_LOCAL}")
    before = {id(t): t for t in []}  # placeholder to keep intent clear
    candidate = _as_meeting(prop, start)
    after = evaluate_timeline(person, day, list(meetings) + [candidate], profile)

    # a transition already broken before the insert is not this proposal's fault
    baseline = evaluate_timeline(person, day, meetings, profile)
    was_bad = sum(1 for t in baseline if t.status != "OK")
    now_bad = [t for t in after if t.status != "OK"]
    if len(now_bad) <= was_bad and not _touches(now_bad, candidate):
        return Verdict(True, "OK", [], "")
    blocking = [t for t in now_bad if _touches([t], candidate)]
    if not blocking:
        return Verdict(True, "OK", [], "")
    worst = min(blocking, key=lambda t: ["OVERLAP", "INFEASIBLE_TRAVEL", "WAKE_CONFLICT",
                                         "TIGHT", "OK"].index(t.status))
    return Verdict(worst.status in ("OK", "TIGHT"), worst.status, blocking, "")


def _touches(transitions, candidate) -> bool:
    cid = candidate["location_id"] if not candidate["is_online"] else "online"
    return any(t.to_id == cid or t.from_id == cid for t in transitions)


def earliest_feasible_on(person, day: date, meetings, prop: Proposal, profile=None,
                         not_before: datetime | None = None) -> datetime | None:
    """First start time on this day at which the proposal fits. None if the day is full."""
    first = not_before or local(day, person["earliest_wake"]) + timedelta(minutes=person["routine"])
    last = local(day, DAY_END_LOCAL) - timedelta(minutes=prop.duration_min)
    step = timedelta(minutes=SLOT_GRANULARITY_MIN)
    # align up to the next granularity boundary
    t = first + timedelta(minutes=(-first.minute) % SLOT_GRANULARITY_MIN,
                          seconds=-first.second, microseconds=-first.microsecond)
    while t <= last:
        if can_insert(person, day, meetings, prop, t, profile).feasible:
            return t
        t += step
    return None


def when_possible(person, requested_day: date, meetings_by_day, prop: Proposal,
                  profile=None, horizon=HORIZON_DAYS, k=3) -> list[SlotOption]:
    """
    Requested day first, then the next `horizon` working days. Returns up to k options
    ranked by cost, cheapest first.
    """
    options = []
    days = [requested_day] + [requested_day + timedelta(d) for d in range(1, horizon + 1)]
    for d in days:
        if d != requested_day and d.weekday() not in WORKDAYS:
            continue
        day_meetings = meetings_by_day.get(d.isoformat(), [])
        t = earliest_feasible_on(person, d, day_meetings, prop, profile)
        while t is not None and len(options) < k * 4:
            options.append(score_slot(person, d, day_meetings, prop, t, profile))
            nxt = earliest_feasible_on(person, d, day_meetings, prop, profile,
                                       not_before=t + timedelta(minutes=90))
            t = nxt if nxt and nxt > t else None
    options.sort(key=lambda o: (o.cost, o.day, o.start_local))
    return options[:k]


# ---------------------------------------------------------------- scoring
def score_slot(person, day: date, meetings, prop: Proposal, start: datetime,
               profile=None) -> SlotOption:
    """Cost in penalty minutes. Lower is better. Every term is explained in `reasons`."""
    margin = margin_for(person, profile)
    end = start + timedelta(minutes=prop.duration_min)
    ordered = _sorted_day(meetings)
    prev = next((m for m in reversed(ordered)
                 if m["end_local"] <= start and not m["is_online"]), None)
    nxt = next((m for m in ordered
                if m["start_local"] >= end and not m["is_online"]), None)

    here = person["home"] if prop.is_online else ll(prop.location_id)
    travel_in = 0 if prop.is_online else predict_minutes(
        _pos_of(person, prev), here, person["mode"],
        prev["end_local"] if prev else start - timedelta(hours=1))
    travel_out = 0 if (prop.is_online or nxt is None) else predict_minutes(
        here, ll(nxt["location_id"]), person["mode"], end)

    cost, reasons = 0.0, []
    cost += WEIGHTS["travel"] * (travel_in + travel_out)
    if travel_in + travel_out:
        reasons.append(f"{travel_in + travel_out} min travel")

    # idle waiting this slot creates on either side
    dead = 0
    if prev:
        dead += max(0, int((start - prev["end_local"]).total_seconds() // 60) - travel_in - int(round(margin)))
    if nxt:
        dead += max(0, int((nxt["start_local"] - end).total_seconds() // 60) - travel_out - int(round(margin)))
    if dead > 30:
        cost += WEIGHTS["dead_time"] * (dead - 30)
        reasons.append(f"{int(round(dead))} min idle between commitments")

    # early wake, only when this becomes the first physical thing of the day
    required_wake = ""
    if prev is None and not prop.is_online:
        wake = start - timedelta(minutes=travel_in + margin + person["routine"])
        required_wake = wake.strftime("%H:%M")
        normal = local(day, person["earliest_wake"]) + timedelta(minutes=45)
        if wake < normal:
            early = int((normal - wake).total_seconds() // 60)
            cost += WEIGHTS["early_wake"] * early
            reasons.append(f"wake at {required_wake}, {early} min earlier than usual")

    # departing into rush hour
    # you leave when you leave, not when the previous meeting ended - a long wait in
    # between means the drive itself is off-peak even if the meeting ended at 17:30
    leave_at = start - timedelta(minutes=travel_in)
    if prev:
        leave_at = max(prev["end_local"], leave_at)
    dep_hour = leave_at.hour
    if rush_factor(dep_hour) > 1.2 and travel_in:
        cost += WEIGHTS["rush"] * travel_in
        reasons.append("travels in rush hour")

    # how much slack is left versus comfortable
    if prev:
        slack = int((start - prev["end_local"]).total_seconds() // 60) - travel_in
        short = max(0.0, margin * COMFORT_FACTOR - slack)
        if short > 0:
            cost += WEIGHTS["tightness"] * short
            reasons.append(f"only {int(slack)} min slack after the previous meeting")

    # clustering credit: already going to that area
    if not prop.is_online:
        for neighbour in (prev, nxt):
            if neighbour and haversine_km(ll(neighbour["location_id"]), here) <= CLUSTER_RADIUS_KM:
                cost -= WEIGHTS["cluster_bonus"]
                reasons.append(f"same area as '{neighbour['title'][:32]}'")
                break

    return SlotOption(day=day.isoformat(), start_local=start.strftime("%H:%M"),
                      end_local=end.strftime("%H:%M"), cost=round(cost, 1),
                      travel_in=travel_in, travel_out=travel_out, dead_min=dead,
                      required_wake=required_wake, reasons=reasons)


# ---------------------------------------------------------------- 2. cancellation
def on_cancel(person, day: date, meetings, cancelled_id, candidates, profile=None) -> dict:
    """
    Report what the cancellation frees and which pending items now fit.
    Suggests; does not move anything. `candidates` are Proposals the user already wants.
    """
    remaining = [m for m in meetings if m["id"] != cancelled_id]
    gone = next(m for m in meetings if m["id"] == cancelled_id)

    before = evaluate_timeline(person, day, meetings, profile)
    after = evaluate_timeline(person, day, remaining, profile)
    resolved = max(0, sum(1 for t in before if t.status != "OK")
                   - sum(1 for t in after if t.status != "OK"))

    ordered = _sorted_day(remaining)
    prev = next((m for m in reversed(ordered) if m["end_local"] <= gone["start_local"]), None)
    nxt = next((m for m in ordered if m["start_local"] >= gone["end_local"]), None)
    window_from = prev["end_local"] if prev else local(day, person["earliest_wake"]) + timedelta(minutes=person["routine"])
    window_to = nxt["start_local"] if nxt else local(day, DAY_END_LOCAL)

    now_fits, fits_elsewhere = [], []
    for prop in candidates:
        t = earliest_feasible_on(person, day, remaining, prop, profile, not_before=window_from)
        if t is None:
            continue
        opt = score_slot(person, day, remaining, prop, t, profile)
        inside = t + timedelta(minutes=prop.duration_min) <= window_to
        (now_fits if inside else fits_elsewhere).append(opt)
    now_fits.sort(key=lambda o: o.cost)
    fits_elsewhere.sort(key=lambda o: o.cost)

    return dict(
        cancelled=gone["title"],
        freed_from=window_from.strftime("%H:%M"), freed_to=window_to.strftime("%H:%M"),
        freed_minutes=int((window_to - window_from).total_seconds() // 60),
        conflicts_resolved=resolved,
        remaining_conflicts=[t.status for t in after if t.status != "OK"],
        now_fits=now_fits,                # inside the window the cancellation freed
        fits_elsewhere_today=fits_elsewhere)   # placeable today, but not in that window


# ---------------------------------------------------------------- 3. interview slots
def review_interview_slots(person, meetings_by_day, slots, prop: Proposal,
                           profile=None, k=3) -> dict:
    """
    `slots` are the times the user offered: [(date, 'HH:MM'), ...].
    Returns a verdict per offered slot, plus up to k recommendations - the user's
    workable slots first, topped up with Meira's own suggestions if fewer than k work.
    """
    reviewed = []
    for d, hhmm in slots:
        day_meetings = meetings_by_day.get(d.isoformat(), [])
        start = local(d, hhmm)
        v = can_insert(person, d, day_meetings, prop, start, profile)
        opt = score_slot(person, d, day_meetings, prop, start, profile)
        reviewed.append(dict(day=d.isoformat(), start_local=hhmm, status=v.status,
                             feasible=v.feasible, cost=opt.cost, travel_in=opt.travel_in,
                             travel_out=opt.travel_out, required_wake=opt.required_wake,
                             reasons=opt.reasons,
                             blocking=[f"{t.status} ({t.travel_min} min travel, "
                                       f"{t.gap_min} min gap)" for t in v.blocking]))

    # Policy: the user's own offered times win ties and near-ties - they picked them
    # because they suit the other side too, which no cost function here can see.
    # A cheaper Meira slot is still surfaced, flagged, so the UI can offer the trade.
    workable = sorted([r for r in reviewed if r["feasible"]], key=lambda r: r["cost"])
    recommended = [dict(source="user_offered", cheaper_alternative=None, **r)
                   for r in workable[:k]]

    if len(recommended) < k:
        first_day = min(d for d, _ in slots)
        taken = {(r["day"], r["start_local"]) for r in recommended}
        for o in when_possible(person, first_day, meetings_by_day, prop, profile,
                               k=k * 3):
            if (o.day, o.start_local) in taken:
                continue
            recommended.append(dict(source="meira_suggested", day=o.day,
                                    start_local=o.start_local, status="OK", feasible=True,
                                    cost=o.cost, travel_in=o.travel_in, travel_out=o.travel_out,
                                    required_wake=o.required_wake, reasons=o.reasons,
                                    blocking=[], cheaper_alternative=None))
            if len(recommended) == k:
                break

    final = recommended[:k]
    # flag every user-offered pick that a suggestion beats on cost
    cheapest_suggested = min((r for r in final if r["source"] == "meira_suggested"),
                             key=lambda r: r["cost"], default=None)
    if cheapest_suggested:
        for r in final:
            if r["source"] == "user_offered" and r["cost"] > cheapest_suggested["cost"]:
                r["cheaper_alternative"] = dict(
                    day=cheapest_suggested["day"], start_local=cheapest_suggested["start_local"],
                    saves=round(r["cost"] - cheapest_suggested["cost"], 1))
    return dict(reviewed=reviewed, recommended=final)
