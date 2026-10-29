"""
Meira mock-data generator — real Israeli places, realistic meetings, labelled feasibility cases.

Outputs (CSV, same table split as your export):
  users.csv, user_transport_types.csv, locations.csv, meetings.csv,
  travel_times.csv, feasibility_expected.csv   <- gold labels for check_feasibility()

Deterministic: fixed seed -> same data every run.
Dates: Sun 2026-10-04 .. Thu 2026-10-29 (after Sukkot; crosses Israel DST end on Sun 2026-10-25).
Times: start_at / end_at are UTC ('Z'); `date` is the user's local date.
Travel minutes are ESTIMATES (distance x detour / mode speed + overhead, rush-hour factor),
NOT Google Maps. Swap in real Directions results later; the labels are recomputed from this table.
"""
import csv, math, random
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

random.seed(42)
TZ = ZoneInfo("Asia/Jerusalem")
OUT = Path(__file__).parent
START_DAY = date(2026, 10, 4)          # Sunday, first normal work day after Sukkot 5787
N_DAYS = 26                            # through Thu 2026-10-29

# ---------------------------------------------------------------- locations (real, Google Places)
# id, name, kind, lat, lng, address, google_place_id
LOCATIONS = [
    (1,  "Google Tel Aviv (Electra Tower)", "work",   32.0699893, 34.7941969, "Yigal Alon St 98, Tel Aviv-Yafo",            "ChIJUX1rEJ9LHRURNRfNHgdoOV0"),
    (2,  "Microsoft Israel R&D",            "work",   32.1564051, 34.8052176, "Alan Turing St 3, Herzliya",                 "ChIJkVMYTwRJHRURcpdO2CIMNZ0"),
    (3,  "NVIDIA (Mellanox) Yokneam",       "work",   32.6649462, 35.1051593, "HaKidma St 26, Yokne'am Illit",              "ChIJB_r-Kf1IHRUR_Dw8rV5Q-DU"),
    (4,  "Mobileye Campus Jerusalem",       "work",   31.8014526, 35.2077445, "Shlomo Momo ha-Levi St 1, Jerusalem",        "ChIJjSErQN7XAhUR0ICGgBGakps"),
    (5,  "Wix",                             "work",   32.1422819, 34.8000302, "Yunitsman St 5, Tel Aviv-Yafo",              "ChIJ700OCwpMHRURGkbNeeevThk"),
    (6,  "monday.com",                      "work",   32.0653986, 34.7849369, "Yitzhak Sadeh St 6, Tel Aviv-Yafo",          "ChIJxZIdp3tLHRUROxQKhi5NsHI"),
    (7,  "Intel Haifa",                     "work",   32.7898165, 34.9589649, "Andrei Sakharov St 9, Haifa",                "ChIJnRqKgl27HRURtMlNjkZ38AY"),
    (8,  "Nebius Israel",                   "work",   32.0649210, 34.7855908, "Yitzhak Sadeh St 8, Tel Aviv-Yafo",          "ChIJ8_OlRMtLHRURKmBD0JkDy2U"),
    (9,  "Apple Israel",                    "work",   32.1656131, 34.8113118, "Maskit St 12, Herzliya",                     "ChIJg6wvFIxIHRUR_tASqvQfcsE"),
    (10, "Amazon TLV14",                    "work",   32.0719761, 34.7888707, "Menachem Begin Rd 121, Tel Aviv-Yafo",       "ChIJ5RsWX8pLHRURCDiqLn-WD34"),
    (11, "Check Point Software",            "work",   32.0698150, 34.7953983, "Shlomo Kaplan St 5, Tel Aviv-Yafo",          "ChIJvS9xZZ9LHRUR9dg5RUSPkUU"),
    (12, "Hailo",                           "work",   32.0665045, 34.7930845, "Yigal Alon St 82, Tel Aviv-Yafo",            "ChIJLb9TOvRLHRUR8TS944GQD6I"),
    (13, "Qualcomm Israel",                 "work",   32.7845289, 34.9619257, "Nahum Het St 1, Tirat Carmel (Omega Center)","ChIJzSBhrly7HRURswgWdLCFpIw"),
    (14, "Tel Aviv University",             "school", 32.1134960, 34.8036090, "Chaim Levanon St 55, Tel Aviv-Yafo",         "ChIJ-wt232VJHRUR721e4jwavVk"),
    (15, "Technion",                        "school", 32.7767783, 35.0231271, "Technion City, Haifa",                       "ChIJU_GqGJK6HRURnMB5PmvE7Zo"),
    (16, "Reichman University",             "school", 32.1758874, 34.8377729, "HaUniversita St 8, Herzliya",                "ChIJDT9EwsJHHRURqYQ3HxK6ggs"),
    (17, "Weizmann Institute of Science",   "school", 31.9037541, 34.8080315, "Herzl St 234, Rehovot",                      "ChIJnSqNoQK3AhURRalOgGxgE2c"),
    (18, "Ichilov (Sourasky Medical Center)","clinic",32.0801258, 34.7898816, "Weizmann St 6, Tel Aviv-Yafo",               "ChIJtR_MkwNHHRURITSgMvUeCMQ"),
    (19, "Sheba Medical Center",            "clinic", 32.0462827, 34.8435342, "Derech Sheba 2, Ramat Gan",                  "ChIJoSmTevVKHRURMGzMyl0H0YE"),
    (20, "Holmes Place Dizengoff",          "gym",    32.0753344, 34.7750259, "Dizengoff Center, Dizengoff St 50, Tel Aviv","ChIJWaKyYYBLHRUR_yATZSVmODA"),
    (21, "Azrieli Center",                  "other",  32.0740769, 34.7922028, "Menachem Begin Rd 132, Tel Aviv-Yafo",       "ChIJk_oKbZlLHRURHIGMQNqds_c"),
    (22, "Sarona Market",                   "cafe",   32.0712912, 34.7871708, "Aluf Kalman Magen St 3, Tel Aviv-Yafo",      "ChIJu_9NFJ1LHRURqnCPWAarsj0"),
    (23, "Cafe Xoho",                       "cafe",   32.0809187, 34.7702554, "Ben Yehuda St 73, Tel Aviv-Yafo",            "ChIJqT1ArXlMHRURc65-yk0QQlA"),
    (24, "Rabin Square",                    "other",  32.0804846, 34.7806198, "Rabin Square, Tel Aviv-Yafo",                "ChIJhywZgolLHRURtuZUy9ew5ME"),
    (25, "Tel Aviv Savidor Center station", "station",32.0837128, 34.7969141, "Tel Aviv Savidor Center railway station",    "ChIJkw9Fzb9LHRUR5DIRxi_WtxM"),
    (26, "Tel Aviv HaHagana station",       "station",32.0540620, 34.7847899, "Tel Aviv HaHagana railway station",          "ChIJp9_SHmZLHRURXBzmYEszCh0"),
    (27, "Herzliya station",                "station",32.1639678, 34.8173587, "Herzliya railway station",                   "ChIJsUh7EYpIHRURS9-6UcS8Px0"),
    (28, "Haifa Hof HaCarmel station",      "station",32.7934585, 34.9574510, "Haifa Hof HaCarmel railway station",         "ChIJYe3m3Ga7HRUR1UqoMqL1qfQ"),
    (29, "Jerusalem Yitzhak Navon station", "station",31.7879543, 35.2029925, "Shderot Shazar 2, Jerusalem",                "ChIJCV9TFjDWAhURGRo-XUas2qg"),
]
LOC = {l[0]: l for l in LOCATIONS}
TLV_WORK = [1, 6, 8, 10, 11, 12]

