#!/usr/bin/env python3
"""
Build meira_db.sqlite from schema/meira_db_schema.sql and load data/*.csv into it.

    python3 seed_sqlite.py [--out meira_db.sqlite]

Every INSERT runs with PRAGMA foreign_keys = ON and every CHECK constraint active,
so a successful run is itself a test: it proves the fixture and the schema agree.
Stdlib only.
"""
import argparse
import csv
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
TZ = ZoneInfo("Asia/Jerusalem")
UTC = ZoneInfo("UTC")


def rows(name):
    with open(HERE / "data" / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def local_to_utc(date_str, hhmm):
    """'2026-10-06' + '07:15' (Asia/Jerusalem) -> '2026-10-06T04:15:00Z'. DST-correct."""
    y, m, d = map(int, date_str.split("-"))
    hh, mi = map(int, hhmm.split(":"))
    naive = datetime(y, m, d, 0, 0, tzinfo=TZ) + timedelta(hours=hh, minutes=mi)
    return naive.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(out_path: Path) -> sqlite3.Connection:
    if out_path.exists():
        out_path.unlink()
    con = sqlite3.connect(out_path)
    con.executescript((HERE / "schema" / "meira_db_schema.sql").read_text())
    con.execute("PRAGMA foreign_keys = ON")

    # ---- places: shared locations have user_id NULL; each user's home is their own place
    con.executemany(
        "INSERT INTO places (id,user_id,label,kind,address,lat,lng,google_place_id) "
        "VALUES (:id,NULL,:name,:kind,:address,:lat,:lng,:gpid)",
        [dict(id=f"loc-{r['id']}", name=r["name"], kind=r["kind"], address=r["address"],
              lat=float(r["lat"]), lng=float(r["lng"]), gpid=r["google_place_id"] or None)
         for r in rows("locations.csv")])

    # ---- users (the 3 simulated personas)
    users = rows("sim_users.csv")
    con.executemany(
        "INSERT INTO users (id,name,timezone,morning_routine_minutes,buffer_minutes,"
        "earliest_wake_time,avg_lateness_minutes,language) "
        "VALUES (:id,:name,:tz,:routine,:buf,:wake,:lat,'he')",
        [dict(id=f"u-{u['id']}", name=u["name"], tz=u["timezone"],
              routine=int(u["morning_routine_minutes"]), buf=int(u["buffer_minutes"]),
              wake=u["earliest_wake_time"], lat=float(u["initial_avg_lateness_minutes"]))
         for u in users])

    con.executemany(
        "INSERT INTO places (id,user_id,label,kind,address,lat,lng) "
        "VALUES (:id,:uid,:label,'home',:addr,:lat,:lng)",
        [dict(id=f"home-{u['id']}", uid=f"u-{u['id']}", label=f"{u['name']} — home",
              addr=u["home_address"], lat=float(u["home_lat"]), lng=float(u["home_lng"]))
         for u in users])

    con.executemany(
        "INSERT INTO user_transport_types (user_id,transport_type,is_primary) VALUES (?,?,?)",
        [(f"u-{u['id']}", u["transportation_type"], 1) for u in users] +
        [(f"u-{u['id']}", m, 0) for u in users for m in u["other_modes"].split("|") if m])

    # ---- meetings
    con.executemany(
        "INSERT INTO meetings (id,user_id,title,category,start_at,end_at,place_id,"
        "is_online,meeting_url,source) "
        "VALUES (:id,:uid,:title,:cat,:s,:e,:pid,:online,:url,'manual')",
        [dict(id=f"mtg-{m['id']}", uid=f"u-{m['user_id']}", title=m["title"], cat=m["category"],
              s=m["start_at"], e=m["end_at"],
              pid=f"loc-{m['location_id']}" if m["location_id"] else None,
              online=int(m["is_online"]),
              url="https://meet.google.com/mock" if m["is_online"] == "1" else None)
         for m in rows("sim_meetings.csv")])

    # ---- transit plans: CSV carries local HH:MM, the schema wants instants
    tp = []
    for p in rows("sim_transit_plans.csv"):
        leave = local_to_utc(p["date"], p["leave_home_local"])
        wake = local_to_utc(p["date"], p["wake_up_local"]) if p["wake_up_local"] else leave
        tp.append(dict(id=f"tp-{p['id']}", mid=f"mtg-{p['meeting_id']}",
                       opid=f"loc-{p['origin_id']}" if p["origin_id"] != "home" else f"home-{p['user_id']}",
                       mode=p["mode"], wake=wake, leave=leave,
                       arrive=local_to_utc(p["date"], p["arrive_target_local"]),
                       total=int(p["planned_minutes"])))
    con.executemany(
        "INSERT INTO transit_plans (id,meeting_id,origin_place_id,transport_type,"
        "wake_up_at,leave_home_at,arrive_at,total_minutes,source,is_current) "
        "VALUES (:id,:mid,:opid,:mode,:wake,:leave,:arrive,:total,'estimate',1)", tp)

    # ---- notifications: the schema refuses any wake_up/leave_home/re_check/missed_bus
    #      row without a meeting_id, so a phantom notification cannot be stored at all
    con.executemany(
        "INSERT INTO notifications (id,user_id,meeting_id,type,fire_at,created_by,status) "
        "VALUES (:id,:uid,:mid,:type,:fire,:by,'scheduled')",
        [dict(id=f"ntf-{n['id']}", uid=f"u-{n['user_id']}", mid=f"mtg-{n['meeting_id']}",
              type=n["type"], fire=n["fire_at"], by=n["created_by"])
         for n in rows("sim_notifications.csv")])

    # ---- task_events: the append-only truth log the nightly job reads
    con.executemany(
        "INSERT INTO task_events (id,user_id,meeting_id,event_type,category,"
        "estimated_minutes,actual_minutes,lateness_minutes,occurred_at,payload) "
        "VALUES (:id,:uid,:mid,:et,:cat,:est,:act,:late,:at,:payload)",
        [dict(id=f"ev-{e['id']}", uid=f"u-{e['user_id']}", mid=f"mtg-{e['meeting_id']}",
              et=e["event_type"], cat=e["category"] or None,
              est=int(e["estimated_minutes"]) if e["estimated_minutes"] else None,
              act=int(e["actual_minutes"]) if e["actual_minutes"] else None,
              late=int(e["lateness_minutes"]) if e["lateness_minutes"] else None,
              at=e["occurred_at"], payload=e["note"] or None)
         for e in rows("sim_task_events.csv")])

    con.commit()
    return con


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "meira_db.sqlite"))
    args = ap.parse_args()
    con = seed(Path(args.out))
    print(f"seeded {args.out}")
    for t in ("users", "user_transport_types", "places", "meetings", "transit_plans",
              "notifications", "task_events"):
        print(f"  {t:<22} {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]:>5}")
    orphan = con.execute("""
        SELECT COUNT(*) FROM notifications
        WHERE type <> 'checkin' AND task_id IS NULL AND meeting_id IS NULL""").fetchone()[0]
    print(f"  phantom notifications  {orphan:>5}  (must be 0)")
