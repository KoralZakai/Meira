"""
Replays 28 days for 3 personas and writes everything Meira would have produced,
plus what actually happened, so the learning loop can be tested end to end.

Per simulated day, in order:
  1. PLAN     Meira computes leave-home / wake times from predicted travel + what it has
              learned so far, and schedules notifications. Uses predict_* only.
  2. EXECUTE  the world runs: the user leaves late by their own habit, the road/rail
              adds noise, a connection is missed. Uses realize_* only.
  3. LOG      task_events rows: left_home, arrived, completed (estimated vs actual).
  4. LEARN    nightly rollup, the 70/30 rolling average, writing back
              avg_lateness_minutes and a per-mode travel bias for the next day.

Outputs (CSV):
  sim_users.csv              the 3 personas with their starting profile
  sim_meetings.csv           the planned schedule
  sim_transit_plans.csv      wake / leave-home / arrive, as Meira computed them
  sim_notifications.csv      every notification, each tied to a real meeting id
  sim_task_events.csv        append-only truth log (this is the learning input)
  sim_learning_trace.csv     day-by-day profile state - the convergence curve
  sim_feasibility.csv        per-transition labels using what Meira knew that morning
"""
import csv
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

from personas import (LOC, LOCATIONS, N_DAYS, P, PERSONAS, START_DAY, TZ, ll, local,
                      predict_legs, predict_minutes, realize_minutes,
                      realized_departure_delay, rng_for, utc_str)

OUT = Path(__file__).parent
DAYS = [START_DAY + timedelta(d) for d in range(N_DAYS)]
WORKDAYS = [d for d in DAYS if d.weekday() in (6, 0, 1, 2, 3)]      # Sun..Thu
ALPHA_OLD, ALPHA_NEW = 0.7, 0.3                                      # documented rolling average

# ---------------------------------------------------------------- schedules
meetings = []
def add(uid, day, hhmm, dur, title, cat, loc=None, online=False, est_min=None):
    s = local(day, hhmm)
    meetings.append(dict(
        user_id=uid, date=day.isoformat(), title=title, category=cat,
        location_id="" if online else loc, is_online=int(online),
        start_local=s, end_local=s + timedelta(minutes=dur),
        estimated_minutes=est_min if est_min is not None else dur))

# --- 101 Ronen: field engineer, 2-4 customer sites a day, whole country
RONEN_DAYS = {
    # weekday index -> list of (time, duration, title, location)
    # Gush Dan days are dense and fine; the north/south days are the hard ones.
    0: [("09:00", 90, "Site visit — Elbit Netanya", 33), ("12:30", 90, "Site visit — Caesarea Business Park", 32),
        ("16:00", 60, "Debrief — Diamond Exchange office", 37)],
    1: [("08:30", 120, "Commissioning — Intel Haifa", 7), ("12:00", 90, "Site visit — NVIDIA Yokneam", 3),
        ("15:30", 90, "Site visit — Rafael Haifa", 34)],
    2: [("09:30", 90, "Quarterly review — Check Point", 11), ("12:00", 60, "Lunch demo — Azrieli Center", 21),
        ("14:00", 90, "Site visit — Hailo", 12), ("16:30", 60, "Pipeline sync — WeWork Sarona", 40)],
    3: [("09:00", 120, "Install — Gav-Yam Negev, Be'er Sheva", 30), ("13:30", 90, "Lecture — Ben-Gurion University", 31),
        ("17:00", 60, "Site visit — Port of Ashdod", 35)],
    6: [("08:00", 90, "Weekly kickoff — Mobileye Jerusalem", 4), ("11:30", 90, "Site visit — Google Tel Aviv", 1),
        ("15:00", 60, "Airport pickup — Ben-Gurion T3", 36)],
}
for d in WORKDAYS:
    for hhmm, dur, title, loc in RONEN_DAYS.get(d.weekday(), []):
        add(101, d, hhmm, dur, title, "work", loc)