# ---------------------------------------------------------------- users
# Homes are NEIGHBOURHOOD CENTRES (approx., ~500 m), not real residential addresses.
# id, name, persona, primary_mode, other_modes, home_label, lat, lng, routine, buffer, lateness, earliest_wake
USERS = [
    (1,  "Maya Test",     "feasibility-test user (hand-built edge cases)", "bus",     ["walk","train"], "Florentin, Tel Aviv",       32.0565, 34.7700, 45, 10,  6.0, "06:00"),
    (2,  "Noa Levi",      "punctual TAU student",                          "bike",    ["walk","bus"],   "Old North, Tel Aviv",        32.0930, 34.7780, 30,  5, -2.0, "06:30"),
    (3,  "Yossi Cohen",   "chronically late, drives",                      "car",     [],               "Ramat Gan centre",           32.0823, 34.8106, 25,  5, 14.0, "06:00"),
    (4,  "Dana Mizrahi",  "job-seeker, many interviews, train commuter",   "train",   ["bus","walk"],   "Merkaz HaCarmel, Haifa",     32.8040, 34.9890, 40, 15,  3.0, "05:45"),
    (5,  "Amit Shapiro",  "Herzliya engineer, scooter",                    "scooter", ["walk"],         "Herzliya centre",            32.1663, 34.8436, 20,  5,  1.0, "06:30"),
    (6,  "Tamar Friedman","Jerusalem, commutes to TLV twice a week",       "train",   ["bus","walk"],   "German Colony, Jerusalem",   31.7630, 35.2210, 50, 20,  8.0, "05:30"),
    (7,  "Omer Katz",     "walker, lives near work",                       "walk",    ["bus"],          "Givatayim",                  32.0722, 34.8120, 35, 10,  0.0, "06:30"),
    (8,  "Shira Avraham", "Rehovot researcher, drives",                    "car",     ["train"],        "Rehovot centre",             31.8948, 34.8113, 40, 10,  4.0, "06:00"),
    (9,  "Eitan Ben-David","Petah Tikva, bus only, underestimates tasks",  "bus",     ["walk"],         "Petah Tikva centre",         32.0871, 34.8875, 30, 10, 11.0, "06:00"),
    (10, "Lior Peretz",   "Holon, early bird, gym daily",                  "car",     ["bike"],         "Holon centre",               32.0158, 34.7874, 30,  5, -5.0, "04:30"),
    (11, "Roni Gabay",    "Kfar Saba, hybrid worker",                      "car",     ["bus"],          "Kfar Saba centre",           32.1750, 34.9070, 35, 10,  2.0, "06:00"),
    (12, "Gal Hadad",     "Rishon LeZion, student + part-time job",        "bus",     ["walk","scooter"],"Rishon LeZion centre",      31.9730, 34.7925, 30, 10,  7.0, "06:30"),
]
U = {u[0]: u for u in USERS}

