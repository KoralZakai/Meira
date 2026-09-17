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
from typing import Optional

import provenance
import session
import task_grouping
import task_rescue
import supabase_tasks
import user_profile
import tz as _tz
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

    saved: list = []
    for task in tasks:
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


async def run_turn(
    phone: str,
    content: str,
    user: dict,
    learned: Optional[dict] = None,
    channel: str = "app",
    here: Optional[dict] = None,
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
        f"{_here_stamp(here)}{content}"
    )
    response = await handle_whatsapp_message(stamped, user, learned)
    saved = await persist_agent_tasks(phone, content, response, channel)

    # LAST LINE OF DEFENCE. If the turn saved nothing and updated nothing, but
    # the message plainly asks for something, save it from the user's own words.
    # Guarding the model's PROSE was a losing game — block "עודכן" and it writes
    # "ממתינה" — because the argument was about wording while the user's problem
    # was that the task did not exist. See task_rescue.
    note = ""
    if not saved and not (response.get("updates") or []):
        saved, note = await rescue_turn(phone, content, channel)

    text = response.get("text", "")
    if note:
        text = f"{text}\n\n{note}".strip()
    return {
        "text": text,
        "type": response.get("type"),
        "tasks": saved,
        "departures": response.get("departures") or [],
    }


async def rescue_turn(phone: str, content: str, channel: str = "app") -> tuple:
    """Save what the turn dropped, and say what happened. -> (tasks, note)

    Three outcomes, all of which end with the thing existing:

      same intent already open  -> UPDATE it with the new when/where, rather
                                   than leaving two nearly-identical tasks
      might be the same         -> save the new one AND ask, because losing a
                                   task to a wrong guess is worse than one
                                   extra question
      new                       -> create it; if it has no hour, offer three
    """
    try:
        existing = user_memory.tasks_for_phone(phone)
    except Exception:  # noqa: BLE001
        existing = []

    rescued = task_rescue.rescue(content, existing)
    if not rescued:
        return [], ""

    he = bool(_re.search(r"[\u0590-\u05FF]", content))
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

    # ── no hour yet: a decision not made, not a failure. Offer three. ──
    if not rescued.get("fixed_time"):
        date_iso = rescued.get("date")
        if date_iso:
            slots = task_rescue.free_slots(existing, date_iso, _tz.now_il().strftime("%H:%M"))
            if slots:
                lines.append(
                    f"אין שעה עדיין — פנוי ב-{' / '.join(slots)}. לקבוע לאחת מהן?"
                    if he else
                    f"No time yet — you're free at {' / '.join(slots)}. Want one of those?")
        else:
            lines.append("שמרתי במשימות הכלליות, בלי תאריך. מתי לשבץ?"
                         if he else "Saved to your general tasks, with no date. When should it go?")

    return saved, "\n".join(lines)
