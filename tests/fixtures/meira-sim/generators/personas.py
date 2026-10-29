"""
Meira simulation — 3 personas, real Israeli locations.

Two worlds, kept strictly apart:
  predict_travel(...)  what Meira/Google Maps believes  -> planning, feasibility, notifications
  realize_travel(...)  what actually happened           -> arrivals, lateness, learning input
The planner must never see a realized value. Everything Meira learns has to come
back through task_events, the same way it would in production.

Determinism: no global RNG. Every draw uses rng_for(user_id, date, purpose), so adding a
meeting for one user cannot shift another user's noise and churn the golden files.
"""
import hashlib
import math
from datetime import date, datetime, time, timedelta
from random import Random
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Jerusalem")
UTC = ZoneInfo("UTC")
START_DAY = date(2026, 10, 4)     # Sunday
N_DAYS = 28                       # through Sat 2026-10-31; crosses DST end on Sun 2026-10-25

def rng_for(*parts) -> Random:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()
    return Random(int.from_bytes(h[:8], "big"))

# ---------------------------------------------------------------- locations
# id, name, kind, lat, lng, address, google_place_id   (ids 1-29 match the earlier dataset)
LOCATIONS = [
    (1,  "Google Tel Aviv (Electra Tower)", "work",   32.0699893, 34.7941969, "Yigal Alon St 98, Tel Aviv-Yafo",             "ChIJUX1rEJ9LHRURNRfNHgdoOV0"),
    (2,  "Microsoft Israel R&D",            "work",   32.1564051, 34.8052176, "Alan Turing St 3, Herzliya",                  "ChIJkVMYTwRJHRURcpdO2CIMNZ0"),
    (3,  "NVIDIA (Mellanox) Yokneam",       "work",   32.6649462, 35.1051593, "HaKidma St 26, Yokne'am Illit",               "ChIJB_r-Kf1IHRUR_Dw8rV5Q-DU"),
    (4,  "Mobileye Campus Jerusalem",       "work",   31.8014526, 35.2077445, "Shlomo Momo ha-Levi St 1, Jerusalem",         "ChIJjSErQN7XAhUR0ICGgBGakps"),
    (5,  "Wix",                             "work",   32.1422819, 34.8000302, "Yunitsman St 5, Tel Aviv-Yafo",               "ChIJ700OCwpMHRURGkbNeeevThk"),
    (6,  "monday.com",                      "work",   32.0653986, 34.7849369, "Yitzhak Sadeh St 6, Tel Aviv-Yafo",           "ChIJxZIdp3tLHRUROxQKhi5NsHI"),
    (7,  "Intel Haifa",                     "work",   32.7898165, 34.9589649, "Andrei Sakharov St 9, Haifa",                 "ChIJnRqKgl27HRURtMlNjkZ38AY"),
    (8,  "Nebius Israel",                   "work",   32.0649210, 34.7855908, "Yitzhak Sadeh St 8, Tel Aviv-Yafo",           "ChIJ8_OlRMtLHRURKmBD0JkDy2U"),
    (9,  "Apple Israel",                    "work",   32.1656131, 34.8113118, "Maskit St 12, Herzliya",                      "ChIJg6wvFIxIHRUR_tASqvQfcsE"),
    (10, "Amazon TLV14",                    "work",   32.0719761, 34.7888707, "Menachem Begin Rd 121, Tel Aviv-Yafo",        "ChIJ5RsWX8pLHRURCDiqLn-WD34"),
    (11, "Check Point Software",            "work",   32.0698150, 34.7953983, "Shlomo Kaplan St 5, Tel Aviv-Yafo",           "ChIJvS9xZZ9LHRUR9dg5RUSPkUU"),
    (12, "Hailo",                           "work",   32.0665045, 34.7930845, "Yigal Alon St 82, Tel Aviv-Yafo",             "ChIJLb9TOvRLHRUR8TS944GQD6I"),
    (13, "Qualcomm Israel",                 "work",   32.7845289, 34.9619257, "Nahum Het St 1, Tirat Carmel",                "ChIJzSBhrly7HRURswgWdLCFpIw"),
    (14, "Tel Aviv University",             "school", 32.1134960, 34.8036090, "Chaim Levanon St 55, Tel Aviv-Yafo",          "ChIJ-wt232VJHRUR721e4jwavVk"),
    (15, "Technion",                        "school", 32.7767783, 35.0231271, "Technion City, Haifa",                        "ChIJU_GqGJK6HRURnMB5PmvE7Zo"),
    (16, "Reichman University",             "school", 32.1758874, 34.8377729, "HaUniversita St 8, Herzliya",                 "ChIJDT9EwsJHHRURqYQ3HxK6ggs"),
    (17, "Weizmann Institute of Science",   "school", 31.9037541, 34.8080315, "Herzl St 234, Rehovot",                       "ChIJnSqNoQK3AhURRalOgGxgE2c"),
    (18, "Ichilov (Sourasky Medical Center)","clinic",32.0801258, 34.7898816, "Weizmann St 6, Tel Aviv-Yafo",                "ChIJtR_MkwNHHRURITSgMvUeCMQ"),
    (19, "Sheba Medical Center",            "clinic", 32.0462827, 34.8435342, "Derech Sheba 2, Ramat Gan",                   "ChIJoSmTevVKHRURMGzMyl0H0YE"),
    (20, "Holmes Place Dizengoff",          "gym",    32.0753344, 34.7750259, "Dizengoff Center, Dizengoff St 50, Tel Aviv", "ChIJWaKyYYBLHRUR_yATZSVmODA"),
    (21, "Azrieli Center",                  "other",  32.0740769, 34.7922028, "Menachem Begin Rd 132, Tel Aviv-Yafo",        "ChIJk_oKbZlLHRURHIGMQNqds_c"),
    (22, "Sarona Market",                   "cafe",   32.0712912, 34.7871708, "Aluf Kalman Magen St 3, Tel Aviv-Yafo",       "ChIJu_9NFJ1LHRURqnCPWAarsj0"),
    (23, "Cafe Xoho",                       "cafe",   32.0809187, 34.7702554, "Ben Yehuda St 73, Tel Aviv-Yafo",             "ChIJqT1ArXlMHRURc65-yk0QQlA"),
    (24, "Rabin Square",                    "other",  32.0804846, 34.7806198, "Rabin Square, Tel Aviv-Yafo",                 "ChIJhywZgolLHRURtuZUy9ew5ME"),
    (25, "Tel Aviv Savidor Center station", "station",32.0837128, 34.7969141, "Tel Aviv Savidor Center railway station",     "ChIJkw9Fzb9LHRUR5DIRxi_WtxM"),
    (26, "Tel Aviv HaHagana station",       "station",32.0540620, 34.7847899, "Tel Aviv HaHagana railway station",           "ChIJp9_SHmZLHRURXBzmYEszCh0"),
    (27, "Herzliya station",                "station",32.1639678, 34.8173587, "Herzliya railway station",                    "ChIJsUh7EYpIHRURS9-6UcS8Px0"),
    (28, "Haifa Hof HaCarmel station",      "station",32.7934585, 34.9574510, "Haifa Hof HaCarmel railway station",          "ChIJYe3m3Ga7HRUR1UqoMqL1qfQ"),
    (29, "Jerusalem Yitzhak Navon station", "station",31.7879543, 35.2029925, "Shderot Shazar 2, Jerusalem",                 "ChIJCV9TFjDWAhURGRo-XUas2qg"),
    # --- added for the country-wide driver and the central-region commuter ---
    (30, "Gav-Yam Negev Tech Park",         "work",   31.2643340, 34.8142220, "Gav-Yam Negev Advanced Technologies Park, Be'er Sheva", "ChIJd8sLlf5mAhURoSpjFYmYhlI"),
    (31, "Ben-Gurion University",           "school", 31.2614260, 34.7995546, "David Ben Gurion Blvd 1, Be'er Sheva",        "ChIJG8cBLl9mAhURk7hAwbBNyhU"),
    (32, "Caesarea Business Park",          "work",   32.4774644, 34.9452353, "HaEshel St 2, Caesarea",                      "ChIJTY7__t0NHRURctogbsn_XJY"),
    (33, "Elbit Systems Netanya",           "work",   32.2875284, 34.8640206, "HaMahshev St 2, Netanya",                     "ChIJtx3D7IA_HRURin2yoCbF358"),
    (34, "Rafael Advanced Defense Systems", "work",   32.8689212, 35.0928520, "Rafael, Haifa",                               "ChIJrxt8cTe2HRUR62VYSn4ynYw"),
    (35, "Port of Ashdod",                  "work",   31.8281910, 34.6445430, "Port of Ashdod",                              "ChIJS5fQJXmjAhURxtGl0-gPbZU"),
    (36, "Ben-Gurion Airport T3",           "other",  32.0016520, 34.8675840, "Derekh ha-Terminal, Ben-Gurion Airport",      "ChIJEU3Sg6vKAhUR179hU80KIJ4"),
    (37, "Diamond Exchange Ramat Gan",      "work",   32.0833532, 34.8010957, "Zisman Shalom St 12, Ramat Gan",              "ChIJG0o_N79LHRURBiNRNg_3IrY"),
    (38, "Kiryat Arye station",             "station",32.1060731, 34.8631220, "Kiryat Arye railway station, Petah Tikva",    "ChIJw8xpEiA2HRURdI0P2GeL9OE"),
    (39, "Rishon LeZion Moshe Dayan station","station",31.9877970, 34.7573609, "Moshe Dayan St, Rishon LeZion",              "ChIJMzkATZezAhURrkKzzq89T50"),
    (40, "WeWork Sarona",                   "work",   32.0708143, 34.7871036, "Aluf Kalman Magen St 3, Tel Aviv-Yafo",       "ChIJG0JrGJ1LHRURc_luYPsSvOA"),
    (41, "Dizengoff Center",                "other",  32.0751211, 34.7749342, "Dizengoff St 50, Tel Aviv-Yafo",              "ChIJHVPHZIBLHRUR39I7WNDlIVU"),
    (42, "Kfar Saba station",               "station",32.1673781, 34.9172038, "Kfar Saba railway station",                   "ChIJTdRyA8g5HRURve8rvKqq3XI"),
    (43, "Lod Gane Aviv station",           "station",31.9669840, 34.8786470, "Lod Gane Aviv railway station",               "ChIJ2TjCoY7KAhURf1TRAp1qCbI"),
    (44, "Netanya Poleg Park",              "work",   32.2761620, 34.8630306, "Beni Ga'on St 12, Netanya",                   "ChIJe52fcn0_HRURFJ4yDvQ4hmQ"),
]
LOC = {l[0]: l for l in LOCATIONS}
def ll(loc_id): return (LOC[loc_id][3], LOC[loc_id][4])

