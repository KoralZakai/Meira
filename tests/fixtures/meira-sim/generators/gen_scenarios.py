"""
Builds the decision-layer fixtures: insertion, cancellation and interview-slot cases,
each with the expected answer computed by scheduler.py.

Outputs:
  data/scenarios.json           inputs only - hand these to the app
  data/scenarios_expected.json  golden answers
  data/scenarios_summary.csv    one line per case, for eyeballing a diff
"""
import csv
import json
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

from personas import LOC, P, PERSONAS, TZ, local
from scheduler import (Proposal, can_insert, evaluate_timeline, on_cancel,
                       review_interview_slots, score_slot, when_possible)

HERE = Path(__file__).parent
DATA = HERE.parent / "data"


def load_meetings():
    by_user_day, by_id = {}, {}
    with open(DATA / "sim_meetings.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            d = date.fromisoformat(r["date"])
            sh, sm = map(int, r["start_local"].split(":"))
            eh, em = map(int, r["end_local"].split(":"))
            start = datetime.combine(d, datetime.min.time(), TZ) + timedelta(hours=sh, minutes=sm)
            end = datetime.combine(d, datetime.min.time(), TZ) + timedelta(hours=eh, minutes=em)
            if end <= start:
                end += timedelta(days=1)
            m = dict(id=int(r["id"]), title=r["title"], category=r["category"],
                     location_id=int(r["location_id"]) if r["location_id"] else "",
                     is_online=int(r["is_online"]), start_local=start, end_local=end)
            by_user_day.setdefault(int(r["user_id"]), {}).setdefault(r["date"], []).append(m)
            by_id[m["id"]] = m
    return by_user_day, by_id


MBD, BY_ID = load_meetings()

# learned profile at the end of the simulated month, so the margins are realistic
PROFILE = {}
with open(DATA / "sim_learning_trace.csv", newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        PROFILE[int(r["user_id"])] = dict(avg_depart_delay=float(r["avg_depart_delay_minutes"]))


def jsonable(x):
    if is_dataclass(x):
        return {k: jsonable(v) for k, v in asdict(x).items()}
    if isinstance(x, list):
        return [jsonable(i) for i in x]
    if isinstance(x, dict):
        return {k: jsonable(v) for k, v in x.items()}
    return x



def day_window(day, day_meetings, default_lo="08:00", default_hi="20:00"):
    """Insertion is tested INSIDE the existing day: from the first commitment to the last."""
    if not day_meetings:
        return local(day, default_lo), local(day, default_hi)
    return (min(m["start_local"] for m in day_meetings),
            max(m["end_local"] for m in day_meetings))


def scan(person, day, day_meetings, prop, profile, lo=None, hi=None, step=15):
    """Every start time in the window with the status it would produce."""
    w_lo, w_hi = day_window(day, day_meetings)
    out = []
    t = local(day, lo) if lo else w_lo
    end = local(day, hi) if hi else w_hi
    while t <= end:
        out.append((t, can_insert(person, day, day_meetings, prop, t, profile).status))
        t += timedelta(minutes=step)
    return out


def pick(person, day, day_meetings, prop, profile, want, lo=None, hi=None):
    """First start time in the window that produces `want`. Raises if the day has none."""
    for t, st in scan(person, day, day_meetings, prop, profile, lo, hi):
        if st == want:
            return t
    raise SystemExit(f"no {want} slot for '{prop.title}' on {day} "
                     f"(available: {sorted({s for _, s in scan(person, day, day_meetings, prop, profile, lo, hi)})})")


cases, expected, summary = [], [], []


def loc_name(i):
    return LOC[i][1] if i in LOC else "online"


# ---------------------------------------------------------------- A. insertion
INSERTS = [
    # (case, user, day, title, location, minutes, TARGET STATUS, what it probes)
    # The start time is chosen by pick() so each verdict is covered deliberately
    # rather than by hand-tuned clock times that drift when the schedule changes.
    ("INS-01", 101, "2026-10-12", "Site survey — Netanya Poleg Park", 44, 45, "OK",
     "driver: an extra stop 1 km from a visit he is already making - exercises the clustering credit"),
    ("INS-02", 101, "2026-10-12", "Site survey — Port of Ashdod", 35, 90, "INFEASIBLE_TRAVEL",
     "same day, other end of the country: travel is the binding constraint, not the gap"),
    ("INS-03", 101, "2026-10-08", "Contract review (online)", None, 45, "OK",
     "online task on a packed Be'er Sheva day: no travel, only overlap can block it"),
    ("INS-04", 101, "2026-10-12", "Lunch demo — Azrieli Center", 21, 45, "TIGHT",
     "fits only by eating the safety margin - the case a naive gap check would wave through"),
    ("INS-05", 102, "2026-10-13", "Dentist — Dizengoff Center", 41, 45, "OVERLAP",
     "commuter, office day: lands on top of an existing block"),
    ("INS-06", 102, "2026-10-07", "Coffee with recruiter — Cafe Xoho", 23, 60, "OK",
     "commuter, work-from-home day: the realistic window for an extra trip"),
    ("INS-07", 103, "2026-10-12", "Library session — TAU", 14, 120, "OK",
     "control user: a local task on a quiet day must fit"),
    ("INS-08", 103, "2026-10-12", "Interview — NVIDIA Yokneam", 3, 90, "INFEASIBLE_TRAVEL",
     "control user sent far outside her cycling radius: must fail on every day"),
]
for cid, uid, dstr, title, locid, dur, want, probe in INSERTS:
    person = P[uid]
    day = date.fromisoformat(dstr)
    day_meetings = MBD[uid].get(dstr, [])
    prop = Proposal(title=title, location_id=locid, duration_min=dur,
                    category="interview" if "Interview" in title else "meeting")
    start = pick(person, day, day_meetings, prop, PROFILE[uid], want)
    hhmm = start.strftime("%H:%M")
    verdict = can_insert(person, day, day_meetings, prop, start, PROFILE[uid])
    assert verdict.status == want, (cid, verdict.status, want)
    alts = [] if verdict.feasible else when_possible(person, day, MBD[uid], prop,
                                                     PROFILE[uid], k=3)
    scored = score_slot(person, day, day_meetings, prop, start, PROFILE[uid]) if verdict.feasible else None

    cases.append(dict(case_id=cid, kind="insert", user_id=uid, date=dstr,
                      proposal=dict(title=title, location_id=locid,
                                    location_name=loc_name(locid) if locid else "online",
                                    duration_min=dur, desired_start_local=hhmm),
                      existing_meeting_ids=[m["id"] for m in day_meetings], probes=probe))
    expected.append(dict(case_id=cid, kind="insert", feasible=verdict.feasible,
                         status=verdict.status,
                         blocking=[jsonable(t) for t in verdict.blocking],
                         accepted_slot=jsonable(scored) if scored else None,
                         alternatives=[jsonable(a) for a in alts]))
    summary.append(dict(case_id=cid, kind="insert", user_id=uid, date=dstr,
                        subject=f"{hhmm} {title}", result=verdict.status,
                        detail=(f"cost {scored.cost}" if scored else
                                (f"1st alt {alts[0].day} {alts[0].start_local}" if alts else "no slot in 7 days"))))

# ---------------------------------------------------------------- B. cancellation
CANCELS = [
    ("CAN-01", 101, "2026-10-06", "Commissioning — Intel Haifa",
     [("Site visit — Caesarea Business Park", 32, 90),
      ("Debrief — Diamond Exchange office", 37, 60)],
     "cancelling the recurring wake-conflict meeting should resolve the conflict"),
    ("CAN-02", 102, "2026-10-13", "Office — afternoon block, WeWork Sarona",
     [("Dentist — Dizengoff Center", 41, 45),
      ("Coffee with recruiter — Cafe Xoho", 23, 60)],
     "frees the late-afternoon window before the TAU course"),
    ("CAN-03", 103, "2026-10-12", "Gym — Holmes Place",
     [("Advisor meeting, TAU", 14, 60)],
     "control user: cancelling frees an evening window, nothing was broken before"),
]
for cid, uid, dstr, cancel_title, cand_specs, probe in CANCELS:
    person = P[uid]
    day = date.fromisoformat(dstr)
    day_meetings = MBD[uid].get(dstr, [])
    target = next((m for m in day_meetings if m["title"] == cancel_title), None)
    if target is None:
        raise SystemExit(f"{cid}: no meeting '{cancel_title}' on {dstr} for user {uid}")
    candidates = [Proposal(title=t, location_id=l, duration_min=d) for t, l, d in cand_specs]
    report = on_cancel(person, day, day_meetings, target["id"], candidates, PROFILE[uid])

    cases.append(dict(case_id=cid, kind="cancel", user_id=uid, date=dstr,
                      cancel_meeting_id=target["id"], cancel_title=cancel_title,
                      candidates=[dict(title=t, location_id=l,
                                       location_name=loc_name(l), duration_min=d)
                                  for t, l, d in cand_specs],
                      existing_meeting_ids=[m["id"] for m in day_meetings], probes=probe))
    expected.append(dict(case_id=cid, kind="cancel", **jsonable(report)))
    summary.append(dict(case_id=cid, kind="cancel", user_id=uid, date=dstr,
                        subject=cancel_title,
                        result=f"freed {report['freed_minutes']}m",
                        detail=f"{report['conflicts_resolved']} conflict(s) resolved, "
                               f"{len(report['now_fits'])} candidate(s) placed"))

# ---------------------------------------------------------------- C. interview slots
INTERVIEWS = [
    # (case, user, title, location, minutes, [(day, TARGET STATUS), ...], probe)
    # Offered times are chosen to hit the target status, so each case exercises a
    # different shape of answer rather than all three slots clashing the same way.
    ("INT-01", 102, "Interview — Google Tel Aviv", 1, 60,
     [("2026-10-07", "OK"), ("2026-10-12", "OK"), ("2026-10-13", "OVERLAP")],
     "commuter offers two workable work-from-home slots and one that clashes with an office block"),
    ("INT-02", 101, "Interview — Microsoft Herzliya", 2, 90,
     [("2026-10-12", "INFEASIBLE_TRAVEL"), ("2026-10-07", "OVERLAP"), ("2026-10-06", "OVERLAP")],
     "the driver's calendar has NO 90-minute opening inside any working day in the month; "
     "Meira must fall back to edge-of-day slots rather than simply answering 'no'"),
    ("INT-03", 103, "Interview — Wix", 5, 60,
     [("2026-10-14", "OK"), ("2026-10-15", "OK"), ("2026-10-19", "OK")],
     "control user, all three workable: ranking is decided purely by travel and clustering"),
    ("INT-04", 102, "Interview — NVIDIA Yokneam", 3, 120,
     [("2026-10-07", "INFEASIBLE_TRAVEL"), ("2026-10-12", "INFEASIBLE_TRAVEL"),
      ("2026-10-14", "INFEASIBLE_TRAVEL")],
     "no-car user sent to Yokneam: every offered slot fails, all three recommendations are Meira's own"),
]
for cid, uid, title, locid, dur, slot_specs, probe in INTERVIEWS:
    person = P[uid]
    prop = Proposal(title=title, location_id=locid, duration_min=dur, category="interview")
    parsed, offered = [], []
    for dstr, want in slot_specs:
        d = date.fromisoformat(dstr)
        t = pick(person, d, MBD[uid].get(dstr, []), prop, PROFILE[uid], want)
        parsed.append((d, t.strftime("%H:%M")))
        offered.append(dict(date=dstr, start_local=t.strftime("%H:%M"), target_status=want))
    result = review_interview_slots(person, MBD[uid], parsed, prop, PROFILE[uid], k=3)

    cases.append(dict(case_id=cid, kind="interview", user_id=uid,
                      proposal=dict(title=title, location_id=locid,
                                    location_name=loc_name(locid), duration_min=dur),
                      offered_slots=offered, probes=probe))
    expected.append(dict(case_id=cid, kind="interview", **jsonable(result)))
    ok = sum(1 for r in result["reviewed"] if r["feasible"])
    suggested = sum(1 for r in result["recommended"] if r["source"] == "meira_suggested")
    best = result["recommended"][0] if result["recommended"] else None
    summary.append(dict(case_id=cid, kind="interview", user_id=uid, date=slot_specs[0][0],
                        subject=title, result=f"{ok}/3 offered workable",
                        detail=(f"top pick {best['day']} {best['start_local']} "
                                f"(cost {best['cost']}, {best['source']}); "
                                f"{suggested} of 3 from Meira") if best else "no options"))

# ---------------------------------------------------------------- write
(DATA / "scenarios.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False))
(DATA / "scenarios_expected.json").write_text(json.dumps(expected, indent=2, ensure_ascii=False))
with open(DATA / "scenarios_summary.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["case_id", "kind", "user_id", "date", "subject",
                                      "result", "detail"])
    w.writeheader()
    w.writerows(summary)

print(f"{len(cases)} scenarios -> data/scenarios.json + scenarios_expected.json\n")
for s in summary:
    print(f"  {s['case_id']}  {s['kind']:<9} u{s['user_id']} {s['date']}  "
          f"{s['subject'][:42]:<42} {s['result']:<22} {s['detail']}")