# ---------------------------------------------------------------- travel model (estimate)
def haversine_km(a, b):
    (la1, lo1), (la2, lo2) = a, b
    r = 6371.0
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * r * math.asin(math.sqrt(h))

def is_rush(hour):  # Sun-Thu rush; good enough for mock
    return 7 <= hour < 9 or 16 <= hour < 19

def travel_minutes(a, b, mode, depart_hour):
    km = haversine_km(a, b) * 1.3                       # road/rail detour factor
    if km < 0.05:
        return 0, round(km, 2)
    if mode == "walk":      m = km / 5 * 60
    elif mode == "bike":    m = km / 15 * 60 + 2
    elif mode == "scooter": m = km / 18 * 60 + 2
    elif mode == "car":
        spd = 25 if km < 15 else 65
        m = km / spd * 60 + 6                           # parking
        if is_rush(depart_hour): m *= 1.4
    elif mode == "bus":
        spd = 16 if km < 20 else 45
        m = km / spd * 60 + 9                           # walk to stop + wait
        if is_rush(depart_hour): m *= 1.3
    elif mode == "train":
        if km < 12:                                     # no useful train -> bus-like
            m = km / 16 * 60 + 9
        else:
            m = km / 75 * 60 + 25                       # 2x station access + wait
    else:
        raise ValueError(mode)
    return int(math.ceil(m)), round(km, 2)

