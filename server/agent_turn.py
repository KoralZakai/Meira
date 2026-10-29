"""agent_turn — ONE turn of Lumi's brain, for any channel.

The agent was already channel-agnostic in everything but its name: give
`lumi_agent.handle_whatsapp_message` text and a user and it returns a reply.
What was welded to WhatsApp was the only DOOR to it — `POST /webhook/whatsapp`
— so the app could not reach the brain at all and grew its own, weaker one
(LumiCoachEngine: regex intent matching and a single JSON call, no tools, no
memory, no personality). Two brains, and only one of them good.

This module is the door and the shared body of a turn:

    resolve the user → stamp "now" → run the agent → persist what it created

Persistence lives HERE, not in the webhook, because that is where the divergence
would start again: a second copy of "save the task, mint one id across the three
stores, stamp provenance" drifts within a week. The webhook keeps only what is
genuinely WhatsApp — Twilio parsing, sending messages and images — and the app
endpoint keeps only what is genuinely the app.

Auto-routing is deliberately NOT here: WhatsApp has to plan the trip itself
because the phone is not in the conversation, while the app plans its own routes
locally through ensureTravelChain with the user's real position. Same brain,
each channel keeping the part only it can do.

Dependencies: lumi_agent, user_memory, supabase_tasks, provenance, session, tz.
Consumed by main.py (both the webhook and POST /agent/chat).
"""
from __future__ import annotations

import user_quota as _quota
import logging
import re as _re
import time as _time
from datetime import date as _date, datetime as _datetime, timedelta as _timedelta
from typing import Optional

import advice
import clashes
import conversation
import day_schedule
import day_slots
import provenance
import session
import fit_check
import place_reminder
import task_grouping
import task_rescue
import supabase_tasks
import known_places
import routine_match
import outgoing_confirm
import past_log
import constraints
import frame as _frame
import intent_turn
import model_router
import place_ranker
import reminders
import user_profile
import tz as _tz
import understand as _understand
import user_memory
from lumi_agent import handle_whatsapp_message

logger = logging.getLogger(__name__)


def override_task_date(task: dict, content: str) -> dict:
    """Force a task's date to the deterministically-resolved one when the message
    carries exactly ONE relative-date expression ('מחר', 'in 2 days', '27.7').

    The model skips calculate_date and invents dates — it wrote 24.7 for the day
    after 26.7, which stored the appointment IN THE PAST, so every `date >= today`
    path dropped it silently. Exactly-one keeps multi-date day-planning messages
    ('tomorrow X, Thursday Y') on the model's per-task dates.

    A date that belongs to what a task PREPARES FOR is not the task's own day
    (tz.date_expressions). 17.10: "ללמוד לראיון עבודה למחר" was filed as
    studying tomorrow, the morning of the interview.
    """
    own, target = _tz.date_expressions(content or "")
    if target and _tz.is_prep(task.get("text")):
        return _prep_day(task, own, target)
    # Anything else in a preparing sentence — the interview itself, say — is
    # on the target's day.
    matches = target or own
    if not matches:
        # No date in the message at all: a NEW task is today's, and never one
        # on a day that has gone. 13.10: "יש מיטאפ … ב 18:00 עד 20:00" was saved
        # on 10.10 — the model lifted the date from the conversation's last
        # turn, three days old. A past date is never what she meant.
        today = _tz.today_il().isoformat()
        if str(task.get("date") or "") and str(task.get("date")) < today:
            logger.warning("task date %s is in the past and the message names none -> %s",
                           task.get("date"), today)
            return {**task, "date": today}
        return task
    if len(matches) != 1:
        return task
    resolved = _tz.resolve_date_at(matches[0])
    if not resolved or task.get("date") == resolved.isoformat():
        return task
    logger.warning("task date corrected %s -> %s (from %r)",
                   task.get("date"), resolved.isoformat(), matches[0])
    return {**task, "date": resolved.isoformat()}


def _prep_day(task: dict, own: list, target: list) -> dict:
    """Preparing for something on `target`'s day: it happens BEFORE that day.

    Her own day for the preparing wins ("מחר ללמוד לראיון של יום שלישי");
    else the model's day when it already sits before the target; else today.
    The target's day becomes the deadline, so the card says what it is for.
    """
    today = _tz.today_il()
    when = _tz.resolve_date_at(target[0]) if len(set(target)) == 1 else None
    if when is None or when < today:
        return override_task_date(task, " ".join(own))
    day = _tz.resolve_date_at(own[0]) if len(set(own)) == 1 else None
    if day is None:
        try:
            model_day = _date.fromisoformat(str(task.get("date") or ""))
        except ValueError:
            model_day = None
        day = model_day if model_day and today <= model_day < when else today
    out = {**task, "date": day.isoformat()}
    if not task.get("deadline"):
        out["deadline"] = when.isoformat()
    if out.get("date") != task.get("date"):
        logger.warning("prep task date %s -> %s, deadline %s (it prepares for %r)",
                       task.get("date"), out["date"], out.get("deadline"), target[0])
    return out


def reminder_tasks(reminders_set: list, tasks: list, updates: list) -> list:
    """Each reminder set this turn, as a timed task — unless the turn already
    saved or moved something at that minute.

    A reminder lived only in reminders.json and went out over WhatsApp (and an
    Expo push, when one was registered). On 13.10 the WhatsApp account was
    disabled and every "✓ I'll remind you" went nowhere. A timed task is armed
    by the app itself (NotificationService.scheduleTaskReminders), which is
    the channel that reaches her phone.
    """
    out: list = []
    taken = {(t.get("date"), t.get("fixed_time")) for t in tasks}
    moved_to = {(u or {}).get("fixed_time") for u in updates}
    for r in reminders_set or []:
        key = (r.get("date"), r.get("time"))
        if not r.get("time") or key in taken or r.get("time") in moved_to:
            continue
        taken.add(key)
        out.append({
            "text": str(r.get("text") or "").strip() or "⏰",
            "category": "general", "priority": "have_to", "duration_minutes": 10,
            "fixed_time": r.get("time"), "date": r.get("date"), "location": None,
        })
    return out


