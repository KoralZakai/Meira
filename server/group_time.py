"""group_time — "find time together" (Feature 3, Koral 20.10).

A group of people want one slot (a party, a meeting). The organizer proposes
2–6 slots; for each member and slot the answer is:

  manual   what the member said (yes/no) — always wins
  auto     free/busy from the member's OWN saved tasks, computed here at read
           time, only once she JOINED the group (joining is the consent)
  waiting  not joined yet → "?"
  no_data  joined, but her day could not be read → "?" — never ✗ (rule 1)
  past     the slot has gone

The organizer sees ✓ / ✗ / ? per member × slot. Never what the busy thing is:
the reason for a ✗ is not in any response.

Who is on Meira: a contact's phone resolves to a member key ONLY through a
verified phone link (phone_links). The organizer is never told which contacts
matched — every member gets a share link back, and the ones on Meira also get a
push. Someone not on Meira answers on /g/{token} without installing anything.

Tables: migration 0016. Grid logic is pure (`grid`, `slot_state`) and tested
without I/O.
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import clashes as _clashes
import database_service
import day_schedule as _ds
import history_store
import identity_keys
import phone_links
import supabase_tasks
from tz import now_il, today_il

logger = logging.getLogger(__name__)

MAX_SLOTS = 6
MAX_MEMBERS = 30
TOKEN_DAYS = 14
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


# ─── pure ───────────────────────────────────────────────────────────────────

def intl_digits(phone: object) -> str:
    """'050-123 4567' / '+972 50…' → '972501234567' — the form phone_links stores."""
    d = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if d.startswith("00"):
        d = d[2:]
    if d.startswith("0") and len(d) == 10:
        d = "972" + d[1:]
    return d


def token_hash(token: str) -> str:
    return hashlib.sha256(f"meira-group:{token}".encode()).hexdigest()


def _mins(hhmm: str) -> int:
    h, m = str(hhmm)[:5].split(":")
    return int(h) * 60 + int(m)


def slot_busy(rows: list, day: str, start: str, minutes: int) -> bool:
    """Does any TIMED, still-standing task on `day` overlap [start, start+minutes]?
    Untimed to-dos do not make anyone busy."""
    a, b = _mins(start), _mins(start) + minutes
    for r in rows:
        if str(r.get("date") or "")[:10] != day:
            continue
        if r.get("status") in ("complete", "moved", "missed"):
            continue
        s = _clashes.start_of(r)
        if not s:
            continue
        rs = _mins(s)
        re_ = rs + max(1, int(_ds.duration_of(r) or 30))
        if rs < b and a < re_:
            return True
    return False


def slot_state(member: dict, slot: dict, manual: Optional[str], auto: Optional[str],
               now: datetime) -> dict:
    """One cell: {value: yes|no|unknown, source: manual|auto|waiting|no_data|past}."""
    if datetime.fromisoformat(f"{slot['day']}T{slot['start']}") <= now.replace(tzinfo=None):
        return {"value": "unknown", "source": "past"}
    if manual in ("yes", "no"):
        return {"value": manual, "source": "manual"}
    if member.get("status") != "joined":
        return {"value": "unknown", "source": "declined" if member.get("status") == "declined" else "waiting"}
    if auto in ("yes", "no"):
        return {"value": auto, "source": "auto"}
    return {"value": "unknown", "source": "no_data"}


def grid(group: dict, members: list, slots: list, answers: list, autos: dict,
         now: datetime) -> dict:
    """The organizer's view: rows × slots, counts per slot, and the best slot
    (most yes, then fewest no, then earliest). `autos`: {(memberId, slotId): yes|no}."""
    manual = {(a["memberId"], a["slotId"]): a["value"] for a in answers}
    ordered = sorted(slots, key=lambda s: (s["day"], s["start"]))
    rows, counts = [], {s["id"]: {"yes": 0, "no": 0, "unknown": 0} for s in ordered}
    for m in sorted(members, key=lambda m: (m.get("role") != "owner", m.get("displayName") or "")):
        cells = []
        for s in ordered:
            c = slot_state(m, s, manual.get((m["id"], s["id"])), autos.get((m["id"], s["id"])), now)
            counts[s["id"]][c["value"]] += 1
            cells.append({"slotId": s["id"], **c})
        rows.append({"memberId": m["id"], "name": m.get("displayName") or "",
                     "role": m.get("role"), "status": m.get("status"), "cells": cells})
    live = [s for s in ordered if not any(
        c["slotId"] == s["id"] and c["source"] == "past" for r in rows for c in r["cells"])]
    best = None
    if live and members:
        top = max(live, key=lambda s: (counts[s["id"]]["yes"], -counts[s["id"]]["no"],
                                       -ordered.index(s)))
        if counts[top["id"]]["yes"] > 0:
            best = top["id"]
    answered = all(c["source"] in ("manual", "auto", "past", "declined")
                   for r in rows for c in r["cells"])
    return {"group": {k: group.get(k) for k in ("id", "title", "minutes", "status", "lockedSlot")},
            "slots": [{"id": s["id"], "day": s["day"], "start": s["start"],
                       **counts[s["id"]]} for s in ordered],
            "rows": rows, "best": best, "everyone_answered": answered}


def clean_slots(raw: list, today: date) -> list:
    out, seen = [], set()
    for s in raw or []:
        day, start = str((s or {}).get("day") or "")[:10], str((s or {}).get("start") or "")[:5]
        try:
            d = date.fromisoformat(day)
        except ValueError:
            continue
        if not _HHMM.match(start) or d < today or d > today + timedelta(days=365):
            continue
        if (day, start) in seen:
            continue
        seen.add((day, start))
        out.append({"day": day, "start": start})
    return out[:MAX_SLOTS]


# ─── storage ────────────────────────────────────────────────────────────────

async def _rows(table: str, params: dict) -> Optional[list]:
    return await database_service._get(table, params)


async def _member_lookup(phone: str) -> Optional[str]:
    digits = intl_digits(phone)
    if len(digits) < 9:
        return None
    try:
        return phone_links.user_for(digits)
    except Exception as exc:  # noqa: BLE001 — an unreadable link resolves nobody
        logger.warning("group member lookup failed: %s", exc)
        return None


async def _notify(member_key: str, title: str, body: str) -> bool:
    try:
        rec = await database_service.get_user_record(member_key)
        token = (rec or {}).get("pushToken")
        if not token:
            return False
        import push
        return await push.send_push(token, title, body)
    except Exception as exc:  # noqa: BLE001 — the app's own tick catches invites too
        logger.warning("group push failed: %s", exc)
        return False


async def create(owner_key: str, owner_name: str, title: str, minutes: int,
                 slots: list, members: list, base_url: str) -> dict:
    """New group. members: [{name, phone}]. Returns {ok, groupId, invites:[{name, link}]}
    — a link for EVERY member, so nothing says who is on Meira."""
    owner = identity_keys.canonical(owner_key)
    slots = clean_slots(slots, today_il())
    if len(slots) < 1:
        return {"ok": False, "reason": "no_valid_slots"}
    people = [m for m in (members or []) if isinstance(m, dict) and (m.get("phone") or m.get("name"))]
    if not people:
        return {"ok": False, "reason": "no_members"}
    if len(people) > MAX_MEMBERS:
        return {"ok": False, "reason": "too_many_members"}
    gid = str(uuid.uuid4())
    group = {"id": gid, "userKey": owner, "title": str(title or "")[:120] or None,
             "minutes": max(15, min(int(minutes or 60), 1440)), "status": "open"}
    if not await database_service._upsert("lumi_groups", [group]):
        return {"ok": False, "reason": "write_failed"}
    expires = (datetime.now(timezone.utc) + timedelta(days=TOKEN_DAYS)).isoformat()
    rows = [{"id": str(uuid.uuid4()), "groupId": gid, "userKey": owner, "memberKey": owner,
             "displayName": owner_name or None, "role": "owner", "status": "joined"}]
    invites, pushes = [], []
    for p in people:
        token = secrets.token_urlsafe(18)
        key = await _member_lookup(p.get("phone"))
        if key and identity_keys.canonical(key) == owner:
            continue                                   # she added herself
        rows.append({"id": str(uuid.uuid4()), "groupId": gid, "userKey": owner,
                     "memberKey": identity_keys.canonical(key) if key else None,
                     "displayName": str(p.get("name") or "")[:80] or None, "role": "member",
                     "status": "invited", "tokenHash": token_hash(token), "tokenExpires": expires})
        invites.append({"name": p.get("name") or "", "link": f"{base_url.rstrip('/')}/g/{token}"})
        if key:
            pushes.append(identity_keys.canonical(key))
    slot_rows = [{"id": str(uuid.uuid4()), "groupId": gid, **s} for s in slots]
    if not (await database_service._upsert("lumi_group_members", rows)
            and await database_service._upsert("lumi_group_slots", slot_rows)):
        await database_service._delete("lumi_groups", {"id": f"eq.{gid}"})
        return {"ok": False, "reason": "write_failed"}
    for key in pushes:
        await _notify(key, f"👥 {owner_name or 'Meira'}",
                      f"{title or ''} — {len(slot_rows)} options. Open Meira to answer.".strip(" —"))
    return {"ok": True, "groupId": gid, "invites": invites}


async def _load(gid: str) -> tuple[Optional[dict], Optional[list], Optional[list], Optional[list]]:
    g = await _rows("lumi_groups", {"select": "*", "id": f"eq.{gid}", "limit": "1"})
    if not g:
        return None, None, None, None
    owner = g[0]["userKey"]
    members = await _rows("lumi_group_members", {"select": "*", "groupId": f"eq.{gid}", "userKey": f"eq.{owner}"})
    slots = await _rows("lumi_group_slots", {"select": "id,day,start", "groupId": f"eq.{gid}"})
    answers = await _rows("lumi_group_answers", {"select": "memberId,slotId,value", "groupId": f"eq.{gid}"})
    return g[0], members, slots, answers


async def _autos(members: list, slots: list, minutes: int) -> dict:
    """Free/busy for every JOINED member on Meira, from their own tasks.
    A member whose day cannot be read gets no entry → 'no_data' (?), not ✗."""
    out: dict = {}
    if not slots:
        return out
    days = sorted({s["day"] for s in slots})
    for m in members:
        if m.get("status") != "joined" or not m.get("memberKey"):
            continue
        rows, reason = await history_store.tasks(m["memberKey"], days[0], days[-1])
        if rows is None:
            logger.warning("group auto answer: member %s unreadable (%s)", m["id"][:8], reason)
            continue
        for s in slots:
            out[(m["id"], s["id"])] = "no" if slot_busy(rows, s["day"], s["start"], minutes) else "yes"
    return out


def _mine(members: list, key: str) -> Optional[dict]:
    k = identity_keys.canonical(key)
    return next((m for m in members if m.get("memberKey") == k), None)


async def view(gid: str, caller_key: str) -> dict:
    """The organizer gets the grid. A member gets the title, the slots and HER
    own row only. Anyone else: not_found (no existence leak)."""
    g, members, slots, answers = await _load(gid)
    if g is None or members is None or slots is None or answers is None:
        return {"ok": False, "reason": "not_found" if g is None else "read_failed"}
    me = _mine(members, caller_key)
    if not me:
        return {"ok": False, "reason": "not_found"}
    autos = await _autos(members if me["role"] == "owner" else [me], slots, g["minutes"])
    full = grid(g, members, slots, answers, autos, now_il())
    if me["role"] == "owner":
        return {"ok": True, "role": "owner", **full}
    mine = next(r for r in full["rows"] if r["memberId"] == me["id"])
    owner = next((m for m in members if m["role"] == "owner"), {})
    return {"ok": True, "role": "member", "group": full["group"], "slots": [
        {k: s[k] for k in ("id", "day", "start")} for s in full["slots"]],
        "me": mine, "organizer": owner.get("displayName") or ""}


async def my_groups(caller_key: str) -> dict:
    """Groups she organizes or was invited to (not declined), newest first."""
    k = identity_keys.canonical(caller_key)
    rows = await _rows("lumi_group_members", {"select": "groupId,role,status,userKey",
                                              "memberKey": f"eq.{k}", "status": "neq.declined"})
    if rows is None:
        return {"ok": False, "reason": "read_failed"}
    out = []
    for r in rows:
        g = await _rows("lumi_groups", {"select": "id,title,minutes,status,lockedSlot,createdAt,userKey",
                                        "id": f"eq.{r['groupId']}", "userKey": f"eq.{r['userKey']}", "limit": "1"})
        if g:
            out.append({**{k2: g[0].get(k2) for k2 in ("id", "title", "minutes", "status", "lockedSlot", "createdAt")},
                        "role": r["role"], "myStatus": r["status"]})
    out.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
    return {"ok": True, "groups": out}


async def _answer_rows(gid: str, member: dict, answers: dict, slots: list) -> bool:
    valid = {s["id"] for s in slots}
    rows = [{"memberId": member["id"], "slotId": sid, "groupId": gid, "value": v,
             "updatedAt": datetime.now(timezone.utc).isoformat()}
            for sid, v in (answers or {}).items() if sid in valid and v in ("yes", "no")]
    if not rows:
        return True
    return await database_service._upsert("lumi_group_answers", rows, on_conflict="memberId,slotId")


async def respond(gid: str, caller_key: str, join: Optional[bool], answers: Optional[dict]) -> dict:
    """A member joins/declines and/or sets manual answers {slotId: yes|no}."""
    g, members, slots, _ = await _load(gid)
    if g is None or members is None or slots is None:
        return {"ok": False, "reason": "not_found" if g is None else "read_failed"}
    me = _mine(members, caller_key)
    if not me:
        return {"ok": False, "reason": "not_found"}
    if join is not None and me["role"] != "owner":
        status = "joined" if join else "declined"
        if not await database_service._upsert("lumi_group_members", [{**me, "status": status}]):
            return {"ok": False, "reason": "write_failed"}
        me = {**me, "status": status}
    if answers and not await _answer_rows(gid, me, answers, slots):
        return {"ok": False, "reason": "write_failed"}
    return {"ok": True, "status": me["status"]}


async def by_token(token: str) -> tuple[Optional[dict], Optional[dict], Optional[list], str]:
    """(group, member, slots, reason) for a share link, or (None…, reason)."""
    rows = await _rows("lumi_group_members", {"select": "*", "tokenHash": f"eq.{token_hash(token)}", "limit": "1"})
    if rows is None:
        return None, None, None, "read_failed"
    if not rows:
        return None, None, None, "not_found"
    m = rows[0]
    if m.get("tokenExpires") and datetime.fromisoformat(str(m["tokenExpires"]).replace("Z", "+00:00")) < datetime.now(timezone.utc):
        return None, None, None, "expired"
    g, _, slots, _ = await _load(m["groupId"])
    if g is None or slots is None:
        return None, None, None, "not_found"
    return g, m, sorted(slots, key=lambda s: (s["day"], s["start"])), ""


async def answer_by_token(token: str, answers: dict) -> dict:
    """Someone not on Meira answers on the web page. Answering = joined (manual only)."""
    g, m, slots, reason = await by_token(token)
    if g is None or m is None or slots is None:
        return {"ok": False, "reason": reason}
    if (g.get("status") or "open") != "open":
        return {"ok": False, "reason": "closed"}
    if not await database_service._upsert("lumi_group_members", [{**m, "status": "joined"}]):
        return {"ok": False, "reason": "write_failed"}
    if not await _answer_rows(g["id"], m, answers, slots):
        return {"ok": False, "reason": "write_failed"}
    return {"ok": True}


async def lock(gid: str, caller_key: str, slot_id: str) -> dict:
    """The organizer picks the slot. Each member on Meira whose answer is YES
    (manual, or auto once joined) gets it as a task; the others are told it."""
    g, members, slots, answers = await _load(gid)
    if g is None or members is None or slots is None or answers is None:
        return {"ok": False, "reason": "not_found" if g is None else "read_failed"}
    me = _mine(members, caller_key)
    if not me or me["role"] != "owner":
        return {"ok": False, "reason": "not_found"}
    slot = next((s for s in slots if s["id"] == slot_id), None)
    if not slot:
        return {"ok": False, "reason": "bad_slot"}
    autos = await _autos(members, [slot], g["minutes"])
    view_ = grid(g, members, [slot], answers, autos, now_il())
    yes_ids = {r["memberId"] for r in view_["rows"] if r["cells"][0]["value"] == "yes"}
    added, failed = 0, 0
    for m in members:
        if m["id"] not in yes_ids or not m.get("memberKey"):
            continue
        uid = await supabase_tasks.user_id_for_phone(m["memberKey"])
        task = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"meira-group:{gid}:{m['id']}")),
                "text": g.get("title") or "👥", "category": "meeting", "priority": "have_to",
                "fixed_time": slot["start"], "date": slot["day"], "duration_minutes": g["minutes"],
                "provenance": {"channel": "app_manual"}}
        ok = bool(uid) and bool(await supabase_tasks.upsert_task(uid, task))
        added += ok
        failed += (not ok)
        if ok and m["role"] != "owner":
            await _notify(m["memberKey"], f"📅 {g.get('title') or 'Meira'}",
                          f"{slot['day'][8:10]}.{int(slot['day'][5:7])} {slot['start']} — added to your day")
    if not await database_service._upsert("lumi_groups", [{**g, "status": "locked", "lockedSlot": slot_id}]):
        return {"ok": False, "reason": "write_failed", "added": added}
    return {"ok": True, "added": added, "failed": failed, "yes": len(yes_ids)}