# ---------------------------------------------------------------- feasibility engine (single source of truth)
def utc(dt): return dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")

def day_labels(uid, dstr, ms):
    """
    ms: one user's meetings for one local day, sorted by start.
    Rules:
      * position = last PHYSICAL location (home at day start); online meetings don't move you
      * next is online   -> travel 0, margin 0 (only OVERLAP can fail)
      * next is physical -> need gap >= travel (+ margin = buffer + max(0, avg_lateness))
      * first physical meeting of the day with nothing before it -> wake-time check
    Returns (travel_rows, labels).
    """
    u = U[uid]; mode = u[3]; user_margin = u[9] + max(0, u[10])
    pos_id, pos, free_at, prev_id = "home", (u[6], u[7]), None, ""
    trows, labs = [], []
    for m in ms:
        if m["is_online"]:
            t, dest_id, margin = 0, "online", 0
        else:
            dest_id = m["location_id"]; dest = (LOC[dest_id][3], LOC[dest_id][4]); margin = user_margin
            dep_h = free_at.hour if free_at else max(6, m["start_local"].hour - 1)
            t, km = travel_minutes(pos, dest, mode, dep_h)
            t_car, _ = travel_minutes(pos, dest, "car", dep_h)
            trows.append(dict(user_id=uid, date=dstr, from_id=pos_id, to_id=dest_id, mode=mode, depart_hour=dep_h,
                              distance_km=km, minutes=t, minutes_by_car=t_car, source="estimate"))
        base = dict(user_id=uid, date=dstr, prev_meeting_id=prev_id, next_meeting_id=m.get("id", ""),
                    from_id=pos_id, to_id=dest_id, travel_min=t, margin_min=margin)
        if free_at is None:
            if not m["is_online"]:
                wake = m["start_local"] - timedelta(minutes=t + margin + u[8])
                earliest = datetime.combine(m["start_local"].date(), time.fromisoformat(u[11]), TZ)
                labs.append({**base, "gap_min": "", "slack_min": "", "required_wake_local": wake.strftime("%H:%M"),
                             "earliest_wake": u[11], "status": "WAKE_CONFLICT" if wake < earliest else "OK"})
        else:
            gap = (m["start_local"] - free_at).total_seconds() / 60
            status = ("OVERLAP" if gap < 0 else "INFEASIBLE_TRAVEL" if gap < t
                      else "TIGHT" if gap < t + margin else "OK")
            labs.append({**base, "gap_min": int(gap), "slack_min": int(gap - t - margin),
                         "required_wake_local": "", "earliest_wake": "", "status": status})
        if not m["is_online"]:
            pos_id, pos = dest_id, dest
        free_at = max(free_at, m["end_local"]) if free_at else m["end_local"]
        prev_id = m.get("id", "")
    return trows, labs

# ---------------------------------------------------------------- meetings
meetings = []
def add(uid, day, hh, mm, dur, title, cat, loc=None, online=False):
    start_local = datetime.combine(day, time(hh, mm), TZ)
    meetings.append(dict(
        user_id=uid, date=day.isoformat(), title=title, category=cat,
        location_id="" if online else loc, is_online=int(online),
        meeting_url=f"https://meet.google.com/mock-{len(meetings)+1}" if online else "",
        start_local=start_local, end_local=start_local + timedelta(minutes=dur)))

def user_day(uid, dstr):
    return sorted([m for m in meetings if m["user_id"] == uid and m["date"] == dstr], key=lambda m: m["start_local"])

days = [START_DAY + timedelta(d) for d in range(N_DAYS)]
workdays = [d for d in days if d.weekday() in (6, 0, 1, 2, 3)]   # Sun..Thu