async def persist_agent_tasks(
    phone: str,
    content: str,
    response: dict,
    channel: str = "whatsapp",
) -> list:
    """Save every task the turn inferred, and return them with their real ids.

    A day-planning message can carry several. The JSON memory store is written
    FIRST and unconditionally — it is what `GET /tasks/{phone}` serves, so it
    must not depend on the database being up — and it mints the stable id that
    the Supabase mirror then reuses, so all stores share ONE id.
    """
    tasks = response.get("tasks") or ([response["task"]] if response.get("task") else [])
    if not tasks:
        return []
    tasks = [override_task_date(t, content) for t in tasks]

    # Which channel, which conversation, which turn. Tasks from ONE message
    # share a turnId, so a message's output can be found as a unit.
    try:
        prov = provenance.stamp(phone, channel, content)
        tasks = [{**t, "provenance": prov} for t in tasks]
    except Exception as exc:  # noqa: BLE001 — never block a save
        logger.warning("provenance stamp skipped: %s", exc)

    # A message that lists eight things is one body of work, not eight
    # strangers. A shared subgroup is what the app's task board groups by, so
    # the batch arrives as the project it is instead of eight loose notes.
    try:
        label = task_grouping.group_label(
            [t.get("text", "") for t in tasks], content,
            (user_profile.get_profile(phone).get("language") or "he"),
        )
        if label:
            tasks = [{**t, "subgroup": t.get("subgroup") or label} for t in tasks]
            logger.info("grouped %d tasks under %r", len(tasks), label)
    except Exception as exc:  # noqa: BLE001 — a label is a bonus, never a blocker
        logger.warning("task grouping skipped: %s", exc)

    uid = None
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            await supabase_tasks.flush_pending(phone)   # older queued tasks first
    except Exception as exc:  # noqa: BLE001
        logger.warning("supabase uid lookup skipped: %s", exc)

    try:
        existing = user_memory.tasks_for_phone(phone)
    except Exception as exc:  # noqa: BLE001 — no list means no duplicate check, not no save
        logger.warning("duplicate check skipped: %s", exc)
        existing = []

    saved: list = []
    for task in tasks:
        twin = task_rescue.already_planned(existing, task)
        if twin and twin.get("id"):
            # Already on her day: bring it up to date, never add it twice.
            patch = task_rescue.changed_fields(twin, task)
            logger.warning("task already planned — %s", f"updating {sorted(patch)}" if patch else "unchanged")
            if patch:
                try:
                    user_memory.update_task(phone, twin["id"], patch)
                    if uid:
                        await supabase_tasks.update_task(uid, str(twin["id"]), patch)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("duplicate update failed: %s", exc)
            if not any(str(s.get("id")) == str(twin["id"]) for s in saved):
                saved.append({**twin, **patch})
            continue
        try:
            stored = user_memory.add_task(phone, task)
            task = {**task, "id": stored["id"]}
            # The just-created task becomes the conversation focus, so a
            # follow-up ('from home by bus', 'remind me', 'yes') resolves to IT.
            session.set_active_task(
                phone, stored.get("id"),
                task.get("location") if isinstance(task.get("location"), str) else None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory task save failed: %s", exc)
        try:
            if uid:
                await supabase_tasks.upsert_task(uid, task)
            else:
                supabase_tasks.queue_pending(phone, task)
        except Exception as exc:  # noqa: BLE001
            logger.warning("supabase task mirror skipped: %s", exc)
        saved.append(task)
        # The same task twice in ONE turn is one task (20.10: the agent called
        # infer_task_details twice for "ללכת לבנק מחר" and both were saved).
        if task.get("id"):
            existing = [*existing, task]
    return saved


def _here_stamp(here: Optional[dict]) -> str:
    """"Where she is" as a user-turn prefix, or "" when unknown.

    Same channel as the clock, and for the same reason: the system prompt is
    cache-shaped and byte-identical across turns (lumi_agent._STATIC_RULES must
    stay at character zero), so a per-turn fact cannot go in it. It also
    happens to be where the model actually reads such things.

    Only what the caller measured. No invented precision, no stored history:
    the app sends a fix it already had, and if it sent none the turn simply
    does not claim to know."""
    if not isinstance(here, dict):
        return ""
    try:
        lat, lng = float(here["lat"]), float(here["lng"])
    except (KeyError, TypeError, ValueError):
        return ""
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return ""
    label = str(here.get("label") or "").strip()
    # ~100 m: enough to route from, not enough to pinpoint a door (7.10).
    where = f"{label} ({lat:.3f},{lng:.3f})" if label else f"{lat:.3f},{lng:.3f}"
    return f"[נמצאת עכשיו ב-{where}] "


# The app's mic: she speaks, the app plans. The planner (day_planner) runs
# AFTER this turn and places every flexible task into real free time, so a
# clock time the model invents here would pin the task and defeat it. Stamped
# into the user turn, like `now` and `here`, because that is the part of the
# prompt the model reliably reads — and it keeps the static prefix cacheable.
VOICE_PLAN_STAMP = (
    "[APP VOICE → PLAN TODAY: save each task for today unless she names another "
    "day. Do NOT give a flexible task a clock time — the app's planner places it "
    "right after this turn. Keep a time only if she said one. If a task prepares "
    "for an appointment she already has, do not create the appointment again. "
    "Her words are a voice transcript: a word may be mis-heard — read by meaning. "
    "Reply in ONE short sentence.] "
)


# The same mic, when what she said is a QUESTION. On 7.10 "what's the fastest
# beach by car from home?" went through the plan stamp ("save each task for
# today") and came back as "which beach?" and then "where do you live?". A
# question is answered, with the tools — nothing is saved that she did not ask
# to save.
VOICE_QUESTION_STAMP = (
    "[APP VOICE → SHE ASKED A QUESTION: answer it with your tools (find_best_place, "
    "route_now, get_my_tasks, check_availability, web_search…). Save nothing she did "
    "not ask to save. Never ask what a tool can find out — not which place, not where "
    "she is or lives. Her words are a voice transcript: a word may be mis-heard — "
    "read by meaning. Answer in 1-2 short lines.] "
)


def _mode_stamp(mode: Optional[str], kind: Optional[str] = None) -> str:
    """The per-turn instruction for a known app mode, or "" for anything else."""
    if mode != "voice_plan":
        return ""
    return VOICE_QUESTION_STAMP if kind == "question" else VOICE_PLAN_STAMP


# The profile fields the APP owns — she edits them on the Profile screen — and
# the agent needs. Nothing carried them to the server: the app writes its
# profile to Supabase, the agent reads profiles.json, and no code joins the
# two. So "🔁 Routines: קיקבוקס 20:30-21:30 יגאל אלון 94" and "🚲 bike" were
# on her phone and invisible to Meira, whose transport default is "car".
#
# field sent → field stored. The two free-text fields land BESIDE the agent's
# own, never over them: on 2026-09-28 her phone's Routines box said "מקלחת
# בוקר, קפה…" while what she had told Meira in the chat lived in the server's
# routinesNotes — overwriting one with the other would have erased the very
# kickboxing line this sync exists to make readable. routine_match.notes_of
# reads both.
_APP_PROFILE_FIELDS = {
    "transportType": ("transportType", ("bus", "train", "car", "walk", "bike")),
    "homeAddress": ("homeAddress", None),
    "routinesNotes": ("appRoutinesNotes", None),
    "hobbies": ("appHobbies", None),
    # How pushy Meira is around a study block (reschedule.nudges_for) — the Profile choice.
    "nudgeLevel": ("nudgeLevel", ("alarm", "gentle", "motivating")),
}


def sync_app_profile(phone: str, sent: dict) -> dict:
    """Adopt what the app says about her profile. -> the fields that changed.

    Sent with every chat turn, so the trigger is the conversation itself: the
    moment she talks to Meira, Meira has the profile she is looking at. Only
    the four fields above, only non-empty strings, capped — a turn cannot
    blank a field or write anything else.
    """
    if not phone or not isinstance(sent, dict):
        return {}
    try:
        current = user_profile.get_profile(phone) or {}
    except Exception:  # noqa: BLE001
        current = {}
    changed: dict = {}
    for field, (stored, allowed) in _APP_PROFILE_FIELDS.items():
        value = sent.get(field)
        if not isinstance(value, str):
            continue
        value = value.strip()[:2000]
        if not value or (allowed and value not in allowed):
            continue
        if current.get(stored) != value:
            changed[stored] = value
    if changed:
        try:
            user_profile.update_profile(phone, **changed)
            logger.warning("app profile adopted: %s", sorted(changed))
        except Exception as exc:  # noqa: BLE001 — a stale profile beats a failed turn
            logger.warning("app profile sync failed: %s", exc)
            return {}
    return changed


async def user_for_caller(caller: dict) -> tuple[dict, Optional[dict]]:
    """The user record and learned personality for a verified caller.

    The same record the WhatsApp path resolves, so history, memory and
    personality are shared rather than started again per channel. Used by
    POST /agent/chat and by the MCP door — two doors, one person.
    """
    key = caller["key"]
    user, learned = None, None
    try:
        from user_store import DatabaseService
        from personality_learning_service import PersonalityLearningService
        if caller.get("phone"):
            user = await DatabaseService.get_user_by_whatsapp(caller["phone"])
            if not user:
                user = await DatabaseService.create_user_from_whatsapp(caller["phone"])
        if user:
            learned = await PersonalityLearningService.get_learned_personality(str(user["id"]))
    except Exception as exc:  # noqa: BLE001 — degrade gracefully without a DB
        logger.warning("user_for_caller DB step skipped: %s", exc)
    # Without the DB step, the account id — the key the agent always uses for a
    # linked user — never the phone, which would start a second profile.
    return (user or {"id": caller.get("userId") or key, "name": "User", "language": "en"}), learned


# Worth understanding BEFORE the agent: a question, or words about getting
# somewhere. Only a gate on whether to ask the model early — the model still
# decides what it means; a false positive costs one understanding call.
_QUESTION_RE = _re.compile(
    r"[?？]|\b(how|where|which|what|closest|nearest|fastest|quickest)\b"
    r"|איך|איפה|איזה|איזו|לאן|כמה זמן|הכי|קרוב|מהר|הביתה|לחזור|להגיע|מגיעה|מגיעים"
    # Her bike or car is somewhere else (19.10) — a plan to work out, not a task.
    r"|אופניים|האוטו שלי|הרכב שלי|לאסוף את|תכנני|\b(bike|pick up|my car|plan)\b",
    _re.IGNORECASE)


# "When do I get HOME today / tomorrow / after the doctor?" is about a LATER trip from a saved
# appointment (plan_return_home), never "how do I get home from here, leaving now" (route_now):
# 21.10 it was answered as a taxi from where she was standing at one in the morning.
_RETURN_LATER_RE = _re.compile(
    r"(?:מתי|באיזו שעה|עד מתי|כמה זמן|when|what time).{0,30}"
    r"(?:חוזר|אחזור|אגיע|אהיה|נחזור|get|be|back).{0,40}(?:הביתה|בבית|home)", _re.IGNORECASE)


def asks_return_later(content: str) -> bool:
    return bool(_RETURN_LATER_RE.search(str(content or "")))


def may_be_a_question(content: str) -> bool:
    return bool(_QUESTION_RE.search(content or ""))


# What the understanding step cannot do — it keeps only add/update — and the
# agent can: reminders, alarms, deletions, messages to someone, routines.
_OTHER_ASK_RE = _re.compile(
    r"\b(remind|reminder|delete|remove|cancel|send|message|text|tell|every|routine)\b"
    r"|תזכיר|תזכורת|להזכיר|תמחק|למחוק|תמחקי|תבטל|לבטל|תבטלי"
    r"|תשלח|תשלחי|לשלוח|הודעה|תגיד|תגידי|תכתוב|תכתבי|כל יום|כל שבוע|בכל|שגרה",
    _re.IGNORECASE)


def understanding_covers(content: str, kind: Optional[str], saved: list) -> bool:
    """Did the understanding step already do everything this mic message asked?

    Then the agent has nothing left to do but write "saved ✓" — one full ReAct
    pass (a 24k-char prompt, 28 tools, 5-20 s) to repeat what the note already
    says. Only when it SAVED something, the message was "do", and nothing in it
    looks like a question or a kind of request the understanding cannot carry
    out. Anything doubtful still goes to the agent."""
    return (bool(saved) and kind == "do"
            and not may_be_a_question(content) and not _OTHER_ASK_RE.search(content or ""))


def _event_of(task: dict) -> Optional[dict]:
    """A task on her day → {name, address?, point?, start, end} when it has a time."""
    start = str(task.get("fixed_time") or task.get("fixedTime") or "")[:5]
    if not start or ":" not in start:
        return None
    loc = task.get("location")
    point, address = None, ""
    if isinstance(loc, dict):
        address = str(loc.get("address") or loc.get("displayName") or "")
        if loc.get("lat") not in (None, 0) and loc.get("lng") not in (None, 0):
            point = {"lat": loc["lat"], "lng": loc["lng"], "name": loc.get("displayName") or address}
    elif isinstance(loc, str):
        address = loc
    dur = int(task.get("duration_minutes") or task.get("durationMinutes") or 60)
    h, m = int(start[:2]), int(start[3:5])
    end_m = h * 60 + m + dur
    return {"id": str(task.get("id")), "name": str(task.get("text") or ""), "address": address,
            "point": point, "start": start, "end": f"{(end_m // 60) % 24:02d}:{end_m % 60:02d}"}


_EVENT_STOP = {"אני", "צריכה", "צריך", "להיות", "להגיע", "לעשות", "מה", "של", "את", "עם", "לי",
               "need", "to", "be", "at", "the", "and", "what", "do", "get", "i"}


def event_named(events: list, words: str, now: str) -> Optional[dict]:
    """The event on her day she named in passing ("במפגש של באות" → "באות מוצאות").

    A word counts when it appears in the event's name — with or without a
    one-letter Hebrew prefix (ב/ל/ה/מ/ו/ש) — and is not a stop word. The best
    score wins; on a tie, the next one still ahead. None when nothing matches:
    then the pickup is planned across her whole day instead."""
    tokens = []
    for w in _re.findall(r"[\w\u0590-\u05FF]+", words or ""):
        w = w.lower()
        if w in _EVENT_STOP or len(w) < 3:
            continue
        tokens.append(w)
        if w[0] in "בלהמוש" and len(w) > 3:
            tokens.append(w[1:])
    best, best_score = None, 0
    for ev in sorted(events, key=lambda e: (e["start"] < now, e["start"])):
        name = ev["name"].lower()
        score = sum(1 for t in set(tokens) if t in name)
        if score > best_score:
            best, best_score = ev, score
    return best


async def answer_vehicle(lookup: dict, content: str, user: dict, profile_key: str,
                         phone: str, here: Optional[dict], recall) -> Optional[dict]:
    """"My bike is on Florentin and I need to be at Baot" / "plan picking up my bike".

    The event comes from HER DAY (by the id the understanding matched, never by
    asking her). Routed by vehicle_chain; None when it cannot answer, and the
    agent takes over, with the reason in the log."""
    import geo
    import vehicle_chain
    try:
        profile = user_profile.get_profile(profile_key) or {}
    except Exception:  # noqa: BLE001
        profile = {}
    he = bool(_re.search(r"[\u0590-\u05FF]", content or "")) or user.get("language") == "he"

    def honest(he_text: str, en_text: str, reason: str) -> dict:
        # The agent, handed a failed plan, wrote the heading of one with
        # nothing under it (live, 19.10). Say what is missing instead.
        logger.warning("vehicle answer could not be worked out: %s", reason)
        return {"text": he_text if he else en_text, "type": "answer", "tasks": [], "departures": [],
                "chain": {"ok": False, "kind": "vehicle_pickup", "reason": reason}}

    start, _used, _note = await place_ranker.resolve_origin(profile, here, lookup.get("origin") or "auto")
    if not start:
        return honest("לא יודעת איפה את עכשיו — תדליקי מיקום או תגידי לי מאיפה את יוצאת.",
                      "I don't know where you are now — turn on location or tell me where you're starting.",
                      "need_origin")
    spot, _, why = await place_ranker.resolve_destination(lookup["vehicle_at"], profile, recall)
    if not spot:
        return honest(f"לא מצאתי במפה את \"{lookup['vehicle_at']}\" — איפה בדיוק האופניים?",
                      f"I couldn't find \"{lookup['vehicle_at']}\" on the map — where exactly is it?",
                      why or "vehicle_place_not_found")
    home, _, _ = await place_ranker.resolve_destination("home", profile, None)

    today = _tz.today_il().isoformat()
    tasks: list = []
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            tasks = await supabase_tasks.tasks_for_user(uid, today, today, include_location=True)
    except Exception as exc:  # noqa: BLE001 — say it in the log; the plan runs on what is known
        logger.warning("vehicle answer: her day unreadable: %s", exc)
    try:
        tasks += [t for t in user_memory.tasks_for_phone(phone) if str(t.get("date") or "")[:10] == today]
    except Exception as exc:  # noqa: BLE001
        logger.warning("vehicle answer: memory unreadable: %s", exc)
    events, seen = [], set()
    for t in tasks:
        if str(t.get("status") or "pending") in _DONE:
            continue
        ev = _event_of(t)
        if not ev:
            continue
        # The same event from the cloud AND the server's memory (live, 19.10:
        # "after Baot" offered twice) is one event.
        key = (ev["name"].strip().lower(), ev["start"])
        if key in seen:
            continue
        seen.add(key)
        if not ev["point"] and ev["address"]:
            ev["point"] = await geo.geocode(ev["address"])
        if ev["point"]:
            events.append(ev)

    now = _tz.now_il().strftime("%H:%M")
    chosen = next((e for e in events if e["id"] == str(lookup.get("event_task_id"))), None) \
        or event_named(events, lookup.get("event_words") or "", now)
    vehicle = lookup.get("vehicle") or "bike"
    wish = next((a for a in (lookup.get("also") or []) if a.get("start")), None)
    if wish:
        # "…and I also want to train at 20": the whole evening, searched.
        place, _, why = await place_ranker.resolve_destination(
            wish.get("place") or wish["what"], profile, recall)
        if not place:
            return honest(f"איפה {wish['what']}? אין לי מקום שמור בשם הזה.",
                          f"Where is {wish['what']}? I have no saved place by that name.",
                          why or "wish_place_not_found")
        if not home:
            return honest("אין לי כתובת בית שמורה — היא נקודת הסיום של הערב.",
                          "I have no home address saved — it's where the evening ends.", "no_home_saved")
        fixed = [{"name": e["name"], "place": e["point"], "start": e["start"], "end": e["end"]} for e in events]
        result = await vehicle_chain.plan_evening(
            route=geo.directions_detailed, here=start, vehicle_at=spot, home=home, events=fixed,
            wish={"name": wish["what"], "place": place, "start": wish["start"]}, now=now, vehicle=vehicle)
        text = vehicle_chain.say_evening(result, he) if result.get("ok") else None
    elif chosen:
        result = await vehicle_chain.plan(route=geo.directions_detailed, here=start, vehicle_at=spot,
                                          event=chosen["point"], home=home, start=chosen["start"],
                                          end=chosen["end"], now=now, vehicle=vehicle,
                                          event_name=chosen["name"])
        text = vehicle_chain.say(result, he, chosen["name"]) if result.get("ok") else None
    else:
        result = await vehicle_chain.plan_pickup(
            route=geo.directions_detailed, here=start, vehicle_at=spot, home=home,
            events=[{"name": e["name"], "place": e["point"], "start": e["start"], "end": e["end"]}
                    for e in events], now=now, vehicle=vehicle)
        text = vehicle_chain.say_pickup(result, he) if result.get("ok") else None
    if not text:
        refused = result.get("reason") == "directions_refused"
        return honest("Google לא החזיר לי מסלולים עכשיו — נסי שוב עוד דקה." if refused
                      else "לא מצאתי דרך לחשב את זה — אף מסלול לא חזר.",
                      "Google returned no routes right now — try again in a minute." if refused
                      else "I couldn't work it out — no route came back.",
                      result.get("reason") or "no_route")
    # "chain", not "answer": the installed app draws every "answer" as the
    # route/places AnswerCard, which needs `results` — a chain has none.
    return {"text": text, "type": "answer", "tasks": [], "departures": [], "chain": result}


async def answer_lookup(lookup: dict, content: str, user: dict, profile_key: str,
                        phone: str, here: Optional[dict]) -> Optional[dict]:
    """Run an understood place/route question and say the answer. -> the turn's
    reply {text, type: "answer", answer, tasks: [], departures: []}, or None when
    the lookup could not answer (the agent takes over)."""
    try:
        profile = user_profile.get_profile(profile_key) or {}
    except Exception:  # noqa: BLE001
        profile = {}
    keys = [k for k in dict.fromkeys((user.get("whatsapp_phone"), profile_key, phone)) if k]

    def recall(text: str) -> Optional[dict]:
        for key in keys:
            hit = known_places.resolve(key, text)
            if hit:
                return hit
        return None

    if lookup.get("what") == "vehicle":
        try:
            return await answer_vehicle(lookup, content, user, profile_key, phone, here, recall)
        except Exception as exc:  # noqa: BLE001 — the agent answers instead, and says why
            logger.warning("vehicle answer failed: %s", exc)
            return None

    he = bool(_re.search(r"[֐-׿]", content or "")) or user.get("language") == "he"
    if (lookup.get("what") == "places" and _MINE_RE.search(content or "")
            and _GYM_WORDS_RE.search(f"{lookup.get('category') or ''} {content}")):
        # "איפה חדר הכושר שלי?" is HER gym, not the nearest one (27.10 live:
        # it answered with Beit Dani while hers was on her day).
        return await _answer_trip({"what": "route", "destination": "the gym", "via": [],
                                   "modes": lookup.get("modes") or [], "origin": lookup.get("origin")},
                                  profile, recall, phone, here, he)
    if lookup.get("what") == "route" and (lookup.get("via") or lookup.get("arrive_by")
                                          or lookup.get("destination_task_id")):
        return await _answer_trip(lookup, profile, recall, phone, here, he)
    try:
        result = await place_ranker.lookup(
            profile=profile, here=here, recall=recall,
            category=lookup.get("category") if lookup.get("what") == "places" else None,
            destination=lookup.get("destination") if lookup.get("what") == "route" else None,
            modes=lookup.get("modes") or None, origin=lookup.get("origin") or "auto",
            open_now=bool(lookup.get("open_now")))
    except Exception as exc:  # noqa: BLE001 — the agent answers instead, and says why
        logger.warning("fast lookup failed: %s", exc)
        return None
    if not result.get("ok") or not result.get("results"):
        logger.warning("fast lookup could not answer: %s", result.get("reason"))
        return None
    text = place_ranker.say(result, he)
    logger.warning("fast answer (%s), %d chars", result.get("kind"), len(text))
    return {"text": text, "type": "answer", "tasks": [], "departures": [], "answer": result}


_GENERIC_PLACE_RE = _re.compile(
    r"^\s*(?:the |my )?(?:gym|gymnasium|workout|training|class|studio)\s*$"
    r"|^\s*(?:ל|ה|לה)?(?:חדר כושר|חדר הכושר|אימון|מכון|סטודיו|חוג)\s*$", _re.IGNORECASE)
_MINE_RE = _re.compile(r"שלי\b|\bmy\b", _re.IGNORECASE)
_GYM_WORDS_RE = _re.compile(r"gym|workout|training|אימון|כושר|קיקבוקס|יוגה|פילאטיס|ריצה", _re.IGNORECASE)


def _routine_place(profile: Optional[dict], said: str) -> Optional[str]:
    """The address in her routines of the kind she named ("קיקבוקס 20:30
    יגאל אלון 94" for "the gym"), or None."""
    try:
        for entry in routine_match.parse(routine_match.notes_of(profile)):
            if entry.get("address") and _GYM_WORDS_RE.search(str(entry.get("text") or "")):
                return entry["address"]
    except Exception as exc:  # noqa: BLE001 — no routine: ask instead
        logger.warning("trip: routines unreadable: %s", exc)
    return None


async def place_answer(phone: str, content: str, user: dict, profile_key: str,
                       here: Optional[dict]) -> Optional[dict]:
    """Her answer to "where is your gym?", or her correction of the one Meira
    used: save it as HER place of that kind, then route the trip again.
    None when no trip is waiting or the message is not a place."""
    try:
        pending = session.get_pending_place(phone)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pending place unreadable: %s", exc)
        return None
    if not pending:
        return None
    text = (content or "").strip()
    address = routine_match.address_in(text)
    if not address and pending.get("asked") and len(text) <= 60 and "?" not in text:
        address = text      # a name ("Space Gym") answers the question too
    if not address:
        return None
    he = bool(_HEBREW_RE.search(text)) or user.get("language") == "he"
    what = str(pending.get("what") or "gym")
    try:
        known_places.remember(profile_key, what, address)
        session.clear_pending_place(phone)
    except Exception as exc:  # noqa: BLE001 — say it, never claim it
        logger.warning("place not saved: %s", exc)
        return {"text": "לא הצלחתי לשמור את המקום — נסי שוב 🙏" if he else "Couldn't save that place — try again 🙏",
                "type": "answer", "tasks": [], "departures": []}
    head = (f"שמרתי: חדר הכושר שלך — {address} ✓" if he else f"Saved: your gym is at {address} ✓")
    lookup = {**(pending.get("lookup") or {}), "destination": address, "destination_task_id": None}
    answered = await answer_lookup(lookup, text, user, profile_key, phone, here)
    tail = answered["text"] if answered else ("את הדרך לא הצלחתי לחשב כרגע." if he
                                              else "I couldn't work out the route right now.")
    return {"text": f"{head}\n{tail}", "type": "answer", "tasks": [], "departures": []}


def _her_kind_of_place(day: list, said: str) -> Optional[dict]:
    """Her soonest open task of the kind she named that HAS a place, never
    one whose hour has already gone today (_her_days drops done and past days)."""
    now = _tz.now_il()
    today, hhmm = now.date().isoformat(), now.strftime("%H:%M")
    for t in sorted(day or [], key=lambda t: (str(t.get("date") or "9"), str(t.get("fixed_time") or "99"))):
        if not _place_of(t):
            continue
        if str(t.get("date") or "")[:10] == today and str(t.get("fixed_time") or "99") < hhmm:
            continue
        if t.get("category") == "gym" or _GYM_WORDS_RE.search(str(t.get("text") or "")):
            return t
    return None


def _place_of(task: dict) -> str:
    loc = task.get("location")
    if isinstance(loc, dict):
        return str(loc.get("address") or loc.get("displayName") or loc.get("name") or "").strip()
    return str(loc or "").strip()


async def _answer_trip(lookup: dict, profile: dict, recall, phone: str,
                       here: Optional[dict], he: bool) -> Optional[dict]:
    """A route with stops and/or an hour to arrive by (place_ranker.trip_via).
    The destination may be one of her tasks: its place, and its hour when she
    named none. None \u2192 the agent answers instead."""
    destination = lookup.get("destination") or ""
    arrive_by = lookup.get("arrive_by")
    task_id = lookup.get("destination_task_id")
    if task_id:
        task = next((t for t in await _her_days(phone) if str(t.get("id")) == str(task_id)), None)
        if task:
            destination = _place_of(task) or destination
            arrive_by = arrive_by or day_schedule.hhmm(
                task.get("fixed_time") or task.get("fixedTime"))
    generic = destination if (destination and not task_id and _GENERIC_PLACE_RE.match(destination)) else ""
    if generic:
        # 27.10, on her phone: "the gym" was geocoded to a SCHOOL in Herzliya
        # (הגימנסיה העברית), though her routine names her gym. A kind of place
        # she goes to is HERS: her next task of that kind, a place she saved,
        # the address in her routines — never a map search. None known → ask
        # ONCE, and keep the trip so the answer is saved and routed.
        mine = _her_kind_of_place(await _her_days(phone), generic)
        saved = None if mine else (recall(generic) if recall else None)
        routine = None if (mine or saved) else _routine_place(profile, generic)
        if mine:
            destination, arrive_by = _place_of(mine), arrive_by or day_schedule.hhmm(
                mine.get("fixed_time") or mine.get("fixedTime"))
        elif saved and saved.get("address"):
            destination = saved["address"]
        elif routine:
            destination = routine
        else:
            logger.warning("trip: a generic place with no task, saved place or routine of hers")
            try:
                session.set_pending_place(phone, {"lookup": lookup, "what": generic, "asked": True})
            except Exception as exc:  # noqa: BLE001 — the question still goes out
                logger.warning("trip: pending place not kept: %s", exc)
            return {"text": ("איפה חדר הכושר שלך? כתבי כתובת או שם, ואזכור." if he
                             else "Where is your gym? Send the address or name and I'll remember it."),
                    "type": "answer", "tasks": [], "departures": []}
    if not destination:
        logger.warning("trip: no place for the destination (task known=%s)", bool(task_id))
        return None
    try:
        result = await place_ranker.trip_via(
            profile=profile, here=here, recall=recall, via=lookup.get("via") or [],
            destination=destination, arrive_by=arrive_by,
            stop_minutes=lookup.get("stop_minutes"), modes=lookup.get("modes") or None,
            origin=lookup.get("origin") or "auto")
    except Exception as exc:  # noqa: BLE001 \u2014 the agent answers instead
        logger.warning("trip lookup failed: %s", exc)
        return None
    if not result.get("ok"):
        logger.warning("trip could not answer: %s", result.get("reason"))
        return None
    text = place_ranker.say_trip(result, he)
    logger.warning("trip answer: %d legs, late=%s", len(result.get("legs") or []), result.get("late"))
    if generic:
        # "That's not my gym — it's at X": the next address she sends corrects it.
        try:
            session.set_pending_place(phone, {"lookup": lookup, "what": generic, "asked": False})
        except Exception as exc:  # noqa: BLE001
            logger.warning("trip: pending place not kept: %s", exc)
    # No "answer" card: the card draws ONE route leaving now, which is exactly
    # the wrong picture for a trip with a stop and an hour (27.10 screenshot).
    return {"text": text, "type": "answer", "tasks": [], "departures": []}


_MARKS_RE = _re.compile(r"[‎‏\s]+")


def quoted_meira(history: list, quote: str) -> bool:
    """Is `quote` (sent by the app as reply_to) one of Meira's stored replies?
    Compared without direction marks and whitespace; a prefix is enough, since
    the bubble may show a reply whose notes were appended after it."""
    q = _MARKS_RE.sub("", quote or "")[:160]
    if len(q) < 2:
        return False
    for turn in history or []:
        if isinstance(turn, dict) and turn.get("role") == "assistant":
            said = _MARKS_RE.sub("", str(turn.get("content") or ""))
            if q in said or (len(said) >= 2 and said[:160] in q):
                return True
    return False


async def run_turn(
    phone: str,
    content: str,
    user: dict,
    learned: Optional[dict] = None,
    channel: str = "app",
    here: Optional[dict] = None,
    mode: Optional[str] = None,
    profile: Optional[dict] = None,
    reply_to: Optional[str] = None,
) -> dict:
    """A full turn: agent + persistence. Returns {'text', 'tasks', 'departures'}.

    `reply_to`: the Meira message she is answering (the chat's reply-to). It
    reaches the understanding as the turn she answers and the agent as a
    stamp — never mixed into her words, where its dates and hours would be
    read as hers.

    `now` is stamped INSIDE the user turn because that is the only clock the
    model reliably reads — the system prompt's was ignored. `here` rides along
    the same way, so "how do I get there from here" has an origin: without it
    every route the agent planned started at her stored home address, however
    far from it she was standing, and said nothing about the substitution.
    """
    t_start = _time.monotonic()
    profile_key = str(user.get("id") or user.get("whatsapp_phone") or phone)
    person = _quota.set_person(profile_key)
    blocked = _quota.blocked_reply(person, content, str(user.get("language") or ""))
    if blocked:
        return {"text": blocked, "type": "answer", "tasks": [], "departures": [], "quota": "over"}
    # Only HER yes sends a message to someone else. An MCP client is another
    # AI (and may itself be prompt-injected), so its "yes" never confirms a
    # draft — not one it made, not one waiting from WhatsApp (security review 27.10).
    confirmed = confirm_outgoing(profile_key, content) if channel != "mcp" else None
    if confirmed:
        return {"text": confirmed, "type": "answer", "tasks": [], "departures": []}
    if isinstance(profile, dict) and profile:
        # Under the SAME key the agent reads the profile with — the user
        # record's id, not the storage key this turn was called with.
        sync_app_profile(profile_key, profile)
    try:
        about = _understand.about_her(user_profile.get_profile(profile_key), here)
    except Exception as exc:  # noqa: BLE001 — without it the step still reads the words
        logger.warning("profile unreadable for understanding: %s", exc)
        about = ""

    quote = (reply_to or "").strip()[:1200]
    try:
        quote_is_meira = bool(quote) and quoted_meira(
            list(conversation.get_history(str(user.get("id") or user.get("whatsapp_phone") or phone)) or []),
            quote)
    except Exception as exc:  # noqa: BLE001 — unverified: read as her own quote
        logger.warning("reply_to unverifiable: %s", exc)
        quote_is_meira = False

    # WHAT the message is — past question, context, booking, correction — read
    # in code before anything acts on it (frame.py, 29.10).
    try:
        # Read ONCE per turn and reused by the understanding step below (cost review 29.10).
        early_history = list(conversation.get_history(str(user.get("id") or user.get("whatsapp_phone") or phone)) or [])
    except Exception as exc:  # noqa: BLE001
        logger.warning("history unreadable: %s", type(exc).__name__)
        early_history = None
    try:
        fr = _frame.read(content, _tz.today_il(), after_meira=bool(early_history))
    except Exception as exc:  # noqa: BLE001 — no frame: the old road, unchanged
        logger.warning("frame unreadable: %s", type(exc).__name__)
        fr = {}
    try:
        state_lines = intent_turn.state_block(phone, profile_key, _tz.today_il())
    except Exception as exc:  # noqa: BLE001
        logger.warning("state unreadable: %s", type(exc).__name__)
        state_lines = ""
    state = f"[WHAT THIS CONVERSATION ESTABLISHED: {' · '.join(state_lines.splitlines())}] " if state_lines else ""
    if state_lines:
        about = f"{about}\n{state_lines}".strip()

    def _stamp(kind: Optional[str] = None) -> str:
        replying = ""
        if quote:
            replying = (f"[בתשובה להודעה שלך: «{quote[:400]}»] " if quote_is_meira
                        else f"[היא מצטטת (לא אומת כהודעה שלך): «{quote[:400]}»] ")
        return (f"[נשלח עכשיו ב-{_tz.now_il().strftime('%H:%M')}] "
                f"{_here_stamp(here)}{_mode_stamp(mode, kind)}{_frame.stamp(fr)}{state}{replying}{content}")

    stamped = _stamp()
    # Read BEFORE the turn: afterwards the history's last reply is this one.
    # The app's mic is never an answer: she pressed it to add to her day. On
    # 28.9 "שיחה עם דותן משתיים עד שתיים וחצי" followed a reply that ended in
    # "?", so the rescue treated it as an answer, skipped it — nothing saved.
    history_key = str(user.get("id") or user.get("whatsapp_phone") or phone)
    # "My interview moved to Tuesday" — and her answer to "study time? when?" — are
    # code, before any model: the loop got stuck on a mis-heard one (18.10).
    try:
        moved = await reschedule_turn(phone, content, channel, history_key)
    except Exception as exc:  # noqa: BLE001 — never block the turn; the agent can still answer
        logger.warning("reschedule step failed: %s", exc)
        moved = None
    if moved:
        try:
            conversation.append(history_key, content, moved["text"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("reschedule answer not kept in history: %s", exc)
        return moved
    try:
        when = await when_answer(phone, content)
    except Exception as exc:  # noqa: BLE001 — the agent can still answer it
        logger.warning("when-answer step failed: %s", exc)
        when = None
    if when:
        try:
            conversation.append(history_key, content, when)
        except Exception as exc:  # noqa: BLE001
            logger.warning("when answer not kept in history: %s", exc)
        return {"text": when, "type": "answer", "tasks": [], "departures": []}
    try:
        routed = await intent_turn.handle(phone, profile_key, content, user, channel, fr)
    except Exception as exc:  # noqa: BLE001 — the old road answers instead
        logger.warning("intent step failed: %s", type(exc).__name__)
        routed = None
    if routed:
        logger.warning("turn routed: intent=%s time=%s action=%s (%s)", fr.get("intent"), fr.get("time"),
                       fr.get("action"), fr.get("why"))
        try:
            conversation.append(history_key, content, routed["text"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("routed answer not kept in history: %s", type(exc).__name__)
        return routed
    try:
        logged = await past_turn(phone, content, bool(_HEBREW_RE.search(content or ""))
                                 or user.get("language") == "he", tidy=channel != "mcp")
    except Exception as exc:  # noqa: BLE001 — the agent answers instead
        logger.warning("past-log step failed: %s", type(exc).__name__)
        logged = None
    if logged:
        try:
            conversation.append(history_key, content, logged)
        except Exception as exc:  # noqa: BLE001
            logger.warning("past-log answer not kept in history: %s", type(exc).__name__)
        return {"text": logged, "type": "answer", "tasks": [], "departures": []}
    if urgent_question(content):
        he_u = bool(_HEBREW_RE.search(content or "")) or user.get("language") == "he"
        try:
            lines = urgent_lines(await _her_days(phone), _tz.today_il(), he_u)
        except Exception as exc:  # noqa: BLE001 — the agent answers instead
            logger.warning("urgent answer failed: %s", type(exc).__name__)
            lines = None
        if lines is not None:
            text = ("\n".join(["הכי דחוף:" if he_u else "Most urgent:", *lines]) if lines
                    else ("אין משהו דחוף ביומיים הקרובים ✓" if he_u else "Nothing urgent in the next two days ✓"))
            try:
                conversation.append(history_key, content, text)
            except Exception as exc:  # noqa: BLE001
                logger.warning("urgent answer not kept in history: %s", type(exc).__name__)
            return {"text": text, "type": "answer", "tasks": [], "departures": []}
    asked_day = day_question(content)
    if asked_day:
        try:
            text = await day_answer(phone, asked_day, bool(_HEBREW_RE.search(content or ""))
                                    or user.get("language") == "he")
        except Exception as exc:  # noqa: BLE001 — the agent answers instead
            logger.warning("day answer failed: %s", type(exc).__name__)
            text = ""
        if text:
            try:
                conversation.append(history_key, content, text)
            except Exception as exc:  # noqa: BLE001
                logger.warning("day answer not kept in history: %s", exc)
            return {"text": text, "type": "answer", "tasks": [], "departures": []}
    try:
        advised = await advice_turn(phone, content, user, profile_key)
    except Exception as exc:  # noqa: BLE001 — the agent answers instead
        logger.warning("advice step failed: %s", type(exc).__name__)
        advised = None
    if advised:
        try:
            conversation.append(history_key, content, advised["text"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("advice answer not kept in history: %s", exc)
        return advised
    try:
        # Never on MCP: another AI (maybe prompt-injected) deletes nothing by
        # words alone — its update_task cannot cancel either (security review 29.10).
        dropped = None if channel == "mcp" else await delete_turn(phone, content, bool(_HEBREW_RE.search(content or ""))
                                    or user.get("language") == "he")
    except Exception as exc:  # noqa: BLE001 — the agent answers instead
        logger.warning("delete step failed: %s", type(exc).__name__)
        dropped = None
    if dropped:
        try:
            conversation.append(history_key, content, dropped)
        except Exception as exc:  # noqa: BLE001
            logger.warning("delete answer not kept in history: %s", type(exc).__name__)
        return {"text": dropped, "type": "answer", "tasks": [], "departures": []}
    try:
        # "When I get to work, remind me to call Danny" — a place, not an hour (28.10).
        # Read in code; the phone keeps and watches it, the server never learns arrivals.
        # Only the app can keep and watch a place — on WhatsApp / MCP "I'll remind you ✓" would be a promise nobody keeps.
        placed = (await place_reminder.turn(phone, content, user_profile.get_profile(phone) or {})
                  if channel == "app" else None)
    except Exception as exc:  # noqa: BLE001 — the turn carries on as usual
        logger.warning("place-reminder step failed: %s", type(exc).__name__)
        placed = None
    if placed:
        try:
            conversation.append(history_key, content, placed["text"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("place reminder not kept in history: %s", exc)
        return placed
    try:
        fitted = await fit_answer(phone, content)
    except Exception as exc:  # noqa: BLE001 — the turn carries on as usual
        logger.warning("fit-answer step failed: %s", type(exc).__name__)
        fitted = None
    if fitted:
        try:
            conversation.append(history_key, content, fitted["text"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("fit answer not kept in history: %s", exc)
        return fitted
    try:
        place = await place_answer(phone, content, user, profile_key, here)
    except Exception as exc:  # noqa: BLE001 — the turn carries on as usual
        logger.warning("place-answer step failed: %s", type(exc).__name__)
        place = None
    if place:
        try:
            conversation.append(history_key, content, place["text"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("place answer not kept in history: %s", exc)
        return place
    answering = mode != "voice_plan" and meira_just_asked(history_key)
    try:
        history = early_history if early_history is not None else list(conversation.get_history(history_key) or [])
    except Exception as exc:  # noqa: BLE001 — no history: the message alone is read
        logger.warning("history unreadable for understanding: %s", exc)
        history = []
    if quote and quoted_meira(history, quote):
        # The message she is answering is the turn right before hers, even when
        # it was ten messages ago. Only a quote that IS one of Meira's stored
        # replies gets Meira's voice — the app sends it, so it is not trusted.
        history.append({"role": "assistant",
                        "content": f"[She is replying to THIS message of Meira's] {quote}"})
    elif quote:
        logger.warning("reply_to matches no stored Meira reply; read as her quote")
    # THE MIC: UNDERSTAND, THEN ACT, THEN TALK. The agent loop was deciding
    # what to save AND writing the reply in one go, and on 28.9 it wrote a
    # lovely schedule and saved nothing. On the app's mic a model now reads
    # the conversation and names the actions, code carries them out, and the
    # agent is told what was done — so its reply can only confirm reality.
    first: list = []
    first_note, understood_first = "", False
    seen: dict = {}
    early: Optional[dict] = None
    t_understand = _time.monotonic()
    # Typed in the app's chat and not a question: the SAME road as the mic —
    # understand, act, and the agent only for what is left. Typed text used to
    # go to the agent first, and the two roads disagreed (20.10: the mic saved
    # the call, the typed line got "Alarm set" in English and an alarm-task).
    understand_first = mode == "voice_plan" or (channel == "app" and not mode
                                                and not may_be_a_question(content))
    if understand_first:
        first, first_note, understood_first = await act_on_understanding(
            phone, content, channel, history, about=about, seen=seen, fr=fr, profile_key=profile_key)
    elif may_be_a_question(content):
        # Typed in the chat and shaped like a question: understand it FIRST, so
        # "how do I get home?" is answered in seconds, not after the full agent
        # loop (58 s on 7.10). Anything else carries on to the agent as before,
        # and this understanding is reused afterwards rather than asked twice.
        early = await _understand.understand(content, history, await _her_days(phone), about=about)
        if early:
            seen["kind"] = early.get("kind") or "do"
            seen["lookup"] = early.get("lookup")
    t_understand = _time.monotonic() - t_understand

    # THE FAST PATH: a place or route question the understanding could name.
    # Code runs the lookup and writes the sentence; no agent loop. If the
    # lookup cannot answer (no origin, nothing found, Google refused), the
    # agent answers it its own way below — it can ask and explain.
    # A message that does not even look like a question is never answered by a
    # place search, whatever the model called it ("תוסיפי אימון מחר ב-7").
    if (seen.get("kind") == "question" and seen.get("lookup") and not first
            and not asks_return_later(content)
            and not asks_if_it_fits(content)
            and (mode == "voice_plan" or may_be_a_question(content)
                 or (seen.get("lookup") or {}).get("what") == "vehicle")):
        answered = await answer_lookup(seen["lookup"], content, user, profile_key, phone, here)
        if answered:
            try:
                conversation.append(history_key, content, answered["text"])
            except Exception as exc:  # noqa: BLE001 — the answer still goes out
                logger.warning("fast answer not kept in history: %s", exc)
            return answered

    if asks_if_it_fits(content) and seen.get("lookup") and not first:
        try:
            fitted = await fit_after_answer(seen["lookup"], content, user, profile_key, phone)
        except Exception as exc:  # noqa: BLE001 — the agent answers instead
            logger.warning("fit-after answer failed: %s", type(exc).__name__)
            fitted = None
        if fitted:
            try:
                conversation.append(history_key, content, fitted["text"])
            except Exception as exc:  # noqa: BLE001
                logger.warning("fit answer not kept in history: %s", type(exc).__name__)
            return fitted

    if understand_first:
        if understood_first and seen.get("kind") == "question":
            stamped = _stamp("question")
            if first:
                done = "; ".join(str(t.get("text")) for t in first)
                stamped = (f"[ALREADY DONE BY THE APP, do NOT save these again: {done}.] "
                           f"{stamped}")
        elif understood_first:
            done = "; ".join(f"{t.get('text')} {t.get('date') or ''} {t.get('fixed_time') or ''}".strip()
                             for t in first) or "nothing — she asked for nothing to be saved"
            asked = next((l for l in first_note.splitlines() if l.rstrip().endswith("?")), "")
            stamped = (f"[ALREADY DONE BY THE APP, do NOT save these again: {done}. "
                       + (f"The app is asking her: '{asked}' — do NOT guess the answer or save "
                          f"the unclear item; wait for her reply. " if asked else "")
                       + f"Confirm in one short sentence; only act on anything else she asked.] "
                       f"{stamped}")
    t_agent = _time.monotonic()
    if understand_first and understood_first and understanding_covers(content, seen.get("kind"), first):
        # The note already says what was saved, in her language. Kept in the
        # history so the next message reads it as Meira's last reply.
        response = {"type": "chat", "text": ""}
        profile_changes = []
        saved = list(first)
        try:
            conversation.append(history_key, content, first_note)
        except Exception as exc:  # noqa: BLE001 — the reply still goes out
            logger.warning("voice turn not kept in history: %s", exc)
    else:
        before = _profile_snapshot(history_key)
        response = await handle_whatsapp_message(stamped, user, learned, here=here,
                                                 tier=model_router.tier_for_frame(fr))
        if only_promises(response.get("text")):
            # 27.10 live: "I'll fetch the forecast — give me a sec…" and the turn
            # ended. A promise is not an answer: once more, told so.
            logger.warning("agent replied with a promise only; asking once more")
            again = await handle_whatsapp_message(
                "[You only PROMISED to check. Do it NOW with your tools (web_search, route_now, "
                "get_my_tasks…) and give the answer, or say in one line that you can't and why.] "
                + stamped, user, learned, here=here)
            if again.get("text") and not only_promises(again.get("text")):
                response = again
        profile_changes = _profile_changes(before, _profile_snapshot(history_key))
        if not _frame.may_schedule(fr) and (response.get("tasks") or response.get("task")):
            logger.warning("agent tasks dropped — message read as %s/%s", fr.get("intent"), fr.get("time"))
            response = {**response, "tasks": [], "task": None}
        saved = first + [t for t in await persist_agent_tasks(phone, content, response, channel)
                         if str(t.get("id")) not in {str(f.get("id")) for f in first}]
    t_agent = _time.monotonic() - t_agent

    # LAST LINE OF DEFENCE. If the turn saved nothing and updated nothing, but
    # the message plainly asks for something, save it from the user's own words.
    # Guarding the model's PROSE was a losing game — block "עודכן" and it writes
    # "ממתינה" — because the argument was about wording while the user's problem
    # was that the task did not exist. See task_rescue.
    note = first_note
    if not saved and not understood_first and not (response.get("updates") or []):
        # The agent talked and did nothing. Understand the conversation first
        # (a model reads it and names the actions); only if that cannot run do
        # the regexes save her words as they stand. See understand.py.
        saved, note, understood = await act_on_understanding(
            phone, content, channel, history, about=about, seen=seen, result=early,
            fr=fr, profile_key=profile_key)
        if not understood:
            saved, note = await rescue_turn(phone, content, channel, answering=answering)
    if not saved and not (response.get("updates") or []):
        # "כן ביום שלישי" right after Meira saved something: a new day for THAT
        # task. Live, 20.10 00:51: read as chat, nothing moved, "nothing saved".
        moved, moved_note = await date_correction(phone, content, history)
        if moved:
            saved, note = moved, moved_note

    text = response.get("text", "")
    if saved:
        # The code saved it after the agent had not — so the agent's guard line
        # ("⚠️ I didn't save anything just now") is no longer true. Live, 20.10:
        # the reply said "didn't save anything" and "saved: …" together.
        text = without_guard_notes(text)
        response = {**response, "text": text}

    he_turn = bool(_re.search(r"[\u0590-\u05FF]", content or ""))
    # Does it fit the day, travel between meetings included (28.10)? When not:
    # warn, and ask — keep it, or the nearest hour that fits. Covers the plain
    # overlap too, so clash_note speaks only when this one had nothing to say.
    fit_replies: list = []
    try:
        fit_text, fit_replies = await fit_note(phone, saved, he=he_turn)
    except Exception as exc:  # noqa: BLE001 — said; the overlap check below still runs
        logger.warning("fit check failed: %s", type(exc).__name__)
        fit_text = ""
        fit_failed = ("(לא הצלחתי לבדוק נסיעה בין הפגישות.)" if he_turn
                      else "(I couldn't check travel between your meetings.)")
    else:
        fit_failed = ""
    clash = fit_text if fit_replies else "\n".join(
        x for x in (fit_text, fit_failed, await clash_note(phone, saved, he=he_turn)) if x)
    if clash:
        note = f"{note}\n{clash}".strip()

    text = in_her_language(response.get("text", ""), bool(_HEBREW_RE.search(content or "")))
    text = goal_reply(text, fr, saved)
    if note:
        text = join_reply(text, note)
    out = {
        "text": text,
        # "answer": she asked and Meira answered — nothing to plan, nothing to
        # close on a timer. The app shows it as an answer, not a schedule.
        "type": "answer" if seen.get("kind") == "question" and not saved else response.get("type"),
        "tasks": saved,
        "departures": response.get("departures") or [],
    }
    if fit_replies:
        out["replies"] = fit_replies   # buttons under the reply (CoachChatScreen)
    if response.get("lookup"):
        out["answer"] = response["lookup"]   # drawn as a card (AnswerCard)
    # How she got here: what the understanding step read the message as, then
    # the agent's tools and reasoning. Logged every turn, returned to the app.
    out["why"] = "; ".join(x for x in (
        f"understood as {seen.get('kind') or '—'}" + (f", saved {len(saved)}" if saved else ""),
        response.get("why") or "") if x)
    logger.warning("turn why: %s", out["why"][:500])
    if profile_changes:
        out["profile_changes"] = profile_changes
    # One line per turn, so "it's slow" has numbers (fly logs | grep 'turn timing').
    logger.warning("turn timing: mode=%s kind=%s understand=%.1fs agent=%.1fs%s total=%.1fs",
                   mode or channel, seen.get("kind"), t_understand, t_agent,
                   " (skipped)" if response.get("text") == "" and saved else "",
                   _time.monotonic() - t_start)
    return out


# ── "My interview moved to Tuesday" (18.10) ───────────────────────────────────

_HEBREW_RE = _re.compile(r"[\u0590-\u05FF]")
_CALENDAR_ID_RE = _re.compile(r"^(gcal|dcal|ocal)-")


async def reschedule_turn(phone: str, content: str, channel: str, history_key: str) -> Optional[dict]:
    """A move, or the answer to the question a move asked — or None (carry on as usual).

    Code, not a model's mood: the mic heard "העיון … נתחל" and the agent loop got
    stuck. See reschedule.py. The change is made for real, read back from what was
    saved, and the reply says only what happened (silent-state rule 3)."""
    import reschedule as _rs
    he = bool(_HEBREW_RE.search(content or ""))
    today = _tz.today_il()

    offer = session.get_pending_offer(phone)
    # A short message right after the question is its answer; a long one is a new request.
    if offer and len((content or "").split()) <= 6:
        answered = await _answer_offer(phone, content, channel, offer, he, today)
        if answered:
            return answered

    tasks = await _her_days(phone)
    move = _rs.find_move(content, tasks, today)
    if not move:
        return None
    task = move["task"]
    patch = {"date": move["new_date"], "moved_from_date": move["old_date"]}
    if move.get("new_time"):
        patch["fixed_time"] = move["new_time"]
    try:
        user_memory.update_task(phone, task["id"], patch)
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid and not await supabase_tasks.update_task(uid, str(task["id"]), patch):
            raise RuntimeError("the cloud copy was not updated")
    except Exception as exc:  # noqa: BLE001 — say it failed; never claim a move that did not land
        logger.warning("reschedule: update failed: %s", exc)
        text = ("לא הצלחתי להזיז את זה עכשיו 🙈 נסי שוב עוד רגע." if he
                else "I couldn't move it just now 🙈 Try again in a moment.")
        return {"text": text, "type": "answer", "tasks": [], "departures": []}

    updated = {**task, **patch}
    clash = ""
    try:
        clash_text = await clash_note(phone, [updated], he=he)
        clash = clash_text.strip().splitlines()[0] if clash_text else ""
    except Exception as exc:  # noqa: BLE001 — the move stands; the clash line is a bonus
        logger.warning("reschedule: clash check failed: %s", exc)
    owned = bool(_CALENDAR_ID_RE.match(str(task.get("id") or "")) or task.get("calendarEventId"))
    proposal = None
    if _rs._is_prep_kind(task):
        try:
            proposal = _rs.propose_study(move, tasks, today, _tz.now_il().strftime("%H:%M"))
        except Exception as exc:  # noqa: BLE001 — no proposal: the reply asks for the hour instead
            logger.warning("reschedule: no free hour computed: %s", exc)
    text, offered = _rs.reply(move, today, he, clash_with=clash or None, calendar_owned=owned,
                              proposal=proposal)
    if offered:
        loc = task.get("location") if isinstance(task.get("location"), dict) else {}
        session.set_pending_offer(phone, {
            "kind": "study", "stage": "study", "task_id": str(task["id"]), "date": move["new_date"],
            "title": _rs._short_title(task, he), "he": he,
            "event_time": move.get("new_time") or str(task.get("fixed_time") or task.get("fixedTime") or "")[:5],
            "travel": int(loc.get("travelMinutes") or task.get("travel_minutes") or 45),
            "study_date": (proposal or {}).get("date"), "proposed_time": (proposal or {}).get("time"),
            "minutes": (proposal or {}).get("minutes") or 120,
            "windows": (proposal or {}).get("windows") or []})
    return {"text": text, "type": "answer", "tasks": [], "departures": [], "moved": [
        {"id": str(task["id"]), "date": move["new_date"], "time": move.get("new_time")}]}


def _ans(text: str, tasks: Optional[list] = None, **extra) -> dict:
    return {"text": text, "type": "answer", "tasks": tasks or [], "departures": [], **extra}


async def _answer_offer(phone: str, content: str, channel: str, offer: dict, he: bool, today) -> Optional[dict]:
    """Her short reply to Meira's one question — in the words she has (reschedule.parse_answer).
    None when it is not an answer (it is then read as an ordinary message)."""
    import reschedule as _rs
    stage = offer.get("stage") or "study"
    ans = _rs.parse_answer(content, prefer="morning" if stage == "morning" else "evening")
    kind = ans["answer"]
    if kind is None:
        return None
    if kind == "no":
        session.clear_pending_offer(phone)
        return _ans("בסדר 🙂 אני כאן אם תרצי." if he else "OK 🙂 I'm here if you want it.")
    if kind == "later":
        # Kept, not dropped: "later" is not "no". Re-stamped so it lives another while.
        session.set_pending_offer(phone, {k: v for k, v in offer.items() if k != "at"})
        return _ans("בסדר, ההצעה נשארת — תגידי כן כשתרצי 🙂" if he
                    else "OK, the offer stays — say yes when you want it 🙂")
    options = list(offer.get("options") or [])
    minutes = int(offer.get("minutes") or (60 if stage == "morning" else 120))
    if kind == "other":
        shown = options if stage == "morning" else _rs.free_starts(offer.get("windows") or [], minutes)
        if shown:
            return _ans(("פנוי ב-" if he else "Free at ") + ", ".join(shown) + ("? איזו שעה?" if he else "? Which one?"))
        return _ans("באיזו שעה?" if he else "At what time?")
    hhmm = None
    if kind == "time":
        hhmm = ans["time"]
    elif kind == "yes":
        hhmm = (options[0] if options else None) if stage == "morning" else offer.get("proposed_time")
    elif kind == "daypart":
        if stage == "morning":
            hhmm = options[0] if options and ans.get("part") == "morning" else None
        else:
            hhmm = _rs.pick_in_part(offer.get("windows") or [], ans.get("part") or "", minutes)
    if not hhmm:
        return _ans("באיזו שעה?" if he else "At what time?")
    if stage == "morning":
        return await _book_morning(phone, offer, hhmm, he, today)
    return await _book_study(phone, content, channel, offer, hhmm, he, today)


def _remind_all(phone: str, level, hhmm: str, label: str, day: str, he: bool) -> bool:
    """Set the reminders for the level she chose; True only when the one AT the hour was set —
    the reply may say 🔔 only then (no promise without a saved reminder)."""
    import reminders as _reminders
    import reschedule as _rs
    main = False
    for at, text in _rs.nudges_for(level, hhmm, label, he):
        try:
            ok = bool(_reminders.schedule(phone, at, text, day=day))
        except Exception as exc:  # noqa: BLE001 — a missing nudge is not a failed booking
            logger.warning("reschedule: reminder %s not set: %s", at, exc)
            ok = False
        if at == hhmm:
            main = ok
    return main


def _nudge_level(phone: str) -> str:
    import reschedule as _rs
    try:
        return _rs.normalize_level(user_profile.get_profile(phone).get("nudgeLevel"))
    except Exception as exc:  # noqa: BLE001 — gentle is the default
        logger.warning("reschedule: nudge level unreadable: %s", exc)
        return "gentle"


async def _book_study(phone: str, content: str, channel: str, offer: dict, hhmm: str,
                      he: bool, today) -> dict:
    """Her answer is an hour: put study time in her diary and set the reminders she wants."""
    import reschedule as _rs
    now_hhmm = _tz.now_il().strftime("%H:%M")
    day = offer.get("study_date") or _rs.study_slot(str(offer.get("date")), today, hhmm, now_hhmm)
    if not day or (day == today.isoformat() and hhmm <= now_hhmm):
        session.clear_pending_offer(phone)
        text = ("אין יום פנוי לפני הראיון — הוא כבר קרוב מדי 🙈" if he
                else "There's no day left before it — it's too close 🙈")
        return _ans(text)
    title = str(offer.get("title") or "")
    label = f"לימוד לקראת {title}" if he else f"Study for {title}"
    task = {"text": label, "category": "course", "priority": "have_to",
            "duration_minutes": int(offer.get("minutes") or 120), "fixed_time": hhmm, "date": day}
    saved = await persist_agent_tasks(phone, content, {"tasks": [task]}, channel)
    if not saved:
        # The offer stays: she can say the hour again.
        text = ("לא הצלחתי לשמור את זמן הלימוד 🙈 נסי שוב." if he else
                "I couldn't save the study time 🙈 Try again.")
        return _ans(text)
    reminded = _remind_all(phone, _nudge_level(phone), hhmm, label, day, he)
    when = _rs.day_label(day, he)
    if he:
        text = f"הוספתי ליומן {label} ב{when}, {hhmm} ✓" + (" 🔔" if reminded else "")
    else:
        text = f"Added to your diary: {label}, {when} {hhmm} ✓" + (" 🔔" if reminded else "")
    try:
        clash_text = await clash_note(phone, saved, he=he)
        if clash_text:
            text += " " + clash_text.strip().splitlines()[0]
    except Exception as exc:  # noqa: BLE001 — the booking stands; the clash line is a bonus
        logger.warning("reschedule: clash check after booking failed: %s", exc)
    # The SECOND improvement, one question at a time: the morning of the event. Hours, not one hour.
    opts = _rs.morning_options(str(offer.get("event_time") or ""), int(offer.get("travel") or 45))
    if opts and str(offer.get("date")) > today.isoformat():
        session.set_pending_offer(phone, {**{k: v for k, v in offer.items() if k != "at"},
                                          "stage": "morning", "options": opts, "minutes": 60})
        text += (" ובבוקר של הראיון, באיזו שעה להעיר אותך ללמוד? " + " / ".join(opts) + "?" if he else
                 " On the morning of it, what time shall I wake you to study? " + " / ".join(opts) + "?")
    else:
        session.clear_pending_offer(phone)
    return _ans(text, saved)


async def _book_morning(phone: str, offer: dict, hhmm: str, he: bool, today) -> dict:
    """A wake-up reminder on the day of the event. No diary entry: the phone already mints its
    own morning prep block for an interview, and a second one would be a twin (rule 8)."""
    import reschedule as _rs
    day = str(offer.get("date"))
    label = "ללמוד לפני " + str(offer.get("title") or "הראיון") if he else \
        "Study before " + str(offer.get("title") or "the interview")
    reminded = _remind_all(phone, _nudge_level(phone), hhmm, label, day, he)
    session.clear_pending_offer(phone)
    if not reminded:
        return _ans("לא הצלחתי לקבוע את התזכורת 🙈 נסי שוב." if he else "I couldn't set that reminder 🙈 Try again.")
    when = _rs.day_label(day, he)
    return _ans(f"אעיר אותך ב-{hhmm} ב{when} 🔔" if he else f"I'll wake you at {hhmm} on {when} 🔔")


# ── What the turn learned about her, said back (6.10) ─────────────────────────
# "Where is the chat where I tell Meira my routines?" — it is this one, and a
# fact it saved used to be invisible: the reply carried text, tasks and
# departures, never "I'll remember kickboxing on Tuesdays". The app shows each
# change as a card with Undo, and redraws her routines (silent-state rule 5).

_PROFILE_FIELDS = ("name", "homeAddress", "transportType", "hobbies", "morningRoutineMinutes")


def _profile_snapshot(key: str) -> dict:
    try:
        prof = user_profile.get_profile(key)
    except Exception as exc:  # noqa: BLE001 — no snapshot, no cards; the turn goes on
        logger.warning("profile snapshot skipped: %s", exc)
        return {}
    snap = {f: prof.get(f) for f in _PROFILE_FIELDS}
    snap["routines"] = user_profile.routine_lines(prof.get("routinesNotes"))
    return snap


def _profile_changes(before: dict, after: dict) -> list:
    """[{kind: routine_added | routine_removed | field, …}] between two snapshots."""
    if not before or not after:
        return []
    changes = [{"kind": "routine_added", "text": line}
               for line in after["routines"] if line not in before["routines"]]
    changes += [{"kind": "routine_removed", "text": line}
                for line in before["routines"] if line not in after["routines"]]
    for f in _PROFILE_FIELDS:
        if after.get(f) != before.get(f) and after.get(f) not in (None, ""):
            changes.append({"kind": "field", "field": f, "before": before.get(f), "after": after.get(f)})
    return changes


_DONE = {"complete", "completed", "cancelled", "deleted", "archived", "moved", "missed"}


def _short_date(iso: str) -> str:
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
        return f"{d}.{m}"
    except ValueError:
        return iso


def _road_travel(transport: str) -> "fit_check.Travel":
    """Google minutes between two addresses, None when it could not be measured (never 0 for "unknown")."""
    import config
    import geo

    async def go(a: str, b: str, arrive_by: str):
        if not config.GOOGLE_MAPS_API_KEY:
            return None
        pa, pb = await geo.geocode(a), await geo.geocode(b)
        if not pa or not pb:
            return None
        route = await geo.directions(pa, pb, transport, arrive_by)
        return route["minutes"] if route else None
    return fit_check.cached(go)


async def fit_note(phone: str, saved: list, he: bool = True) -> tuple[str, list]:
    """(warning + question, reply buttons) for the first just-saved task with an hour
    that does not fit its day, travel included; ("", []) when everything fits.

    Koral, 28.10: warn that it is not possible, then ask — keep it anyway, or a
    new time (the nearest hour that does fit, checked by the same rule)."""
    timed = [t for t in saved or [] if clashes.start_of(t) and t.get("date") and t.get("id")]
    if not timed:
        return "", []
    import task_store
    prof = user_profile.get_profile(phone) or {}
    travel = _road_travel(prof.get("transportType") or "car")
    today = _tz.today_il().isoformat()
    for task in timed[:3]:
        date_iso = str(task["date"])[:10]
        if date_iso < today:
            continue
        try:
            rows = await task_store.fetch_task_rows(phone, date_iso, date_iso, include_location=True)
        except Exception as exc:  # noqa: BLE001 — said, then clash_note still runs
            logger.warning("fit check: day unreadable: %s", type(exc).__name__)
            return ("לא הצלחתי לבדוק אם זה נכנס ביום (נסיעה בין פגישות)." if he
                    else "I couldn't check whether it fits the day (travel between meetings)."), []
        rows = [r for r in rows if not task_rescue.already_planned([r], task) or str(r.get("id")) == str(task.get("id"))]
        start = clashes.start_of(task)
        verdict = await fit_check.judge(task, start, rows, travel)
        if verdict["fits"]:
            if verdict.get("unchecked"):
                # A trip that could not be measured is not a yes — say so (rule 1).
                return ((f"לא הצלחתי למדוד את הנסיעה ל'{task.get('text')}' — כדאי לבדוק שיש מספיק זמן." if he
                         else f"I couldn't measure the trip to '{task.get('text')}' — check there's enough time."), [])
            continue
        now = _tz.now_il().strftime("%H:%M") if date_iso == today else None
        alt = await fit_check.find_alternative(
            task, start, rows, travel,
            day_start=prof.get("defaultWakeTime") or "08:00", day_end=prof.get("sleepTime") or "22:00",
            not_before=now)
        session.set_pending_fit(phone, {"task_id": str(task["id"]), "text": task.get("text"),
                                        "date": date_iso, "start": start, "alt": alt})
        logger.warning("fit check: saved task does not fit (%s)", verdict["kind"])
        return fit_check.question(task, verdict, alt, he), fit_check.replies(alt, he)
    return "", []


async def fit_answer(phone: str, content: str) -> Optional[dict]:
    """Her answer to "doesn't fit — keep it, or the new time?". None when no question waits or this is not an answer."""
    try:
        pending = session.get_pending_fit(phone)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pending fit unreadable: %s", exc)
        return None
    if not pending:
        return None
    choice = fit_check.reading(content, pending)
    if not choice:
        return None
    he = bool(_re.search(r"[\u0590-\u05FF]", content or ""))
    name, start, alt = pending.get("text"), pending.get("start"), pending.get("alt")
    if choice == "keep":
        session.clear_pending_fit(phone)
        text = (f"השארתי את '{name}' ב-{start} ✓" if he else f"Kept '{name}' at {start} ✓")
        return {"text": text, "type": "answer", "tasks": [], "departures": []}
    patch = {"fixed_time": alt}
    try:
        local = user_memory.update_task(phone, pending["task_id"], patch)
        uid = await supabase_tasks.user_id_for_phone(phone)
        cloud = bool(uid) and bool(await supabase_tasks.update_task(uid, str(pending["task_id"]), patch))
        if uid and not cloud:
            raise RuntimeError("the task is not in the cloud (deleted on the phone?)")
        if not local and not cloud:
            # "Moved ✓" with nothing written is the fake confirmation (rule 3).
            raise RuntimeError("the task was found nowhere")
        session.clear_pending_fit(phone)   # only now: a failed move stays answerable
    except Exception as exc:  # noqa: BLE001 — say it failed, never claim it
        logger.warning("fit move failed: %s", exc)
        return {"text": "לא הצלחתי להזיז — נסי שוב" if he else "Couldn't move it — try again",
                "type": "answer", "tasks": [], "departures": []}
    moved = {"id": pending["task_id"], "text": name, "date": pending.get("date"), "fixed_time": alt}
    # "moved": the phone's merge skips ids it already has, so the new hour is applied by id.
    return {"text": (f"הזזתי את '{name}' ל-{alt} ✓" if he else f"Moved '{name}' to {alt} ✓"),
            "type": "answer", "tasks": [moved], "departures": [],
            "moved": [{"id": pending["task_id"], "fixed_time": alt}]}


async def clash_note(phone: str, saved: list, he: bool = True) -> str:
    """What the tasks just saved collide with, said out loud. "" when nothing.

    Koral, 28.9: reserve duty 08:00–16:00 on 8.10 went in on a day that already
    held two interviews, and nothing said a word — the collision was hers to
    find on the timeline, if she ever opened that day. A clash is the one thing
    Meira must say the moment it exists: the interview has to be moved while
    there is still time to ask for another date.

    Reads the day from Supabase (the calendar imports live there) and from the
    server's own memory, so it sees both doors."""
    timed = [t for t in saved or [] if clashes.start_of(t) and t.get("date")]
    if not timed:
        return ""
    uid = None
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
    except Exception as exc:  # noqa: BLE001 — no uid: memory alone still checks
        logger.warning("clash check: no uid (%s)", exc)
    lines: list = []
    for date_iso in sorted({str(t["date"])[:10] for t in timed}):
        day: dict = {}
        try:
            if uid:
                for t in await supabase_tasks.tasks_for_user(uid, date_iso, date_iso):
                    day[str(t.get("id"))] = t
        except Exception as exc:  # noqa: BLE001
            logger.warning("clash check: day unreadable from Supabase: %s", exc)
        try:
            for t in user_memory.tasks_for_phone(phone):
                if str(t.get("date", ""))[:10] == date_iso:
                    day.setdefault(str(t.get("id")), t)
        except Exception as exc:  # noqa: BLE001
            logger.warning("clash check: memory unreadable: %s", exc)
        mine = [t for t in timed if str(t["date"])[:10] == date_iso]
        mine_ids = {str(t.get("id")) for t in mine}
        others = [t for tid, t in day.items()
                  if tid not in mine_ids and clashes.start_of(t)
                  and str(t.get("status") or "pending") not in _DONE]
        for new in mine:
            for other in others:
                if task_rescue.already_planned([other], new):
                    continue          # the same thing, stored twice — not a clash
                if clashes.overlap_minutes(new, other) <= 0:
                    continue
                when = _short_date(date_iso)
                a = f"{clashes.start_of(new)}–{clashes.end_of(new)}"
                b = clashes.start_of(other)
                lines.append(
                    f"⚠️ ב-{when} '{new.get('text')}' ({a}) מתנגש עם '{other.get('text')}' ב-{b}. "
                    f"צריך להזיז את '{other.get('text')}' — לבקש מועד אחר?"
                    if he else
                    f"⚠️ On {when} '{new.get('text')}' ({a}) clashes with '{other.get('text')}' at {b}. "
                    f"'{other.get('text')}' needs a new time — ask for another date?")
    if lines:
        logger.warning("clash after save: %d line(s)", len(lines))
    return "\n".join(lines[:3])


async def _her_days(phone: str, days: int = 14) -> list:
    """Her open tasks from today on (Supabase — calendar imports live there —
    plus the server's memory), for the understanding step to update against."""
    today = _tz.today_il()
    until = (today + _timedelta(days=days)).isoformat()
    found: dict = {}
    cloud_read = False
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            for t in await supabase_tasks.tasks_for_user(uid, today.isoformat(), until):
                found[str(t.get("id"))] = t
            cloud_read = True
    except Exception as exc:  # noqa: BLE001
        logger.warning("understanding: her day unreadable from Supabase: %s", exc)
    try:
        for t in user_memory.tasks_for_phone(phone):
            d = str(t.get("date") or "")[:10]
            if cloud_read and d and today.isoformat() <= d <= until and str(t.get("id")) not in found:
                # Linked and read: a task only the server's memory still holds
                # was deleted on the phone — never offered again (live, 20.10).
                continue
            if not d or today.isoformat() <= d <= until:
                found.setdefault(str(t.get("id")), t)
    except Exception as exc:  # noqa: BLE001
        logger.warning("understanding: memory unreadable: %s", exc)
    return [t for t in found.values() if str(t.get("status") or "pending") not in _DONE]


def _said_saved(task: dict, he: bool) -> str:
    when = " ".join(x for x in (_short_date(str(task["date"])) if task.get("date") else "",
                                str(task.get("fixed_time") or "")) if x)
    if not when:
        return f"שמרתי במשימות הכלליות: {task.get('text')} ✓" if he \
            else f"Saved to your general tasks: {task.get('text')} ✓"
    alarm = f" · ⏰ {task['alarmAt']}" if task.get("alarmAt") else ""
    return (f"קבעתי: {task.get('text')} · {when} ✓{alarm}" if he
            else f"Done — {task.get('text')} · {when} ✓{alarm}")


def _day_word(iso: str, he: bool) -> str:
    """'יום שלישי 28.10' / 'Tue 28.10' — the day she will look for."""
    try:
        d = _date.fromisoformat(str(iso)[:10])
    except ValueError:
        return str(iso)
    if d == _tz.today_il():
        return f"היום {_short_date(iso)}" if he else f"today {_short_date(iso)}"
    if d == _tz.today_il() + _timedelta(days=1):
        return f"מחר {_short_date(iso)}" if he else f"tomorrow {_short_date(iso)}"
    name = _tz.weekday_label(d).split(" / ")
    return f"{name[1]} {_short_date(iso)}" if he else f"{name[0][:3]} {_short_date(iso)}"


def said_saved_lines(saved: list, he: bool, placed: Optional[set] = None) -> list:
    """What was saved, grouped by day, every line with its hour — 27.10: "it
    said it saved, but on what time?". An hour Meira CHOSE is marked as hers,
    with how to change it; a task with no day says so and offers one."""
    placed = placed or set()
    lines: list = []
    by_day: dict = {}
    loose: list = []
    for i, t in enumerate(saved):
        (by_day.setdefault(str(t["date"])[:10], []) if t.get("date") else loose).append((i, t))
    days = sorted(by_day)
    if len(days) > 3 and all(len(by_day[d]) == 1 for d in days) \
            and len({by_day[d][0][1].get("text") for d in days}) == 1:
        # Seven days off: one line, first and last day, not seven.
        title = by_day[days[0]][0][1].get("text")
        lines.append(f"קבעתי: {title} · {_day_word(days[0], he)} – {_day_word(days[-1], he)} ✓" if he
                     else f"Done — {title} · {_day_word(days[0], he)} – {_day_word(days[-1], he)} ✓")
        days = []
    for d in days:
        items = by_day[d]
        if len(items) == 1:
            i, t = items[0]
            hour = f" {t['fixed_time']}" if t.get("fixed_time") else ""
            lines.append(f"קבעתי: {t.get('text')} · {_day_word(d, he)}{hour} ✓" if he
                         else f"Done — {t.get('text')} · {_day_word(d, he)}{hour} ✓")
            continue
        lines.append(f"שמרתי ל{_day_word(d, he)}:" if he else f"On {_day_word(d, he)}:")
        for i, t in sorted(items, key=lambda it: str(it[1].get("fixed_time") or "99")):
            lines.append(f"• {t.get('fixed_time') or '—'} {t.get('text')}")
    for _, t in loose:
        lines.append(_said_saved(t, he))
    if any(i in placed for i, _ in enumerate(saved)):
        lines.append("בחרתי שעות פנויות — לשנות? כתבי למשל 'את הראשונה ב-11'" if he
                     else "I picked free slots — to change one, say e.g. 'the first at 11'")
    elif loose:
        lines.append("לאיזה יום ושעה? כתבי למשל 'מחר ב-10'" if he
                     else "Which day and time? Say e.g. 'tomorrow at 10'")
    return lines


_LIST_HEAD_RE = _re.compile(
    r"^\s*(?:tasks?|to-?dos?|things to do|my list|משימות|מטלות|דברים לעשות|לעשות|רשימה)\b[^:]{0,40}:\s*(.+)$",
    _re.IGNORECASE | _re.DOTALL)


def list_items(title: object) -> list:
    """"Tasks for morning: A, B; C" → [A, B, C]. A title that is not a list
    header → [] (the title stands as it is)."""
    m = _LIST_HEAD_RE.match(str(title or ""))
    if not m:
        return []
    parts = [p.strip(" -•*.") for p in _re.split(r"[,;\n]|\s+(?:and|ו)\s+(?=\S)", m.group(1))]
    return [p for p in parts if len(p) >= 2][:12]


_BARE_TITLES = {"פגישה", "משימה", "אירוע", "שיחה", "תזכורת", "תור", "משהו", "meeting", "task",
                "event", "call", "reminder", "appointment", "something", "todo", "to do"}


def is_bare(task: dict) -> bool:
    """A title that is only a kind of thing, with nothing to place it."""
    title = str(task.get("text") or "").strip().strip(".!?").lower()
    return (title in _BARE_TITLES and not task.get("date") and not task.get("fixed_time")
            and not task.get("location"))


_PROMISE_RE = _re.compile(
    r"give me a (?:sec|second|moment|minute)|one (?:sec|moment)|let me (?:check|look|fetch|find)"
    r"|i'?ll (?:fetch|check|look|find|get back)|hold on|bear with me|checking now"
    r"|רגע,? (?:אני )?(?:בודקת|אבדוק|מחפשת)|אבדוק ואחזור|אני בודקת ו|תני לי רגע|שנייה,? (?:אני )?בודקת",
    _re.IGNORECASE)


def only_promises(text: object) -> bool:
    """A reply that says it is about to answer, and does not: short, a promise,
    and no number or hour in it (an answer carries the thing she asked for)."""
    t = str(text or "").strip()
    return bool(t) and len(t) < 400 and bool(_PROMISE_RE.search(t)) and not _re.search(r"\d", t)


_SENTENCE_RE = _re.compile(r"[^.!?？\n]+[.!?？]*")
_EN_WORDS = {"arriving": "מגיעה", "arrive": "מגיעה", "leave": "לצאת", "leaving": "יוצאת"}


def in_her_language(text: str, he: bool) -> str:
    """A Hebrew question gets a Hebrew answer. 27.10 live: "…40 דק׳ כולל הליכה
    והמתנה. arriving ~15:01. Need buffer? Let me know." An English-only
    sentence with no number in it is dropped; a lone English verb before an
    hour is said in Hebrew. Names, lines and addresses inside Hebrew stay."""
    if not he or not text:
        return text
    out = []
    for line in text.split("\n"):
        kept = []
        for sent in _SENTENCE_RE.findall(line):
            if _HEBREW_RE.search(sent) or not _re.search(r"[A-Za-z]{2,}\s+[A-Za-z]{2,}|^[\s]*[A-Za-z]{3,}", sent):
                kept.append(sent)
                continue
            if _re.search(r"\d", sent):
                kept.append(_re.sub(r"\b(" + "|".join(_EN_WORDS) + r")\b",
                                    lambda m: _EN_WORDS[m.group(1).lower()], sent, flags=_re.IGNORECASE))
        out.append("".join(kept).rstrip())
    return "\n".join(out).strip() or text


_KIND_WORDS = (
    _re.compile(r"ר[י]?איון|interview", _re.IGNORECASE),
    _re.compile(r"רופא|רופאה|doctor|dentist|שיניים", _re.IGNORECASE),
    _re.compile(r"אימון|חדר כושר|gym|workout|קיקבוקס|יוגה", _re.IGNORECASE),
    _re.compile(r"פגישה|meeting", _re.IGNORECASE),
    _re.compile(r"הרצאה|שיעור|lecture|class", _re.IGNORECASE),
)
_AFTER_RE = _re.compile(r"(?:אחרי|לאחר|after)\s+(?:ה)?(\S+(?:\s+\S+)?)", _re.IGNORECASE)


def anchor_task(day: list, content: str) -> Optional[dict]:
    """The task her "after X" points at: by its kind word (ראיון matches ריאיון),
    else by a word of its title; the soonest timed one."""
    m = _AFTER_RE.search(content or "")
    said = m.group(1) if m else ""
    if not said:
        return None
    timed = sorted((t for t in day if t.get("date") and clashes.start_of(t)),
                   key=lambda t: (str(t["date"]), clashes.start_of(t)))
    for kind in _KIND_WORDS:
        if kind.search(said):
            hit = next((t for t in timed if kind.search(str(t.get("text") or ""))), None)
            if hit:
                return hit
    named = [t for t in advice.named(timed, said) if t in timed]
    return named[0] if named else None


async def fit_after_answer(lookup: dict, content: str, user: dict, profile_key: str,
                           phone: str) -> Optional[dict]:
    """"The beach tomorrow after the interview — does it fit?" From where the
    interview IS, from when it ENDS. 27.10 live: Meira said "the interview ends
    ~16:30, the beach is 17 min by bike — fits!" (it ends 17:00, in Be'er
    Ya'akov, and the 17 minutes were from Tel Aviv)."""
    day = await _her_days(phone)
    anchor = anchor_task(day, content)
    if not anchor:
        return None
    place = _place_of(anchor)
    if not place:
        return None
    he = bool(_HEBREW_RE.search(content or "")) or user.get("language") == "he"
    try:
        profile = user_profile.get_profile(profile_key) or {}
    except Exception:  # noqa: BLE001
        profile = {}
    result = await place_ranker.lookup(
        profile=profile, here=None, origin=place,
        category=lookup.get("category") if lookup.get("what") == "places" else None,
        destination=lookup.get("destination") if lookup.get("what") == "route" else None,
        modes=lookup.get("modes") or None)
    rows = result.get("results") or []
    if result.get("ok") is False or not rows:
        logger.warning("fit-after: no answer from %s (%s)", "the anchor", result.get("reason"))
        return None
    ways = sorted((rows[0].get("by_mode") or {}).values(), key=lambda l: l["total_min"])
    if not ways:
        return None
    best = ways[0]
    end = clashes.end_of(anchor)
    end_m = int(end[:2]) * 60 + int(end[3:])
    arrive_m = end_m + int(best["total_min"])
    arrive = f"{(arrive_m // 60) % 24:02d}:{arrive_m % 60:02d}"
    where = rows[0].get("name") or (lookup.get("destination") or "")
    way = place_ranker._MODE_WORD["he" if he else "en"].get(best.get("mode"), "")
    city = place.split(",")[-2].strip() if place.count(",") >= 2 else place
    lines = [(f"{anchor.get('text')[:40]} נגמר ב-{end} ({city}). משם: {where} — ~{best['total_min']} דק׳ {way} → שם ~{arrive}."
              if he else f"{anchor.get('text')[:40]} ends at {end} ({city}). From there: {where} — ~{best['total_min']} min {way} → there ~{arrive}.")]
    nxt = next((t for t in sorted(day, key=lambda t: (str(t.get("date")), clashes.start_of(t) or ""))
                if str(t.get("date")) == str(anchor.get("date")) and t is not anchor
                and (clashes.start_of(t) or "") > end), None)
    stay_m = arrive_m + 60       # at least an hour there — she is going for it
    stay = f"{(stay_m // 60) % 24:02d}:{stay_m % 60:02d}"
    if nxt and clashes.start_of(nxt) and clashes.start_of(nxt) < stay:
        lines.append(f"⚠️ ב-{clashes.start_of(nxt)} יש לך {nxt.get('text')[:40]} — לא יסתדר בלי להזיז."
                     if he else f"⚠️ {nxt.get('text')[:40]} at {clashes.start_of(nxt)} — it won't fit unless you move it.")
    elif nxt:
        lines.append(f"אחר כך: {clashes.start_of(nxt)} {nxt.get('text')[:40]}." if he
                     else f"Next: {clashes.start_of(nxt)} {nxt.get('text')[:40]}.")
    return {"text": "\n".join(lines), "type": "answer", "tasks": [], "departures": []}


_FITS_RE = _re.compile(r"זה מסתדר|יסתדר|מסתדר לי|זה מתאים|יש לי זמן|אספיק|אני אספיק|אפשר להספיק|אגיע בזמן"
                       r"|does (?:it|that) (?:fit|work)|will i make it|can i (?:fit|make it)|do i have time",
                       _re.IGNORECASE)


def asks_if_it_fits(content: str) -> bool:
    """"I want the beach tomorrow after the interview — does it fit?" asks about
    her TIME, not where the nearest beach is (27.10 live: it got the beach)."""
    return bool(_FITS_RE.search(content or ""))


_TOOL_TALK_RE = _re.compile(r"^\s*⚠️\s*(?:לא שמרתי כלום עכשיו|לא נשמר|Nothing was saved just now|Not saved)[^\n]*$", _re.M)


def goal_reply(text: str, fr: Optional[dict], saved: list) -> str:
    """The reply answers HER goal. "⚠️ nothing saved" is true but beside the
    point when she asked a question or told Meira something (29.10: 'how many
    workouts?' → 'I didn't save anything'). It stays only when saving WAS the
    goal; the false claim it replaced is already gone either way."""
    if not text or saved or not fr or fr.get("intent") in (None, _frame.SCHEDULING_ACTION):
        return text
    out = _TOOL_TALK_RE.sub("", text).strip()
    if out:
        return out
    he = bool(_HEBREW_RE.search(text))
    return ("לא הצלחתי לענות על זה כרגע — אפשר לנסח אחרת?" if he
            else "I couldn't answer that just now — can you put it another way?")


def join_reply(text: str, note: str) -> str:
    """The agent's words + what code did, asking at most ONE question: when the
    agent already ends on a question, code's question lines are dropped (27.10:
    "what are the details?" + "which day?" + "what time?" in one reply)."""
    text = (text or "").strip()
    if text.rstrip().endswith(("?", "？")):
        note = "\n".join(l for l in (note or "").splitlines() if not l.rstrip().endswith(("?", "？")))
    return f"{text}\n\n{note}".strip() if note.strip() else text


def tasks_of(actions: list, content: str) -> list:
    """The "add" actions as tasks, with several-day spans expanded and "the
    Sunday after that" counted from the day before it (tz.resolve_after)."""
    out: list = []
    prev_last: Optional[_date] = None
    for action in actions or []:
        if action.get("do") != "add":
            continue
        task = _understand.task_from(action, content)
        if not task:
            continue
        items = list_items(task.get("text"))
        if len(items) > 1:
            # 27.10, on her phone: "Tasks for tomorrow morning: A, B" came back
            # as ONE task titled with the whole list. The model was told; code
            # makes sure.
            out += tasks_of([{**action, "title": it} for it in items], content)
            continue
        expr = str(action.get("date_expression") or "")
        dates: list = []
        if expr and action.get("until_expression"):
            dates = _tz.resolve_range(expr, str(action["until_expression"]))
            if not dates:
                logger.warning("understanding: range did not resolve; first day only")
        elif expr and prev_last and _understand._truthy(action.get("after_previous")):
            after = _tz.resolve_after(expr, prev_last)
            dates = [after] if after else []
        if dates:
            out += [{**task, "date": d.isoformat()} for d in dates]
            prev_last = dates[-1]
            continue
        out.append(task)
        try:
            prev_last = _date.fromisoformat(str(task.get("date") or "")[:10])
        except ValueError:
            pass
    return out


# "מה יש לי מחר?" / "what do I have on Tuesday?" — her day, read from the store
# and SAID by code. 27.10 live: the agent answered "nothing tomorrow", then
# invented "kickboxing 08:00, a meeting with Niv 10:00, a workout 18:00" —
# while the real day held an interview at 16:00. A fact she can read is never
# the model's to recall.
_DAY_Q_RE = _re.compile(
    r"^\s*(?:ו?מה\s+(?:יש\s+לי|יש\s+לי\s+ב?יומן|התוכנית(?:\s+שלי)?|הלו\"?ז(?:\s+שלי)?|מחכה\s+לי|קורה)"
    r"|what(?:'s|\s+is|\s+do\s+i\s+have|\s+have\s+i\s+got)(?:\s+on|\s+planned)?"
    r"|(?:show\s+me\s+)?my\s+(?:day|schedule|plan)\b)",
    _re.IGNORECASE)
_DAY_Q_REST_RE = _re.compile(r"[?？!.\s]|היום|מחר|מחרתיים|ביום|יום|ב-?|today|tomorrow|on|for|the|day|\d{1,2}[./]\d{1,2}",
                             _re.IGNORECASE)


def day_question(content: str) -> Optional[str]:
    """The date she asks about ("מה יש לי מחר?" → tomorrow), or None. Only a
    message that is JUST that question: "מה יש לי מחר ותזיזי את X" is not."""
    text = (content or "").strip()
    m = _DAY_Q_RE.match(text)
    if not m:
        return None
    rest = text[m.end():]
    own, _ = _tz.date_expressions(rest)
    leftover = _tz.REL_DATE_RE.sub(" ", rest)
    if _DAY_Q_REST_RE.sub("", leftover).strip():
        return None          # more words than a day: a different request
    if len(own) > 1:
        return None
    when = _tz.resolve_date(own[0]) if own else _tz.today_il()
    return when.isoformat() if when else None


_URGENT_RE = _re.compile(r"^\s*(?:ו?מה\s+(?:הכי\s+)?דחוף(?:\s+לי)?(?:\s+(?:השבוע|היום|עכשיו))?"
                         r"|what'?s\s+(?:most\s+)?urgent|what\s+is\s+(?:most\s+)?urgent|what\s+first)\s*[?？!.]*\s*$",
                         _re.IGNORECASE)
_BIG_CATEGORIES = {"interview", "doctor", "meeting", "conference", "class", "course", "zoom", "call"}


def urgent_question(content: str) -> bool:
    return bool(_URGENT_RE.match(content or ""))


def urgent_lines(day: list, today: _date, he: bool, limit: int = 4) -> list:
    """What comes first: fixed appointments in the next two days, then the
    nearest deadlines, then today's 'must' work. 27.10 live: "מה הכי דחוף?"
    named a project due Friday and skipped the interview the next afternoon."""
    soon = (today + _timedelta(days=2)).isoformat()
    out: list = []
    seen: set = set()
    fixed = [t for t in day if t.get("date") and clashes.start_of(t)
             and today.isoformat() <= str(t["date"])[:10] <= soon
             and (t.get("category") in _BIG_CATEGORIES or t.get("priority") in ("must", "have_to"))]
    # What matters most first, then by the clock: an interview the next
    # afternoon outranks a call at 08:00 (27.10 live: it came third).
    weight = {"interview": 0, "doctor": 0, "conference": 1, "class": 1, "course": 1,
              "meeting": 2, "zoom": 2, "call": 3}
    big_words = _re.compile(r"ריאיון|ראיון|interview|רופא|רופאה|doctor|בדיקה רפואית|מבחן|exam", _re.IGNORECASE)

    def weigh(t: dict) -> int:
        return 0 if big_words.search(str(t.get("text") or "")) else weight.get(t.get("category"), 4)

    for t in sorted(fixed, key=lambda t: (weigh(t),
                                          0 if t.get("priority") == "must" else 1,
                                          str(t["date"]), clashes.start_of(t))):
        out.append(f"• {_day_word(str(t['date']), he)} {clashes.start_of(t)} {t.get('text')}")
        seen.add(str(t.get("id")))
    due = [t for t in day if t.get("deadline") and str(t.get("id")) not in seen]
    for t in sorted(due, key=lambda t: str(t["deadline"])):
        out.append(f"• {'עד' if he else 'due'} {_short_date(str(t['deadline']))}: {t.get('text')}")
        seen.add(str(t.get("id")))
    must = [t for t in day if t.get("priority") == "must" and str(t.get("id")) not in seen
            and str(t.get("date") or "")[:10] == today.isoformat()]
    out += [f"• {'היום' if he else 'today'}: {t.get('text')}" for t in must]
    return out[:limit]


async def delete_turn(phone: str, content: str, he: bool) -> Optional[str]:
    """"תמחקי את הזומבה בראשון" (29.10) — done in code and said, never a
    "nothing saved" from a model that claimed it. None → not a delete."""
    choice = session.get_pending_choice(phone) or {}
    if choice.get("owner") == DELETE_OWNER:
        m = _re.match(r"^\s*(?:ה?(?:מספר\s*)?)?([1-3])\s*[.!]?\s*$", content or "")
        ids = list(choice.get("options") or [])
        if m and int(m.group(1)) <= len(ids):
            session.clear_pending_choice(phone)
            tid = ids[int(m.group(1)) - 1]
            t = next((x for x in await _her_days(phone) if str(x.get("id")) == tid), None)
            if not t:
                return "היא כבר לא ביומן ✓" if he else "It's no longer on your day ✓"
            return await _cancel_said(phone, t, he)
    asked = past_log.delete_request(content, _tz.today_il())
    if not asked:
        return None
    day = await _her_days(phone)
    on = {d.isoformat() for d in asked["days"]}
    pool = [t for t in day if not on or str(t.get("date") or "")[:10] in on]
    scored = sorted(((past_log.score(t, asked["words"]), t) for t in pool), key=lambda x: -x[0])
    scored = [(n, t) for n, t in scored if n]
    what = " ".join(asked["words"])
    when = " ".join(past_log.day_label(d, he) for d in sorted(on))
    if not scored:
        return (f"לא מצאתי '{what}'{' ב' + when if when else ''} — איך היא נקראת ביומן?" if he
                else f"I couldn't find '{what}'{' on ' + when if when else ''} — what is it called?")
    best = [t for n, t in scored if n == scored[0][0]]
    vague = not on and all(w in past_log.GENERIC_WORDS for w in asked["words"])
    if len(best) > 1 or vague:
        opts = "\n".join(f"{i}) {t.get('text')} · {past_log.day_label(str(t.get('date')), he)} {t.get('fixed_time') or ''}".rstrip()
                         for i, t in enumerate(best[:3], 1))
        try:
            session.set_pending_choice(phone, DELETE_OWNER, len(best[:3]), [str(t["id"]) for t in best[:3]])
        except Exception as exc:  # noqa: BLE001 — her "2" then reaches the agent
            logger.warning("delete choice not kept: %s", type(exc).__name__)
        return (f"איזו למחוק?\n{opts}" if he else f"Which one should I delete?\n{opts}")
    return await _cancel_said(phone, best[0], he)


DELETE_OWNER = "delete_pick"


async def _cancel_said(phone: str, t: dict, he: bool) -> str:
    at = f"{past_log.day_label(str(t.get('date')), he)} {t.get('fixed_time') or ''}".strip()
    if not await _patch_task(phone, str(t["id"]), {"status": "cancelled"}):
        return (f"לא הצלחתי למחוק את {t.get('text')} · {at} — נסי שוב" if he
                else f"Couldn't delete {t.get('text')} · {at} — try again")
    return f"מחקתי: {t.get('text')} · {at} ✓" if he else f"Deleted: {t.get('text')} · {at} ✓"


def _off_closed_days(key: str, tasks: list, day: list, he: bool) -> tuple:
    """Tasks dated on a day she is not available are not booked: said, with
    the reason, and one question (29.10: Zumba on her Midburn day)."""
    kept, lines = [], []
    for t in tasks:
        iso = str(t.get("date") or "")[:10]
        why = constraints.blocked(key, iso, day) if iso else None
        if why:
            lines.append(f"ב{past_log.day_label(iso, he)} את {constraints.say_away(why, he)}, אז לא קבעתי שם {t.get('text')}. יום אחר?"
                         if he else f"You're {constraints.say_away(why, he)} on {past_log.day_label(iso, he)}, "
                                    f"so I didn't book {t.get('text')} there. Another day?")
        else:
            kept.append(t)
    return kept, lines


def away_lines(new: list, day: list, he: bool) -> list:
    """A save on a day she is away (vacation, a flight, reserve duty) is said
    with the clash, and one way out (29.10: Zumba booked on her Midburn day)."""
    out = []
    for t in new:
        iso = str(t.get("date") or "")[:10]
        away = past_log.away_task([d for d in day if str(d.get("id")) != str(t.get("id"))], iso) if iso else None
        if away:
            out.append(f"⚠️ ב{past_log.day_label(iso, he)} את ב{away.get('text')} — להזיז את {t.get('text')} ליום אחר?"
                       if he else f"⚠️ On {past_log.day_label(iso, he)} you're away ({away.get('text')}) — move {t.get('text')} to another day?")
    return out


async def past_turn(phone: str, content: str, he: bool, tidy: bool = True) -> Optional[str]:
    """Her past, in code (29.10): "how many times did I work out this week?"
    is counted from her own tasks, and "I trained on Sunday" ticks the Sunday
    that WAS — never a new task next week. None → not this kind of message."""
    import task_store
    today = _tz.today_il()
    if past_log.asks_workouts(content):
        import history_stats
        p = history_stats.period(content, today)
        rows, source = await task_store.fetch_tasks_with_source(phone, p["from"], p["to"])
        if source == "unreachable":
            return ("לא הצלחתי לקרוא את המשימות שלך כרגע — זה לא אומר 0. נסי שוב בעוד רגע." if he
                    else "I couldn't read your tasks right now — that does not mean 0. Try again in a moment.")
        return past_log.count_line(rows, p["from"], p["to"], today, p["label"], he)
    said = past_log.report(content, today)
    if not said:
        return None
    import history_stats
    week = history_stats.period("this week", today)
    first = min(min(d for d, _ in said).isoformat(), week["from"])
    until = (today + _timedelta(days=8)).isoformat()
    rows, source = await task_store.fetch_tasks_with_source(phone, first, until)
    if source == "unreachable":
        return ("לא הצלחתי לקרוא את המשימות שלך כרגע, אז לא סימנתי כלום. נסי שוב בעוד רגע." if he
                else "I couldn't read your tasks right now, so nothing was ticked. Try again in a moment.")
    lines: list = []
    done_ids: set = set()
    for d, kind in said:
        iso = d.isoformat()
        same = [r for r in rows if str(r.get("date") or "")[:10] == iso and past_log.matches(r, kind)
                and not past_log.is_past_titled(r)]
        label = past_log.day_label(iso, he)
        if any(r.get("status") == "complete" for r in same):
            r = next(r for r in same if r.get("status") == "complete")
            done_ids.add(str(r.get("id")))
            lines.append(f"• {label} {r.get('text')} — כבר היה מסומן ✓" if he
                         else f"• {label} {r.get('text')} — already ticked ✓")
            continue
        if same:
            r = same[0]
            ok = await _patch_task(phone, str(r["id"]), {"status": "complete"})
            if ok:
                done_ids.add(str(r.get("id")))
            lines.append((f"• {label} {r.get('text')} ✓" if ok else f"• {label} {r.get('text')} — לא הצלחתי לסמן")
                         if he else (f"• {label} {r.get('text')} ✓" if ok else f"• {label} {r.get('text')} — couldn't tick it"))
            continue
        title = kind or ("אימון" if he else "Workout")
        task = {"text": title, "date": iso, "category": "gym", "priority": "need_to",
                "status": "complete", "durationMinutes": 60, "isFixed": False}
        try:
            stored = user_memory.add_task(phone, task, trust_status=True)
            task["id"] = stored["id"]
            uid = await supabase_tasks.user_id_for_phone(phone)
            if uid:
                await supabase_tasks.upsert_task(uid, task, trust_status=True)
            done_ids.add(str(task["id"]))
            lines.append(f"• {label} {title} ✓")
        except Exception as exc:  # noqa: BLE001 — said, never claimed
            logger.warning("past-log save failed: %s", type(exc).__name__)
            lines.append(f"• {label} {title} — לא הצלחתי לשמור" if he else f"• {label} {title} — couldn't save it")
    # A report filed earlier as a PLAN ("And I did went to Zumba" on 2.11) is removed, and said.
    removed = []
    kinds = [k for _, k in said]
    for r in rows if tidy else []:
        if str(r.get("date") or "")[:10] > today.isoformat() and past_log.is_past_titled(r) \
                and str(r.get("status") or "pending") == "pending" \
                and any(past_log.matches(r, k) for k in kinds):
            if await _patch_task(phone, str(r["id"]), {"status": "cancelled"}):
                removed.append(f"{r.get('text')} ({_short_date(str(r['date']))})")
    head = "רשמתי:" if he else "Logged:"
    text = "\n".join([head, *lines])
    if removed:
        text += ("\nומחקתי מה שנשמר בטעות כעתיד: " if he else "\nAnd removed what was wrongly saved as future: ") \
            + ", ".join(removed)
    n = len(done_ids | {str(r.get("id")) for r in rows
                        if r.get("status") == "complete" and past_log.is_workout(r)
                        and week["from"] <= str(r.get("date") or "")[:10] <= today.isoformat()
                        and not past_log.is_past_titled(r)})
    text += (f"\nהשבוע: {'אימון אחד' if n == 1 else f'{n} אימונים'} 💪" if he
             else f"\nThis week: {n} workout{'s' if n != 1 else ''} 💪")
    return text


async def day_answer(phone: str, date_iso: str, he: bool) -> str:
    """Her day as code reads it — the same rows and plan as MCP get_my_day."""
    import day_plan
    import task_store
    rows, source = await task_store.fetch_tasks_with_source(phone, date_iso, date_iso,
                                                            include_location=True)
    label = _day_word(date_iso, he)
    if source == "unreachable":
        return (f"לא הצלחתי לקרוא את היומן שלך ל{label} כרגע — זה לא אומר שהוא פנוי. נסי שוב בעוד רגע."
                if he else f"I couldn't read your day for {label} right now — that does not mean it's free. Try again in a moment.")
    rows = [r for r in rows if str(r.get("status") or "pending") not in _DONE]
    if not rows:
        return f"ל{label} אין לך כלום שמור." if he else f"Nothing saved for {label}."
    try:
        profile = user_profile.get_profile(phone) or {}
    except Exception:  # noqa: BLE001
        profile = {}
    now = _tz.now_il().strftime("%H:%M") if date_iso == _tz.today_il().isoformat() else None
    plan = await day_plan.plan_day(rows, date=date_iso, home=profile.get("homeAddress"),
                                   routine_minutes=profile.get("morningRoutineMinutes") or 45, now=now)
    lines = [f"{label}:" if he else f"{label[:1].upper()}{label[1:]}:"]
    for ev in plan.get("events") or []:
        when = ev.get("time") or ("—")
        line = f"• {when} {ev.get('text')}"
        if ev.get("place"):
            line += f" · {ev['place']}"
        if ev.get("leave_by"):
            line += f" — {'לצאת' if he else 'leave'} {ev['leave_by']}"
        lines.append(line)
    if plan.get("wake_by"):
        lines.append(f"⏰ {'להתעורר' if he else 'wake up'} {plan['wake_by']}")
    for p in (plan.get("problems") or [])[:2]:
        q = p.get("question_he" if he else "question_en")
        if q:
            lines.append(f"⚠️ {q}")
    return "\n".join(lines)


# ── conflicts: "which one?", "where should I move it?" (27.10) ──────────────

_PICK_RE = _re.compile(r"^\s*(?:(1|2)|(הראשון|הראשונה|first)|(השני|השנייה|second))\b", _re.IGNORECASE)
_CANCEL_RE = _re.compile(r"^\s*(?:לבטל|לבטל אותו|לבטל אותה|תבטלי|לוותר|cancel|drop it)\b", _re.IGNORECASE)


def _pick_of(content: str, titles: list) -> Optional[int]:
    """1 or 2 from "1", "השני", or a word of one option's title; else None."""
    m = _PICK_RE.match(content or "")
    if m:
        return 1 if (m.group(1) == "1" or m.group(2)) else 2
    said = advice._words(content)
    hits = [i for i, t in enumerate(titles, 1) if said & advice._words(t)]
    return hits[0] if len(hits) == 1 else None


async def _patch_task(phone: str, task_id: str, patch: dict) -> bool:
    try:
        mem = user_memory.update_task(phone, task_id, patch)
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            # Linked: the cloud row is the truth — a PATCH that changed nothing
            # is never a "✓" (silent-state rule 3).
            return bool(await supabase_tasks.update_task(uid, str(task_id), patch))
        return mem is not None
    except Exception as exc:  # noqa: BLE001 — said, never claimed
        logger.warning("advice: update failed: %s", type(exc).__name__)
        return False


def _slot_words(slots: list, he: bool) -> list:
    return [f"{n}) {_day_word(d, he)} {h}" for n, (d, h) in enumerate(slots, 1)]


async def _offer_move(phone: str, task: dict, day: list, he: bool, head: str = "") -> str:
    now = _tz.now_il()
    slots = advice.two_slots(task, day, now.hour * 60 + now.minute, now.date().isoformat())
    if not slots:
        return (f"{head}\nל{task.get('text')} לא מצאתי שעה פנויה בשבוע הקרוב." if he
                else f"{head}\nNo free hour for {task.get('text')} in the coming week.").strip()
    session.set_pending_choice(phone, advice.MOVE_OWNER, len(slots), options=[list(x) for x in slots],
                               context={"task_id": str(task.get("id"))})
    ask = (f"את {task.get('text')} אפשר להזיז ל:" if he else f"{task.get('text')} could move to:")
    tail = ("מה מתאים? כתבי 1 או 2 — או 'לבטל'" if he else "Which? Reply 1 or 2 — or 'cancel'")
    return "\n".join(x for x in (head, ask, *_slot_words(slots, he), tail) if x)


async def advice_turn(phone: str, content: str, user: dict, profile_key: str) -> Optional[dict]:
    """Conflict help, all of it in one place. None → not this kind of message."""
    he = bool(_HEBREW_RE.search(content or "")) or user.get("language") == "he"

    def reply(text: str, **more) -> dict:
        return {"text": text, "type": "answer", "tasks": more.pop("tasks", []), "departures": [], **more}

    choice = session.get_pending_choice(phone)
    owner = (choice or {}).get("owner")
    if owner in (advice.CHOOSE_OWNER, advice.MOVE_OWNER):
        day = await _her_days(phone)
        by_id = {str(t.get("id")): t for t in day}
        if owner == advice.CHOOSE_OWNER:
            ids = list(choice.get("options") or [])
            titles = [str((by_id.get(i) or {}).get("text") or "") for i in ids]
            n = _pick_of(content, titles)
            if not n or len(ids) < 2:
                return None
            session.clear_pending_choice(phone)
            kept, other = by_id.get(ids[n - 1]), by_id.get(ids[2 - n])
            if not kept or not other:
                return reply("לא מצאתי את שני האירועים עוד ביומן — אולי אחד מהם כבר זז?" if he
                             else "I can't find both events on your day any more — did one move?")
            head = f"בחרת: {kept.get('text')} ✓" if he else f"Your pick: {kept.get('text')} ✓"
            return reply(await _offer_move(phone, other, day, he, head))
        # MOVE: which slot, or cancel
        task = by_id.get(str((choice.get("context") or {}).get("task_id")))
        if not task:
            session.clear_pending_choice(phone)
            return None
        if _CANCEL_RE.match(content or ""):
            session.clear_pending_choice(phone)
            ok = await _patch_task(phone, task["id"], {"status": "cancelled"})
            return reply((f"ביטלתי: {task.get('text')} ✓" if he else f"Cancelled: {task.get('text')} ✓") if ok
                         else ("לא הצלחתי לבטל — נסי שוב" if he else "Couldn't cancel it — try again"))
        slots = [tuple(x) for x in choice.get("options") or []]
        n = _pick_of(content, [])
        if not n or n > len(slots):
            return None
        session.clear_pending_choice(phone)
        new_date, new_hour = slots[n - 1]
        msg = advice.draft(task, new_date, new_hour, he)
        who = msg["to"]["name"]
        patch = {"date": new_date, "fixed_time": new_hour}
        if who or msg["links"]:
            patch["notes"] = advice.maybe_note(who, he)
        if not await _patch_task(phone, task["id"], patch):
            return reply("לא הצלחתי להזיז — נסי שוב" if he else "Couldn't move it — try again")
        lines = [f"הזזתי: {task.get('text')} ← {_day_word(new_date, he)} {new_hour}" if he
                 else f"Moved: {task.get('text')} → {_day_word(new_date, he)} {new_hour}"]
        if "notes" in patch:
            session.set_maybe(phone, task["id"], who)
            lines.append(patch["notes"])
            to = " · ".join(x for x in (msg["to"].get("email"), msg["to"].get("phone")) if x)
            lines.append((f"הודעה מוכנה ל{who or 'הצד השני'}" if he else f"Ready for {who or 'them'}")
                         + (f" ({to}):" if to else ":"))
            lines.append(f"«{msg['text']}»")
            ways = [w for w, k in (("מייל" if he else "email", "email"), ("SMS", "sms"),
                                   ("WhatsApp", "whatsapp")) if k in msg["links"]]
            lines.append((f"אפשר לשלוח ב: {' / '.join(ways)}. תגידי לי כש{who or 'הוא'} מאשר." if he
                          else f"Send it by: {' / '.join(ways)}. Tell me when {who or 'they'} confirm.") if ways
                         else ("אין באירוע מייל או טלפון — העתיקי ושלחי בעצמך." if he
                               else "The event has no email or phone — copy it and send it yourself."))
        return reply("\n".join(lines), draft=msg, tasks=[{**task, **patch}])

    maybe = session.get_maybe(phone)
    if maybe and advice.confirms(content):
        session.clear_maybe(phone)
        ok = await _patch_task(phone, maybe["task_id"], {"notes": ""})
        return reply(("מעולה — זה קורה ✓" if he else "Great — it's happening ✓") if ok
                     else ("לא הצלחתי לעדכן — נסי שוב" if he else "Couldn't update it — try again"))

    if advice.wants_choice(content, None) or (advice._CHOOSE_RE.search(content or "")
                                             and advice.wants_choice(content, await _her_days(phone))):
        day = await _her_days(phone)
        pair = advice.pair_for(day, content)
        if not pair:
            return None
        try:
            about = user_memory.format_for_prompt(profile_key)
            about += "\n" + routine_match.notes_of(user_profile.get_profile(profile_key))
        except Exception as exc:  # noqa: BLE001 — weighs without it
            logger.warning("advice: her profile unreadable: %s", type(exc).__name__)
            about = ""
        text, ids = await advice.choose(pair[0], pair[1], day, about, content, he)
        session.set_pending_choice(phone, advice.CHOOSE_OWNER, 2, options=ids)
        return reply(text)

    if advice.wants_move(content):
        day = await _her_days(phone)
        named = advice.named(day, content)
        if not named:
            return None
        return reply(await _offer_move(phone, named[0], day, he))
    return None


_WHEN_RE = _re.compile(
    r"^\s*(?:ו?מתי|ל?מתי שמרת|באיזו שעה|באיזה שעה|לאיזה יום|באיזה יום|על איזה יום|ומה השעה"
    r"|when|when\?|what time|which day|for when)\s*(?:זה|את זה|שמרת|it|is it)?\s*[?？!.]*\s*$",
    _re.IGNORECASE)


async def when_answer(phone: str, content: str) -> Optional[str]:
    """"מתי?" right after a save: the day and hour of what was just saved, or
    — when it has none — the first free hour to put it in. None when this is
    not that question or nothing was saved lately (the agent answers).

    27.10: twice she asked "when?" after "saved ✓" and Meira did not
    understand what she was asking about."""
    if not _WHEN_RE.match(content or ""):
        return None
    try:
        ids = session.get_last_saved(phone) or [session.get_active_task_id(phone)]
    except Exception as exc:  # noqa: BLE001
        logger.warning("when: session unreadable: %s", exc)
        return None
    ids = [str(i) for i in ids if i]
    if not ids:
        return None
    he = bool(_HEBREW_RE.search(content or ""))
    day = await _her_days(phone)
    mine = [t for t in day if str(t.get("id")) in ids]
    if not mine:
        try:
            mine = [t for t in user_memory.tasks_for_phone(phone) if str(t.get("id")) in ids]
        except Exception as exc:  # noqa: BLE001
            logger.warning("when: memory unreadable: %s", exc)
    if not mine:
        return None
    lines = said_saved_lines(mine, he)
    undated = [t for t in mine if not t.get("date")]
    if undated:
        now = _tz.now_il()
        today = now.date()
        for offset in (0, 1):
            d = (today + _timedelta(days=offset)).isoformat()
            hour = day_slots.first_free(day_slots.busy_of(day, d),
                                        int(undated[0].get("duration_minutes") or 30),
                                        not_before=(now.hour * 60 + now.minute + 15) if offset == 0 else None)
            if hour:
                lines[-1] = (f"עוד אין לה יום. מתאים {_day_word(d, he)} ב-{hour}?" if he
                             else f"It has no day yet. How about {_day_word(d, he)} at {hour}?")
                break
    def plain(line: str) -> str:
        for head in ("שמרתי: ", "קבעתי: ", "Saved: ", "Done — ", "שמרתי ל", "Saved for ", "On "):
            if line.startswith(head):
                line = line[len(head):]
                break
        return line.replace(" ✓", "")
    return "\n".join(plain(l) for l in lines)


async def act_on_understanding(phone: str, content: str, channel: str,
                               history: list, about: str = "",
                               seen: Optional[dict] = None,
                               result: Optional[dict] = None,
                               fr: Optional[dict] = None,
                               profile_key: Optional[str] = None) -> tuple:
    """Understand the message in its conversation, then do it. -> (saved, note, understood)

    `understood` False means the model step could not run — the caller falls
    back on the regex rescue. True with nothing saved means she asked for
    nothing to be saved, and nothing is.

    `about` is what is known about her place and transport (understand.about_her);
    `seen`, when given, receives {"kind", "lookup"} — "question" means the agent
    answers. `result`: an understanding already made this turn, so it is not
    asked for twice."""
    he = bool(_re.search(r"[\u0590-\u05FF]", content or ""))
    day = await _her_days(phone)
    if result is None:
        result = await _understand.understand(content, history, day, about=about)
    if result is None:
        return [], "", False
    if seen is not None:
        seen["kind"] = result.get("kind") or "do"
        seen["lookup"] = result.get("lookup")
    saved: list = []
    tasks = tasks_of(result["actions"], content)
    told = [t for t in tasks if past_log.is_past_titled(t)]
    if told:
        # "And I did went to Zumba" (29.10) is what happened, not a plan: a
        # task titled with her past verb is never saved on a coming day.
        tasks = [t for t in tasks if not past_log.is_past_titled(t)]
        lines_told = ["זה נשמע כמו משהו שכבר קרה, אז לא שמרתי כתוכנית. לסמן כבוצע? כתבי למשל 'התאמנתי ביום שני'."
                      if he else "That sounds like something that already happened, so I didn't plan it. "
                                 "Tick it as done? Say e.g. 'I trained on Monday'."]
    else:
        lines_told = []
    lines: list = list(lines_told)
    if tasks and not _frame.may_schedule(fr):
        # Her past, a habit, her availability: context, never a booking —
        # whatever the model made of it (frame.py, 29.10).
        logger.warning("understanding: %d add(s) dropped — message read as %s/%s",
                       len(tasks), (fr or {}).get("intent"), (fr or {}).get("time"))
        tasks = []
    if tasks:
        tasks, closed = _off_closed_days(profile_key or phone, tasks, day, he)
        lines += closed
    bare = [t for t in tasks if is_bare(t)]
    if bare:
        # "תוסיפי פגישה" (27.10 live): a task called "פגישה" with no day, hour,
        # place or person is not a task yet — it was saved, and three
        # questions were asked at once. Save nothing; ask ONE thing.
        tasks = [t for t in tasks if not is_bare(t)]
        if not result.get("ask"):
            result = {**result, "ask": "עם מי, מתי ואיפה?" if he else "With whom, when and where?"}
    for task in tasks:
        if task.pop("alarm_auto", False):
            # "…and set an alarm" with no hour: the morning's wake time from her
            # route and routine, when this task is the morning's first.
            first, at = await morning_alarm(phone, day + [task], "auto")
            if first is task and at:
                task["alarmAt"] = at
    if tasks:
        # A day and no hour ("ביום שלישי בבוקר"): placed in that window's free
        # time, and the hour is SAID (27.10).
        now = _tz.now_il()
        tasks = day_slots.place(tasks, day, _understand.PARTS_OF_DAY,
                                now.hour * 60 + now.minute, now.date().isoformat())
        for t in tasks:
            t.pop("part_of_day", None)
    if tasks:
        # Said again within minutes ("Call the TAN" … "Paul Dothan" … "Dotan"
        # — the mic mis-heard a name five times, 20.10 00:47): a retry REPLACES
        # the task it just saved, it never adds a sixth.
        redone, tasks = await replace_recent_retries(phone, tasks, history, day, he)
        saved += [r for r, _ in redone]
        lines += [line for _, line in redone]
    if tasks:
        placed = {i for i, t in enumerate(tasks) if t.pop("placed_by", None)}
        new = await persist_agent_tasks(phone, content, {"tasks": tasks}, channel)
        saved += new
        lines += said_saved_lines(new, he, placed)
        lines += away_lines(new, day, he)
    if saved:
        try:
            session.set_last_saved(phone, [t.get("id") for t in saved])
        except Exception as exc:  # noqa: BLE001 — "when?" then falls back to the agent
            logger.warning("last-saved not kept: %s", exc)
    by_id = {str(t.get("id")): t for t in day}
    uid = None
    for action in result["actions"]:
        if action.get("do") != "update":
            continue
        target = by_id.get(str(action.get("task_id")))
        patch = _understand.patch_from(action)
        if action.get("alarm_only"):
            # Koral, 20.10: an alarm request is a REAL alarm for the FIRST task of
            # the coming morning, at the hour she said or — none said — at the
            # day's wake time from everything known (route, routine).
            first, at = await morning_alarm(phone, day, action.get("alarm"))
            target = target or first
            if target:
                patch = {"alarmAt": (at if target is first else (patch.get("alarmAt") or at)),
                         "alarmState": "planned"}
        if not target or not patch:
            logger.warning("understanding: update skipped (id %r known=%s, patch=%s)",
                           action.get("task_id"), bool(target), sorted(patch))
            continue
        try:
            user_memory.update_task(phone, target["id"], patch)
            uid = uid or await supabase_tasks.user_id_for_phone(phone)
            cloud = {k: v for k, v in patch.items() if k not in ("alarmAt", "alarmState")}
            # The cloud row has no alarm column — the alarm rides in the reply
            # and the phone arms it; only real field changes must reach the row.
            if uid and cloud and not await supabase_tasks.update_task(uid, str(target["id"]), cloud):
                raise RuntimeError("the task is not in the cloud (deleted on the phone?)")
        except Exception as exc:  # noqa: BLE001 — say it failed, don't claim it
            logger.warning("understanding: update failed: %s", exc)
            lines.append(f"לא הצלחתי לעדכן את '{target.get('text')}'" if he
                         else f"Couldn't update '{target.get('text')}'")
            continue
        updated = {**target, **patch}
        saved.append(updated)
        if action.get("alarm_only"):
            when = f" {_short_date(str(updated['date']))}" if updated.get("date") else ""
            lines.append(f"⏰ שעון מעורר{when} ב-{patch['alarmAt']}, לפני: {updated.get('text')} "
                         f"({updated.get('fixed_time') or ''}) ✓" if he
                         else f"⏰ Alarm{when} at {patch['alarmAt']}, before: {updated.get('text')} "
                              f"({updated.get('fixed_time') or ''}) ✓")
            continue
        lines.append(f"עדכנתי: {updated.get('text')} · {updated.get('fixed_time') or ''} ✓".strip()
                     if he else f"Updated: {updated.get('text')} · {updated.get('fixed_time') or ''} ✓")
    if result.get("ask"):
        # Unclear → one question, last, ending in "?" — the app shows it as
        # the thing to answer, and the next message is read as that answer.
        q = result["ask"].rstrip(" ?？") + "?"
        lines.append(q)
    return saved, "\n".join(lines), True


RETRY_WINDOW_MIN = 5
_SAVED_AT_RE = _re.compile(
    r"(?:(?:Saved|שמרתי|קבעתי|נשמר)[^:\n]*:|Done —)\s*(?P<title>[^·\n✓]+?)\s*·\s*(?:\S+\s+)?(?P<time>\d{1,2}:\d{2})")


def _recent_saves(history: list, now) -> list:
    """[(title, HH:MM)] Meira confirmed in the last RETRY_WINDOW_MIN minutes."""
    out = []
    for turn in reversed(history or []):
        if turn.get("role") != "assistant":
            continue
        try:
            ts = _datetime.fromisoformat(str(turn.get("ts") or "")[:19])
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=now.tzinfo)
        if (now - ts).total_seconds() > RETRY_WINDOW_MIN * 60:
            break
        out += [(m.group("title").strip(), m.group("time").zfill(5))
                for m in _SAVED_AT_RE.finditer(str(turn.get("content") or ""))]
    return out


async def replace_recent_retries(phone: str, tasks: list, history: list, day: list, he: bool) -> tuple:
    """Split new tasks into retries of a save made minutes ago (updated in
    place) and genuinely new ones. -> ([(updated_task, line)], still_new).

    A retry = the same clock time as a task Meira confirmed in the last few
    minutes, with that task still on her day. The newer words win: the title
    and the date are replaced, the id is kept."""
    recent = _recent_saves(history, _tz.now_il())
    if not recent:
        return [], tasks
    by_title = {str(t.get("text") or "").strip(): t for t in day}
    redone, fresh = [], []
    for task in tasks:
        at = str(task.get("fixed_time") or "")[:5]
        old_title = next((ti for ti, hm in recent if at and hm == at and ti in by_title), None)
        old = by_title.get(old_title) if old_title else None
        if not old:
            fresh.append(task)
            continue
        patch = {k: task[k] for k in ("text", "date", "category") if task.get(k)}
        try:
            user_memory.update_task(phone, old["id"], patch)
            uid = await supabase_tasks.user_id_for_phone(phone)
            if uid and not await supabase_tasks.update_task(uid, str(old["id"]), patch):
                fresh.append(task)      # the old one is gone — save this as new
                continue
        except Exception as exc:  # noqa: BLE001 — save it as new rather than lose it
            logger.warning("retry replace failed, saving as new: %s", exc)
            fresh.append(task)
            continue
        updated = {**old, **patch}
        logger.warning("a retry replaced the task saved minutes ago (same hour %s)", at)
        line = (f"תיקנתי: {updated.get('text')} · {at} (במקום \"{old_title}\") ✓" if he
                else f"Fixed: {updated.get('text')} · {at} (instead of \"{old_title}\") ✓")
        redone.append((updated, line))
    return redone, fresh


MORNING_ENDS = "12:00"


def _first_on(day: list, date_iso: str, after: str = "") -> Optional[dict]:
    timed = sorted((t for t in day if str(t.get("date") or "")[:10] == date_iso
                    and t.get("fixed_time") and str(t.get("fixed_time"))[:5] > after),
                   key=lambda t: str(t.get("fixed_time")))
    return timed[0] if timed else None


async def morning_alarm(phone: str, day: list, wake: Optional[str]) -> tuple:
    """(the first task of the coming morning, the alarm hour) or (None, None).

    The coming morning: before 05:00 it is today's; later, today's if its first
    task is still ahead and in the morning, else tomorrow's. The hour: the one
    she said; none said ("auto") → the day's wake time from day_plan (her
    stored route and routine), else its start less her morning routine."""
    now = _tz.now_il()
    hm, today = now.strftime("%H:%M"), now.date()
    first = _first_on(day, today.isoformat()) if hm < "05:00" else None
    if not first:
        t = _first_on(day, today.isoformat(), after=hm)
        first = t if t and str(t.get("fixed_time"))[:5] < MORNING_ENDS else None
    if not first:
        first = _first_on(day, (today + _timedelta(days=1)).isoformat())
    if not first:
        return None, None
    if wake and str(wake).lower() != "auto":
        return first, str(wake)[:5]
    try:
        prof = user_profile.get_profile(phone) or {}
    except Exception:  # noqa: BLE001
        prof = {}
    routine = int(prof.get("morningRoutineMinutes") or 45)
    date_iso = str(first.get("date"))[:10]
    try:
        import day_plan
        rows = []
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            rows = await supabase_tasks.tasks_for_user(uid, date_iso, date_iso, include_location=True)
        plan = await day_plan.plan_day(rows or [t for t in day if str(t.get("date"))[:10] == date_iso],
                                       date=date_iso, home=prof.get("homeAddress"), routine_minutes=routine,
                                       now=hm if date_iso == today.isoformat() else None)
        if plan.get("wake_by"):
            return first, plan["wake_by"]
    except Exception as exc:  # noqa: BLE001 — the start less the routine is still an answer
        logger.warning("morning alarm: day plan failed, using start − routine: %s", exc)
    h, m = (int(x) for x in str(first["fixed_time"])[:5].split(":"))
    at = max(0, h * 60 + m - routine)
    return first, f"{at // 60:02d}:{at % 60:02d}"


def _alarm_target(day: list, history: list) -> Optional[dict]:
    """The task an alarm on its own is for: the one Meira just confirmed, else
    the next timed task still ahead (today, then tomorrow)."""
    titles = [t for t, _ in _recent_saves(history, _tz.now_il())]
    by_title = {str(t.get("text") or "").strip(): t for t in day}
    for title in titles:
        if title in by_title:
            return by_title[title]
    now = _tz.now_il()
    today, now_hm = now.date().isoformat(), now.strftime("%H:%M")
    ahead = sorted((t for t in day if t.get("fixed_time") and (
        str(t.get("date") or "")[:10] > today
        or (str(t.get("date") or "")[:10] == today and str(t.get("fixed_time"))[:5] > now_hm))),
        key=lambda t: f"{t.get('date')} {t.get('fixed_time')}")
    return ahead[0] if ahead else None


def without_guard_notes(text: str) -> str:
    """The reply without the anti-fabrication guard's "nothing was saved" lines."""
    import lumi_agent
    notes = {*lumi_agent._NOTHING_NOW.values(), *lumi_agent._NOT_SAVED.values()}
    kept = [line for line in (text or "").splitlines() if line.strip() not in notes]
    return "\n".join(kept).strip()


_CORRECTION_RE = _re.compile(
    r"^\s*(?:כן|לא|בעצם|אה|רגע|yes|no|actually|oh|sorry)?[\s,.!]*"
    r"(?P<when>(?:ב?יום\s+\S+|מחרתיים|מחר|היום|on\s+\w+|\w+day|tomorrow|today))"
    r"(?P<at>\s+(?:ב-?|at\s+)?\s*[\d\u0590-\u05FF:. ]{1,24}?)?[\s.!?@]*$", _re.I)
_SAVED_LINE_RE = _re.compile(r"(?:שמרתי|קבעתי|נשמר|עדכנתי|Saved|Done —|Updated)\s*:?\s*(?P<title>[^·\n✓]+?)\s*·")


async def date_correction(phone: str, content: str, history: list) -> tuple:
    """A new DAY for the task Meira just saved. -> (saved, note) or ([], "").

    Only a message that is nothing but a day ("כן ביום שלישי", "actually
    tomorrow") right after a reply that saved or updated one task. The day is
    resolved by code, at her hour (tz.resolve_date_at)."""
    m = _CORRECTION_RE.match(content or "")
    if not m:
        return [], ""
    last = next((t.get("content") for t in reversed(history or [])
                 if t.get("role") == "assistant" and t.get("content")), "")
    titles = [t.group("title").strip() for t in _SAVED_LINE_RE.finditer(str(last))]
    if len(titles) != 1:
        return [], ""
    target_date = _tz.resolve_date_at(m.group("when"))
    if not target_date:
        return [], ""
    day = await _her_days(phone)
    task = next((t for t in day if str(t.get("text") or "").strip() == titles[0]), None)
    if not task:
        logger.warning("date correction: the task Meira just saved is not on her days")
        return [], ""
    patch = {"date": target_date.isoformat()}
    if m.group("at"):
        # "היום ב9 וחצי": the hour too — read by code, the same reader the rest uses.
        import task_extract
        hhmm = task_extract.parse_clock_time(task_extract.spoken_hours(m.group("at")))
        if not hhmm:
            return [], ""
        patch["fixed_time"] = hhmm
    he = bool(_re.search(r"[\u0590-\u05FF]", content or ""))
    try:
        user_memory.update_task(phone, task["id"], patch)
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid and not await supabase_tasks.update_task(uid, str(task["id"]), patch):
            raise RuntimeError("the task is not in the cloud (deleted on the phone?)")
    except Exception as exc:  # noqa: BLE001 — say it failed, never claim it
        logger.warning("date correction failed: %s", exc)
        return [], ("לא הצלחתי להעביר את המשימה — נסי שוב" if he else "Couldn't move it — try again")
    updated = {**task, **patch}
    when = f"{target_date.day}.{target_date.month}"
    note = (f"עדכנתי: {updated.get('text')} · {updated.get('fixed_time') or ''} {when} ✓" if he
            else f"Updated: {updated.get('text')} · {updated.get('fixed_time') or ''} {when} ✓")
    return [updated], note
def confirm_outgoing(history_key: str, content: str) -> Optional[str]:
    """Her yes / no to a drafted message for someone else, before any model.

    The only path that schedules an outgoing message (outgoing_confirm). Both
    doors call it first: the app/MCP turn here, the WhatsApp webhook in main.
    """
    try:
        reply = outgoing_confirm.answer(history_key, content, reminders.schedule_outgoing,
                                        user_memory.save_contact)
    except Exception as exc:  # noqa: BLE001 — nothing is sent; the turn runs normally
        logger.warning("outgoing confirmation step failed: %s", exc)
        return None
    if reply:
        try:
            conversation.append(history_key, content, reply)
        except Exception as exc:  # noqa: BLE001
            logger.warning("confirmation not kept in history: %s", exc)
    return reply


def meira_just_asked(history_key: str) -> bool:
    """Did Meira's last reply end on a question? Then this message is an ANSWER.

    Koral, 2026-09-28: Meira asked when to fit the CV task in, she answered
    "לפני האימון ולפני הקריוקי", the model saved nothing — and the rescue saved
    her answer as a new flexible task. An answer is not an instruction."""
    try:
        hist = conversation.get_history(history_key) if history_key else []
    except Exception as exc:  # noqa: BLE001 — no history means no question pending
        logger.warning("history unreadable for the answer check: %s", exc)
        return False
    last = next((t for t in reversed(hist or []) if t.get("role") == "assistant"), None)
    return bool(last) and "?" in str(last.get("content") or "")[-240:]


async def rescue_turn(phone: str, content: str, channel: str = "app",
                      answering: bool = False) -> tuple:
    """Save what the turn dropped, and say what happened. -> (tasks, note)

    Three outcomes, all of which end with the thing existing:

      same intent already open  -> UPDATE it with the new when/where, rather
                                   than leaving two nearly-identical tasks
      might be the same         -> save the new one AND ask, because losing a
                                   task to a wrong guess is worse than one
                                   extra question
      new                       -> create it; if it has no hour, offer three

    One message can hold several things ("\u05D0\u05D9\u05DE\u05D5\u05DF \u05D1 6 \u05D1\u05E2\u05E8\u05D1 \u05E2\u05D3 8 \u05D1\u05E2\u05E8\u05D1 / \u05D0\u05D7\u05E8 \u05DB\u05DA
    \u05E7\u05E8\u05D9\u05D5\u05E7\u05D9 \u05D1\u05D0\u05DC\u05E0\u05D1\u05D9 30"), and each is rescued on its own \u2014 saving them as one
    task with both lines as its title and neither hour is the bug this fixes.
    A day named once ("\u05D4\u05D9\u05D5\u05DD: \u2026", "\u05DE\u05D7\u05E8 \u2026") applies to every line under it.
    """
    try:
        existing = user_memory.tasks_for_phone(phone)
    except Exception:  # noqa: BLE001
        existing = []

    he = bool(_re.search(r"[\u0590-\u05FF]", content))
    named = _re.findall(_tz.REL_DATE_RE, content or "")
    day = _tz.resolve_date_at(named[0]) if named else None
    saved_all: list = []
    notes: list = []
    for clause in task_rescue.clauses(content):
        if answering and not task_rescue.clock_time(clause):
            # Replying to her question. Only a line with its own hour is new
            # enough to be a task in its own right ("וגם רופא ב-10").
            continue
        saved, note = await _rescue_one(phone, clause, existing, channel, he,
                                        day.isoformat() if day else None)
        saved_all.extend(saved)
        if note:
            notes.append(note)
    return saved_all, "\n".join(notes)


async def _rescue_one(phone: str, content: str, existing: list, channel: str,
                      he: bool, default_date: Optional[str]) -> tuple:
    """rescue_turn for ONE clause of the message. -> (tasks, note)"""
    rescued = task_rescue.rescue(content, existing, default_date=default_date)
    if not rescued:
        return [], ""

    match, score, embedded = await task_rescue.find_same_intent(
        rescued.get("text", ""), existing)

    # ── already have it: move it, don't clone it ──
    # The bar depends on which scorer ran: embedding cosine is compressed into
    # a narrow band where 0.91 can still be two different workouts.
    if match and score >= task_rescue.same_threshold(embedded):
        patch = task_rescue.changed_fields(match, rescued)
        if not patch:
            return [], (f"כבר יש לך את זה: {match.get('text')}" if he
                        else f"You already have that: {match.get('text')}")
        try:
            user_memory.update_task(phone, match.get("id"), patch)
            uid = await supabase_tasks.user_id_for_phone(phone)
            if uid:
                await supabase_tasks.update_task(uid, str(match.get("id")), patch)
        except Exception as exc:  # noqa: BLE001
            logger.warning("intent-match update failed: %s", exc)
        when = " ".join(str(patch.get(f)) for f in ("date", "fixed_time") if patch.get(f))
        return [{**match, **patch}], (f"עדכנתי את '{match.get('text')}' ל-{when}" if he
                                      else f"Updated '{match.get('text')}' to {when}")

    saved = await persist_agent_tasks(phone, content, {"tasks": [rescued]}, channel)

    lines = []
    # ── might be the same thing: save anyway, then ask ──
    if match:   # above the ask bar, below the merge bar
        lines.append(
            f"יש לך כבר '{match.get('text')}' — זו אותה משימה? אאחד אותן אם כן."
            if he else
            f"You already have '{match.get('text')}' — is this the same one? I'll merge them if so.")

    # ── no hour: fine. A task with no hour is a flexible one and the day's
    # plan places it. Asking "when should it go?" was a question per task, and
    # her ANSWER ("לפני האימון ולפני הקריוקי") was then saved as a task. ──
    if not rescued.get("fixed_time") and not rescued.get("date"):
        lines.append("שמרתי במשימות הכלליות ✓" if he else "Saved to your general tasks ✓")

    return saved, "\n".join(lines)