# ---------------------------------------------------------------- personas
#
# USER 101 — Ronen Shaked, 41. Field solutions engineer for an industrial-automation
#   vendor. Lives in Modi'in, deliberately central so he can reach Haifa and Be'er Sheva
#   in the same week. Drives everywhere; the car is his office. Two to four customer
#   sites a day, often in different cities. He is a good time-keeper but the ROAD is not:
#   his risk is Ayalon traffic and Highway 6, not his own habits. He leaves on time and
#   still arrives late when he books Haifa at 09:00 and Be'er Sheva at 13:00.
#   What Meira must learn for him: real door-to-door driving times per corridor and
#   per hour, and that a 4-site day across the country is not schedulable.
#
# USER 102 — Shani Berkovich, 28. Product designer at a Tel Aviv startup, hybrid: in the
#   office Sun/Tue/Thu. Lives in Rishon LeZion, no car. Walks to Moshe Dayan station,
#   train to Tel Aviv, then a short bus or walk. One evening course at TAU. She is the
#   late one — not dramatically, but consistently: she leaves home 5-12 minutes after
#   she meant to, so she misses the train she planned on maybe one morning in five and
#   eats a full headway. She underestimates the walk to the station every single time.
#   What Meira must learn for her: her personal departure delay, and to shift the
#   leave-home alert earlier until her arrival lateness goes to zero.
#
# USER 103 — Noa Levi, 24. MSc student at TAU, lives in the Old North, cycles everywhere.
#   Short trips, tight campus schedule, essentially never late. She is the CONTROL:
#   nothing about her day should ever raise a warning, and her learned lateness should
#   stay near zero. Any conflict Meira reports for Noa is a false positive.
#
# fields: id, name, home_label, home_lat, home_lng, primary_mode, other_modes,
#         morning_routine_min, buffer_min, earliest_wake, punctuality
PERSONAS = [
    dict(id=101, name="Ronen Shaked", short="ronen",
         home_label="Modi'in-Maccabim-Re'ut (approx.)", home=(31.8969, 35.0095),
         mode="car", other_modes=["walk"], routine=35, buffer=10, earliest_wake="05:15",
         # he leaves close to on time; the variance is in the road
         depart_delay=(-2, 6), road_volatility=0.22, miss_connection_p=0.0,
         est_bias=1.0),
    dict(id=102, name="Shani Berkovich", short="shani",
         home_label="Rishon LeZion, Nahalat Yehuda (approx.)", home=(31.9730, 34.7925),
         mode="train", other_modes=["bus", "walk"], routine=40, buffer=10, earliest_wake="05:45",
         # she is the late one: leaves 5-12 min after the plan, misses a connection ~20% of mornings
         depart_delay=(5, 12), road_volatility=0.10, miss_connection_p=0.20,
         est_bias=0.90),   # she believes the walk to the station is 10% shorter than it is
    dict(id=103, name="Noa Levi", short="noa",
         home_label="Old North, Tel Aviv (approx.)", home=(32.0930, 34.7780),
         mode="bike", other_modes=["walk", "bus"], routine=30, buffer=5, earliest_wake="06:15",
         depart_delay=(-4, 1), road_volatility=0.08, miss_connection_p=0.0,
         est_bias=1.0),
]
P = {p["id"]: p for p in PERSONAS}