# ---- User 1 (Maya Test): hand-built edge cases -> assert on these in tests
D = lambda m, d: date(2026, m, d)
add(1, D(10,5), 10, 0, 60, "Interview — Google (onsite)",            "interview", 1)
add(1, D(10,5), 11, 30, 60, "Interview — Intel Haifa (onsite)",      "interview", 7)   # INFEASIBLE_TRAVEL: TLV->Haifa in 30 min
add(1, D(10,6), 12, 0, 60, "Interview — Wix",                        "interview", 5)
add(1, D(10,6), 13, 50, 60, "Interview — monday.com",                "interview", 6)   # INFEASIBLE by bus; minutes_by_car shows car would pass
add(1, D(10,7), 9, 0, 90, "Team sync @ Nebius",                      "work", 8)
add(1, D(10,7), 10, 50, 45, "Coffee chat — Amazon recruiter",        "meeting", 10)    # TIGHT: ok with 0 margin, fails with buffer+lateness
add(1, D(10,8), 9, 0, 60, "Interview — Check Point",                 "interview", 11)
add(1, D(10,8), 10, 15, 45, "Phone screen — Qualcomm (Zoom)",        "zoom", online=True)  # online in between: OK, no travel
add(1, D(10,8), 11, 30, 60, "Interview — Hailo",                     "interview", 12)  # travel measured from Check Point, not from 'online'
add(1, D(10,11), 7, 30, 60, "Onsite — Mobileye Jerusalem",           "interview", 4)   # WAKE_CONFLICT: needs wake before 06:00
add(1, D(10,12), 14, 0, 90, "Doctor — Ichilov",                      "doctor", 18)
add(1, D(10,12), 15, 0, 60, "Gym — Holmes Place",                    "gym", 20)        # OVERLAP
add(1, D(10,26), 9, 0, 60, "Interview — Apple (day after DST ends)", "interview", 9)   # 09:00 local = 07:00Z (was 06:00Z before Oct 25)
add(1, D(10,26), 12, 30, 60, "Lunch — Sarona Market",                "leisure", 22)    # OK
EDGE_CASE_COUNT = len(meetings)

# ---- Background users: recurring schedule + random extras, all kept feasible
RECURRING = {
    2:  [((0, 3), 10, 0, 120, "Lecture — Deep Learning", "class", 14), ((2,), 14, 0, 90, "Lab — NLP", "class", 14)],
    3:  [((6, 0, 1, 2, 3), 9, 0, 480, "Work @ Check Point", "work", 11)],
    4:  [((1,), 10, 0, 180, "Course — Technion", "course", 15)],
    5:  [((6, 1, 3), 9, 30, 450, "Work @ Microsoft", "work", 2)],
    6:  [((6, 2), 10, 0, 420, "Office day @ Mobileye", "work", 4), ((0,), 9, 30, 450, "TLV office day @ Amazon", "work", 10)],
    7:  [((6, 0, 1, 2, 3), 9, 0, 480, "Work @ monday.com", "work", 6)],
    8:  [((6, 0, 1, 2, 3), 8, 30, 510, "Lab @ Weizmann", "work", 17)],
    9:  [((6, 0, 1, 2, 3), 9, 0, 480, "Work @ Amazon TLV14", "work", 10)],
    10: [((6, 0, 1, 2, 3), 6, 0, 60, "Gym — Holmes Place", "gym", 20), ((6, 0, 1, 2, 3), 8, 0, 540, "Work @ Hailo", "work", 12)],
    11: [((6, 2), 9, 0, 480, "Office @ Apple", "work", 9)],
    12: [((6, 1), 9, 0, 180, "Class @ TAU", "class", 14), ((0, 2), 16, 0, 240, "Shift @ Azrieli", "work", 21)],
}
for uid, recs in RECURRING.items():
    for d in workdays:
        for wds, hh, mm, dur, title, cat, loc in recs:
            if d.weekday() in wds:
                add(uid, d, hh, mm, dur, title, cat, loc)

CO = {l[0]: l[1].split(" (")[0] for l in LOCATIONS}
EXTRAS = [  # title, category, candidate locations (None = online), duration
    ("Interview — {co}", "interview", [1, 2, 5, 6, 8, 9, 10, 11, 12], 60),
    ("Doctor appointment", "doctor", [18, 19], 30),
    ("Coffee with friend", "leisure", [22, 23, 24], 60),
    ("Networking meetup", "meeting", [21, 25], 90),
    ("Sync call", "call", None, 30),
]
DANA_INTERVIEWS = [7, 13, 3, 15, 1, 6, 8]   # Haifa/Yokneam heavy + a few TLV (long train days)