# --- 102 Shani: hybrid designer, Rishon LeZion -> Tel Aviv by train, Tue evening course
# The office day is split into two blocks so a midday trip across town is representable.
# A single 8-hour block would make every midday meeting an OVERLAP by construction.
MIDDAY = {                       # day index -> (time, dur, title, category, location)
    2:  ("13:00", 60, "Client workshop — Google Tel Aviv", "meeting", 1),
    9:  ("12:45", 60, "Portfolio review — Wix", "meeting", 5),
    16: ("12:30", 45, "Dentist — Dizengoff Center", "doctor", 41),
    23: ("13:00", 90, "Design meetup — Azrieli Center", "meeting", 21),
}
for i, d in enumerate(DAYS):
    if d.weekday() not in (6, 0, 1, 2, 3):
        continue
    wd = d.weekday()
    extra = MIDDAY.get(i)
    if wd in (6, 1, 3):                                   # Sun / Tue / Thu in the office
        if extra:
            hhmm, dur, title, cat, loc = extra
            add(102, d, "09:30", 150, "Office — morning block, WeWork Sarona", "work", 40)
            add(102, d, hhmm, dur, title, cat, loc)
            add(102, d, "15:30", 120, "Office — afternoon block, WeWork Sarona", "work", 40)
        else:
            add(102, d, "09:30", 480, "Office day — WeWork Sarona", "work", 40)
        if wd == 1:
            add(102, d, "18:30", 150, "Course — Interaction Design, TAU", "course", 14)
    else:                                                  # Mon / Wed from home
        add(102, d, "10:00", 45, "Design review (Zoom)", "zoom", online=True)
        add(102, d, "14:00", 30, "1:1 with PM (Zoom)", "zoom", online=True)
        if extra:                                          # a WFH day that still drags her out
            hhmm, dur, title, cat, loc = extra
            add(102, d, hhmm, dur, title, cat, loc)

# --- 103 Noa: MSc student, cycles, tight but local (the control)
for d in WORKDAYS:
    wd = d.weekday()
    if wd in (6, 1):
        add(103, d, "09:00", 120, "Lecture — Statistical Learning, TAU", "class", 14)
        add(103, d, "13:00", 180, "Lab — research group, TAU", "class", 14)
    if wd in (0, 3):
        add(103, d, "10:00", 120, "Lecture — Optimization, TAU", "class", 14)
        add(103, d, "17:30", 60, "Gym — Holmes Place", "gym", 20)
    if wd == 2:
        add(103, d, "11:00", 90, "Advisor meeting, TAU", "meeting", 14)
        add(103, d, "15:00", 60, "Coffee — Cafe Xoho", "leisure", 23)

meetings.sort(key=lambda m: (m["user_id"], m["start_local"]))
for i, m in enumerate(meetings, 1):
    m["id"] = i

by_user_day = defaultdict(list)
for m in meetings:
    by_user_day[(m["user_id"], m["date"])].append(m)

# ---------------------------------------------------------------- simulation
# learned profile, cold on day 1 - exactly what a new install knows
# Two INDEPENDENT learned signals, plus one reported KPI:
#   avg_depart_delay  how long after the alert the user actually leaves  -> sets the margin
#   bias[mode]        realized travel / raw predicted travel             -> corrects the estimate
#   avg_lateness      arrival vs meeting start                           -> KPI ONLY, never fed back
# Feeding arrival lateness back into the margin is a feedback loop on the system's own
# output: the margin makes the user early, "lateness" goes negative, and the margin can
# never shrink again. Learn from the causes, measure the effect.
profile = {p["id"]: dict(avg_depart_delay=0.0, avg_lateness=0.0, bias={}, samples=0)
           for p in PERSONAS}

transit_plans, notifications, events, feas, learn_trace = [], [], [], [], []
nid = tid = eid = 0