# ---------------------------------------------------------------- travel: PREDICTED
def haversine_km(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))

def rush_factor(hour):
    if 7 <= hour < 9:   return 1.45      # morning into Gush Dan
    if 16 <= hour < 19: return 1.40
    if 6 <= hour < 7 or 9 <= hour < 10 or 15 <= hour < 16: return 1.15
    return 1.0

TRAIN_HEADWAY_MIN = 20       # off-peak Israel Railways on these lines
BUS_HEADWAY_MIN = 12

def predict_legs(origin, dest, mode, depart_dt):
    """
    What Meira believes, deterministically. Returns a list of legs:
      [{leg_type, from_name, to_name, minutes}]
    Long train trips are decomposed access / line-haul / egress, because the
    missed-connection failure mode only exists if the legs exist.
    """
    km = haversine_km(origin, dest) * 1.3          # road/rail detour factor
    h = depart_dt.hour
    if km < 0.05:
        return []
    if mode == "walk":
        return [dict(leg_type="walk", minutes=math.ceil(km / 5 * 60))]
    if mode == "bike":
        return [dict(leg_type="bike", minutes=math.ceil(km / 15 * 60) + 2)]
    if mode == "scooter":
        return [dict(leg_type="scooter", minutes=math.ceil(km / 18 * 60) + 2)]
    if mode == "car":
        spd = 26 if km < 15 else 78                # city vs intercity (Route 6 / Ayalon)
        drive = km / spd * 60 * rush_factor(h)
        return [dict(leg_type="car", minutes=math.ceil(drive) + 7)]   # +7 parking & walk-in
    if mode == "bus":
        spd = 16 if km < 20 else 45
        ride = km / spd * 60 * (1.25 if rush_factor(h) > 1.2 else 1.0)
        return [dict(leg_type="walk", minutes=5),
                dict(leg_type="wait", minutes=BUS_HEADWAY_MIN // 2),
                dict(leg_type="bus", minutes=math.ceil(ride)),
                dict(leg_type="walk", minutes=4)]
    if mode == "train":
        if km < 12:                                # no useful rail: falls back to bus
            return predict_legs(origin, dest, "bus", depart_dt)
        return [dict(leg_type="walk", minutes=12),                       # home -> station
                dict(leg_type="wait", minutes=TRAIN_HEADWAY_MIN // 2),   # expected wait
                dict(leg_type="train", minutes=math.ceil(km / 78 * 60)),
                dict(leg_type="walk", minutes=9)]                        # station -> destination
    raise ValueError(mode)

def predict_minutes(origin, dest, mode, depart_dt):
    return sum(l["minutes"] for l in predict_legs(origin, dest, mode, depart_dt))

# ---------------------------------------------------------------- travel: REALIZED
def realize_minutes(origin, dest, mode, depart_dt, person, rng):
    """
    Ground truth. NEVER call this from planning code.
    Returns (minutes, event) where event is '', 'traffic_jam' or 'missed_connection'.
    """
    legs = predict_legs(origin, dest, mode, depart_dt)
    if not legs:
        return 0, ""
    base = sum(l["minutes"] for l in legs)
    event = ""
    # symmetric road/rail noise, wider for the driver on intercity runs
    noise = rng.gauss(1.0, person["road_volatility"])
    noise = max(0.75, min(2.2, noise))
    minutes = base * noise
    if mode == "car" and noise > 1.35:
        event = "traffic_jam"
    # a scheduled service you just missed costs a whole headway, not a percentage
    if mode in ("train", "bus") and rng.random() < person["miss_connection_p"]:
        minutes += TRAIN_HEADWAY_MIN if mode == "train" else BUS_HEADWAY_MIN
        event = "missed_connection"
    return int(math.ceil(minutes)), event

def realized_departure_delay(person, rng):
    lo, hi = person["depart_delay"]
    return rng.randint(lo, hi)

# ---------------------------------------------------------------- helpers
def local(d: date, hhmm: str) -> datetime:
    hh, mm = map(int, hhmm.split(":"))
    return datetime.combine(d, time(hh, mm), TZ)

def utc_str(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