def try_place(uid, day, hh, mm, dur, title, cat, loc):
    """Tentatively add, run the SAME engine used for labels; keep only if the whole day stays OK."""
    add(uid, day, hh, mm, dur, title, cat, loc, online=loc is None)
    _, labs = day_labels(uid, day.isoformat(), user_day(uid, day.isoformat()))
    if all(l["status"] == "OK" for l in labs):
        return True
    meetings.pop()
    return False

for uid in U:
    if uid == 1: continue
    target = 16 if uid == 4 else 10
    placed = tries = 0
    while placed < target and tries < 2000:
        tries += 1
        d = random.choice(workdays)
        title, cat, locs, dur = random.choice(EXTRAS)
        if uid == 4 and random.random() < 0.6:
            title, cat, _, dur = EXTRAS[0]; locs = DANA_INTERVIEWS
        loc = random.choice(locs) if locs else None
        hh, mm = random.choice(range(8, 19)), random.choice((0, 15, 30, 45))
        if try_place(uid, d, hh, mm, dur, title.format(co=CO.get(loc, "")), cat, loc):
            placed += 1

meetings.sort(key=lambda m: (m["user_id"], m["start_local"]))
for i, m in enumerate(meetings, 1):
    m["id"] = i

travel_rows, labels = [], []
for (uid, dstr) in sorted({(m["user_id"], m["date"]) for m in meetings}):
    tr, lb = day_labels(uid, dstr, user_day(uid, dstr))
    travel_rows += tr; labels += lb

# ---------------------------------------------------------------- write CSVs
def write(name, header, rows):
    with open(OUT / name, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(header); w.writerows(rows)

write("locations.csv", ["id","name","kind","lat","lng","address","google_place_id"], LOCATIONS)
write("users.csv",
      ["id","name","persona","transportation_type","home_address","home_lat","home_lng","timezone",
       "morning_routine_minutes","buffer_minutes","avg_lateness_minutes","earliest_wake_time"],
      [(u[0],u[1],u[2],u[3],u[5]+" (approx.)",u[6],u[7],"Asia/Jerusalem",u[8],u[9],u[10],u[11]) for u in USERS])
write("user_transport_types.csv", ["user_id","transport_type","is_primary"],
      [(u[0], u[3], 1) for u in USERS] + [(u[0], x, 0) for u in USERS for x in u[4]])
write("meetings.csv",
      ["id","user_id","location_id","title","category","date","start_at","end_at",
       "start_local","end_local","is_online","meeting_url"],
      [(m["id"],m["user_id"],m["location_id"],m["title"],m["category"],m["date"],
        utc(m["start_local"]),utc(m["end_local"]),
        m["start_local"].strftime("%H:%M"),m["end_local"].strftime("%H:%M"),
        m["is_online"],m["meeting_url"]) for m in meetings])
write("travel_times.csv", list(travel_rows[0].keys()), [r.values() for r in travel_rows])
write("feasibility_expected.csv", list(labels[0].keys()), [r.values() for r in labels])

from collections import Counter
print(f"users={len(USERS)} locations={len(LOCATIONS)} meetings={len(meetings)} "
      f"travel_rows={len(travel_rows)} labels={len(labels)}")
print("status counts:", dict(Counter(l['status'] for l in labels)))
print("non-OK by user:", dict(Counter(l['user_id'] for l in labels if l['status'] != 'OK')))
for l in labels:
    if l["user_id"] == 1:
        print(" ", l["date"], l["prev_meeting_id"], "->", l["next_meeting_id"], l["status"],
              f"gap={l['gap_min']} travel={l['travel_min']} margin={l['margin_min']} wake={l['required_wake_local']}")