for day in DAYS:
    for person in PERSONAS:
        uid = person["id"]
        ms = sorted(by_user_day.get((uid, day.isoformat()), []), key=lambda m: m["start_local"])
        if not ms:
            continue
        prof = profile[uid]
        margin = person["buffer"] + max(0.0, prof["avg_depart_delay"])
        rng = rng_for(uid, day.isoformat(), "exec")

        pos, pos_id = person["home"], "home"
        free_at = None                      # when the user is next available (realized)
        plan_free_at = None                 # same, as PLANNED (drives the feasibility check)
        day_lateness, day_delays = [], []

        for m in ms:
            # ---------- 1. PLAN (predicted world only) ----------
            if m["is_online"]:
                pred = 0
                plan_leave = m["start_local"]
            else:
                dest = ll(m["location_id"])
                depart_guess = plan_free_at or (m["start_local"] - timedelta(hours=1))
                raw = predict_minutes(pos, dest, person["mode"], depart_guess)
                bias = prof["bias"].get(person["mode"], 1.0)
                pred = int(round(raw * bias))                 # learning applied here
                plan_leave = m["start_local"] - timedelta(minutes=pred + margin)

                tid += 1
                is_first = plan_free_at is None
                wake = (plan_leave - timedelta(minutes=person["routine"])) if is_first else plan_leave
                transit_plans.append(dict(
                    id=tid, meeting_id=m["id"], user_id=uid, date=day.isoformat(),
                    origin_id=pos_id, dest_id=m["location_id"], mode=person["mode"],
                    wake_up_local=wake.strftime("%H:%M") if is_first else "",
                    leave_home_local=plan_leave.strftime("%H:%M"),
                    arrive_target_local=m["start_local"].strftime("%H:%M"),
                    predicted_minutes=raw, applied_bias=round(bias, 3),
                    planned_minutes=pred, margin_minutes=round(margin, 1), source="estimate"))

                # notifications - every one carries a real meeting_id, so a phantom
                # notification cannot be represented in this data at all
                if is_first:
                    nid += 1
                    notifications.append(dict(id=nid, user_id=uid, meeting_id=m["id"], type="wake_up",
                                              fire_at=utc_str(wake), created_by="app"))
                nid += 1
                notifications.append(dict(id=nid, user_id=uid, meeting_id=m["id"], type="leave_home",
                                          fire_at=utc_str(plan_leave), created_by="app"))
                nid += 1
                notifications.append(dict(id=nid, user_id=uid, meeting_id=m["id"], type="re_check",
                                          fire_at=utc_str(plan_leave - timedelta(minutes=15)), created_by="app"))

                # ---------- feasibility, using only what Meira knew ----------
                if plan_free_at is None:
                    earliest = local(day, person["earliest_wake"])
                    feas.append(dict(user_id=uid, date=day.isoformat(), prev_meeting_id="",
                                     next_meeting_id=m["id"], from_id=pos_id, to_id=m["location_id"],
                                     gap_min="", travel_min=pred, margin_min=round(margin, 1), slack_min="",
                                     required_wake_local=wake.strftime("%H:%M"),
                                     status="WAKE_CONFLICT" if wake < earliest else "OK"))
                else:
                    gap = (m["start_local"] - plan_free_at).total_seconds() / 60
                    status = ("OVERLAP" if gap < 0 else "INFEASIBLE_TRAVEL" if gap < pred
                              else "TIGHT" if gap < pred + margin else "OK")
                    feas.append(dict(user_id=uid, date=day.isoformat(), prev_meeting_id=prev_id,
                                     next_meeting_id=m["id"], from_id=pos_id, to_id=m["location_id"],
                                     gap_min=int(gap), travel_min=pred, margin_min=round(margin, 1),
                                     slack_min=int(gap - pred - margin), required_wake_local="",
                                     status=status))

            # ---------- 2. EXECUTE (realized world only) ----------
            if m["is_online"]:
                arrive = m["start_local"]
                lateness = 0
                actual = 0
                event = ""
            else:
                delay = realized_departure_delay(person, rng)
                actual_leave = max(plan_leave, free_at or plan_leave) + timedelta(minutes=delay)
                actual, event = realize_minutes(pos, ll(m["location_id"]), person["mode"],
                                                actual_leave, person, rng)
                arrive = actual_leave + timedelta(minutes=actual)
                lateness = int((arrive - m["start_local"]).total_seconds() // 60)
                day_lateness.append(lateness)
                day_delays.append(delay)

                eid += 1
                events.append(dict(id=eid, user_id=uid, meeting_id=m["id"], event_type="left_home",
                                   occurred_at=utc_str(actual_leave), category=m["category"],
                                   estimated_minutes=pred, actual_minutes="", lateness_minutes=delay,
                                   note=f"planned {plan_leave.strftime('%H:%M')}, left {actual_leave.strftime('%H:%M')}"))
                eid += 1
                events.append(dict(id=eid, user_id=uid, meeting_id=m["id"], event_type="arrived",
                                   occurred_at=utc_str(arrive), category=m["category"],
                                   estimated_minutes=pred, actual_minutes=actual, lateness_minutes=lateness,
                                   note=event))
                if event == "missed_connection":
                    nid += 1
                    notifications.append(dict(id=nid, user_id=uid, meeting_id=m["id"], type="missed_bus",
                                              fire_at=utc_str(actual_leave + timedelta(minutes=8)),
                                              created_by="agent"))

            eid += 1
            events.append(dict(id=eid, user_id=uid, meeting_id=m["id"], event_type="completed",
                               occurred_at=utc_str(m["end_local"]), category=m["category"],
                               estimated_minutes=m["estimated_minutes"],
                               actual_minutes=m["estimated_minutes"], lateness_minutes="", note=""))

            if not m["is_online"]:
                pos, pos_id = ll(m["location_id"]), m["location_id"]
                # realized travel feeds the per-mode bias; keep the raw pair for the nightly job
                prof.setdefault("_pairs", []).append((person["mode"], pred, actual, bias))
            free_at = max(free_at, m["end_local"]) if free_at else m["end_local"]
            plan_free_at = max(plan_free_at, m["end_local"]) if plan_free_at else m["end_local"]
            prev_id = m["id"]

        # ---------- 4. LEARN (the nightly Nebius job) ----------
        if day_delays:
            prof["avg_depart_delay"] = (ALPHA_OLD * prof["avg_depart_delay"]
                                        + ALPHA_NEW * (sum(day_delays) / len(day_delays)))
        if day_lateness:
            prof["avg_lateness"] = (ALPHA_OLD * prof["avg_lateness"]
                                    + ALPHA_NEW * (sum(day_lateness) / len(day_lateness)))
            prof["samples"] += len(day_lateness)
        for mode, pred_v, act_v, applied in prof.pop("_pairs", []):
            if pred_v > 0:
                # bias is against the RAW prediction, so it must not compound with itself
                raw_pred = pred_v / applied if applied else pred_v
                ratio = act_v / raw_pred if raw_pred else 1.0
                old = prof["bias"].get(mode, 1.0)
                prof["bias"][mode] = ALPHA_OLD * old + ALPHA_NEW * ratio
        learn_trace.append(dict(
            date=day.isoformat(), user_id=uid, name=person["name"],
            avg_depart_delay_minutes=round(prof["avg_depart_delay"], 2),
            avg_lateness_minutes=round(prof["avg_lateness"], 2),
            travel_bias=round(prof["bias"].get(person["mode"], 1.0), 3),
            margin_used_minutes=round(margin, 1),
            arrivals_today=len(day_lateness),
            late_arrivals_today=sum(1 for x in day_lateness if x > 0),
            worst_lateness_today=max(day_lateness) if day_lateness else 0,
            samples=prof["samples"]))

# ---------------------------------------------------------------- write
def write(name, rows, header=None):
    rows = list(rows)
    header = header or list(rows[0].keys())
    with open(OUT / name, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows)

write("sim_users.csv", [dict(
    id=p["id"], name=p["name"], home_address=p["home_label"], home_lat=p["home"][0], home_lng=p["home"][1],
    transportation_type=p["mode"], other_modes="|".join(p["other_modes"]), timezone="Asia/Jerusalem",
    morning_routine_minutes=p["routine"], buffer_minutes=p["buffer"], earliest_wake_time=p["earliest_wake"],
    initial_avg_lateness_minutes=0.0,
    true_depart_delay_min=f"{p['depart_delay'][0]}..{p['depart_delay'][1]}",
    true_miss_connection_p=p["miss_connection_p"]) for p in PERSONAS])

write("sim_meetings.csv", [dict(
    id=m["id"], user_id=m["user_id"], location_id=m["location_id"], title=m["title"], category=m["category"],
    date=m["date"], start_at=utc_str(m["start_local"]), end_at=utc_str(m["end_local"]),
    start_local=m["start_local"].strftime("%H:%M"), end_local=m["end_local"].strftime("%H:%M"),
    is_online=m["is_online"], estimated_minutes=m["estimated_minutes"]) for m in meetings])

write("sim_transit_plans.csv", transit_plans)
write("sim_notifications.csv", notifications)
write("sim_task_events.csv", events)
write("sim_learning_trace.csv", learn_trace)
write("sim_feasibility.csv", feas)
write("locations.csv", [dict(id=l[0], name=l[1], kind=l[2], lat=l[3], lng=l[4],
                             address=l[5], google_place_id=l[6]) for l in LOCATIONS])

# ---------------------------------------------------------------- summary
print(f"days={N_DAYS} users={len(PERSONAS)} meetings={len(meetings)} "
      f"transit_plans={len(transit_plans)} notifications={len(notifications)} events={len(events)}")

from collections import Counter
print("\nfeasibility by user:")
for p in PERSONAS:
    c = Counter(f["status"] for f in feas if f["user_id"] == p["id"])
    print(f"  {p['id']} {p['name']:<18} {dict(c)}")

from datetime import date as _date
def week_of(dstr):
    return (_date.fromisoformat(dstr) - START_DAY).days // 7 + 1

print("\nlearning loop — does arrival lateness fall as the profile converges?")
for p in PERSONAS:
    rows = [t for t in learn_trace if t["user_id"] == p["id"]]
    truth = f"true delay {p['depart_delay'][0]}..{p['depart_delay'][1]}m"
    if p["miss_connection_p"]:
        truth += f", misses a connection {int(p['miss_connection_p']*100)}% of trips"
    print(f"  {p['name']}  ({truth})")
    for wk in sorted({week_of(r["date"]) for r in rows}):
        w = [r for r in rows if week_of(r["date"]) == wk]
        arr = sum(r["arrivals_today"] for r in w)
        late = sum(r["late_arrivals_today"] for r in w)
        worst = max((r["worst_lateness_today"] for r in w), default=0)
        e = w[-1]
        print(f"    week {wk}: late {late:>2}/{arr:<3} worst {worst:+d}m "
              f"| learned delay {e['avg_depart_delay_minutes']:>5}m  bias {e['travel_bias']:<5} "
              f"margin {e['margin_used_minutes']:>4}m  (KPI mean lateness {e['avg_lateness_minutes']:>6}m)")
