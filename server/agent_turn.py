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

import logging
import re as _re
from datetime import timedelta as _timedelta
from typing import Optional

import clashes
import conversation
import provenance
import session
import task_grouping
import task_rescue
import supabase_tasks
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
    """
    matches = _re.findall(_tz.REL_DATE_RE, content or "")
    if len(matches) != 1:
        return task
    resolved = _tz.resolve_date(matches[0])
    if not resolved or task.get("date") == resolved.isoformat():
        return task
    logger.warning("task date corrected %s -> %s (from %r)",
                   task.get("date"), resolved.isoformat(), matches[0])
    return {**task, "date": resolved.isoformat()}


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
            logger.warning("task %r is already planned as %r — %s", str(task.get("text"))[:40],
                           str(twin.get("text"))[:40], f"updating {sorted(patch)}" if patch else "unchanged")
            if patch:
                try:
                    user_memory.update_task(phone, twin["id"], patch)
                    if uid:
                        await supabase_tasks.update_task(uid, str(twin["id"]), patch)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("duplicate update failed: %s", exc)
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
    where = f"{label} ({lat:.5f},{lng:.5f})" if label else f"{lat:.5f},{lng:.5f}"
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
    "Reply in ONE short sentence.] "
)


def _mode_stamp(mode: Optional[str]) -> str:
    """The per-turn instruction for a known app mode, or "" for anything else."""
    return VOICE_PLAN_STAMP if mode == "voice_plan" else ""


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


async def run_turn(
    phone: str,
    content: str,
    user: dict,
    learned: Optional[dict] = None,
    channel: str = "app",
    here: Optional[dict] = None,
    mode: Optional[str] = None,
    profile: Optional[dict] = None,
) -> dict:
    """A full turn: agent + persistence. Returns {'text', 'tasks', 'departures'}.

    `now` is stamped INSIDE the user turn because that is the only clock the
    model reliably reads — the system prompt's was ignored. `here` rides along
    the same way, so "how do I get there from here" has an origin: without it
    every route the agent planned started at her stored home address, however
    far from it she was standing, and said nothing about the substitution.
    """
    stamped = (
        f"[נשלח עכשיו ב-{_tz.now_il().strftime('%H:%M')}] "
        f"{_here_stamp(here)}{_mode_stamp(mode)}{content}"
    )
    if isinstance(profile, dict) and profile:
        # Under the SAME key the agent reads the profile with — the user
        # record's id, not the storage key this turn was called with.
        sync_app_profile(str(user.get("id") or user.get("whatsapp_phone") or phone), profile)
    # Read BEFORE the turn: afterwards the history's last reply is this one.
    # The app's mic is never an answer: she pressed it to add to her day. On
    # 28.9 "שיחה עם דותן משתיים עד שתיים וחצי" followed a reply that ended in
    # "?", so the rescue treated it as an answer, skipped it — nothing saved.
    history_key = str(user.get("id") or user.get("whatsapp_phone") or phone)
    answering = mode != "voice_plan" and meira_just_asked(history_key)
    try:
        history = list(conversation.get_history(history_key) or [])
    except Exception as exc:  # noqa: BLE001 — no history: the message alone is read
        logger.warning("history unreadable for understanding: %s", exc)
        history = []
    # THE MIC: UNDERSTAND, THEN ACT, THEN TALK. The agent loop was deciding
    # what to save AND writing the reply in one go, and on 28.9 it wrote a
    # lovely schedule and saved nothing. On the app's mic a model now reads
    # the conversation and names the actions, code carries them out, and the
    # agent is told what was done — so its reply can only confirm reality.
    first: list = []
    first_note, understood_first = "", False
    if mode == "voice_plan":
        first, first_note, understood_first = await act_on_understanding(
            phone, content, channel, history)
        if understood_first:
            done = "; ".join(f"{t.get('text')} {t.get('date') or ''} {t.get('fixed_time') or ''}".strip()
                             for t in first) or "nothing — she asked for nothing to be saved"
            asked = next((l for l in first_note.splitlines() if l.rstrip().endswith("?")), "")
            stamped = (f"[ALREADY DONE BY THE APP, do NOT save these again: {done}. "
                       + (f"The app is asking her: '{asked}' — do NOT guess the answer or save "
                          f"the unclear item; wait for her reply. " if asked else "")
                       + f"Confirm in one short sentence; only act on anything else she asked.] "
                       f"{stamped}")
    response = await handle_whatsapp_message(stamped, user, learned, here=here)
    saved = first + [t for t in await persist_agent_tasks(phone, content, response, channel)
                     if str(t.get("id")) not in {str(f.get("id")) for f in first}]

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
        saved, note, understood = await act_on_understanding(phone, content, channel, history)
        if not understood:
            saved, note = await rescue_turn(phone, content, channel, answering=answering)

    clash = await clash_note(phone, saved, he=bool(_re.search(r"[\u0590-\u05FF]", content or "")))
    if clash:
        note = f"{note}\n{clash}".strip()

    text = response.get("text", "")
    if note:
        text = f"{text}\n\n{note}".strip()
    return {
        "text": text,
        "type": response.get("type"),
        "tasks": saved,
        "departures": response.get("departures") or [],
    }


_DONE = {"complete", "completed", "cancelled", "deleted", "archived", "moved", "missed"}


def _short_date(iso: str) -> str:
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
        return f"{d}.{m}"
    except ValueError:
        return iso


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
    try:
        uid = await supabase_tasks.user_id_for_phone(phone)
        if uid:
            for t in await supabase_tasks.tasks_for_user(uid, today.isoformat(), until):
                found[str(t.get("id"))] = t
    except Exception as exc:  # noqa: BLE001
        logger.warning("understanding: her day unreadable from Supabase: %s", exc)
    try:
        for t in user_memory.tasks_for_phone(phone):
            d = str(t.get("date") or "")[:10]
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
    return f"שמרתי: {task.get('text')} · {when} ✓" if he else f"Saved: {task.get('text')} · {when} ✓"


async def act_on_understanding(phone: str, content: str, channel: str,
                               history: list) -> tuple:
    """Understand the message in its conversation, then do it. -> (saved, note, understood)

    `understood` False means the model step could not run — the caller falls
    back on the regex rescue. True with nothing saved means she asked for
    nothing to be saved, and nothing is."""
    he = bool(_re.search(r"[\u0590-\u05FF]", content or ""))
    day = await _her_days(phone)
    result = await _understand.understand(content, history, day)
    if result is None:
        return [], "", False
    saved: list = []
    lines: list = []
    tasks = [t for t in (_understand.task_from(a, content) for a in result["actions"]
                         if a.get("do") == "add") if t]
    if tasks:
        saved = await persist_agent_tasks(phone, content, {"tasks": tasks}, channel)
        lines += [_said_saved(t, he) for t in saved]
    by_id = {str(t.get("id")): t for t in day}
    uid = None
    for action in result["actions"]:
        if action.get("do") != "update":
            continue
        target = by_id.get(str(action.get("task_id")))
        patch = _understand.patch_from(action)
        if not target or not patch:
            logger.warning("understanding: update skipped (id %r known=%s, patch=%s)",
                           action.get("task_id"), bool(target), sorted(patch))
            continue
        try:
            user_memory.update_task(phone, target["id"], patch)
            uid = uid or await supabase_tasks.user_id_for_phone(phone)
            if uid:
                await supabase_tasks.update_task(uid, str(target["id"]), patch)
        except Exception as exc:  # noqa: BLE001 — say it failed, don't claim it
            logger.warning("understanding: update failed: %s", exc)
            lines.append(f"לא הצלחתי לעדכן את '{target.get('text')}'" if he
                         else f"Couldn't update '{target.get('text')}'")
            continue
        updated = {**target, **patch}
        saved.append(updated)
        lines.append(f"עדכנתי: {updated.get('text')} · {updated.get('fixed_time') or ''} ✓".strip()
                     if he else f"Updated: {updated.get('text')} · {updated.get('fixed_time') or ''} ✓")
    if result.get("ask"):
        # Unclear → one question, last, ending in "?" — the app shows it as
        # the thing to answer, and the next message is read as that answer.
        q = result["ask"].rstrip(" ?？") + "?"
        lines.append(q)
    return saved, "\n".join(lines), True


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
    day = _tz.resolve_date(named[0]) if named else None
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
