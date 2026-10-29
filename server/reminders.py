"""Persistent reminder scheduler.

Reminders are written to a JSON file and fired by a single background poller, so
they SURVIVE server restarts (the old in-memory asyncio timers were wiped every
time we restarted — that's why reminders "disappeared"). The poller checks every
~20s and sends any that are due.

The native phone alarm is still a mobile-app job; this nudges over WhatsApp.

Dependencies: config (DATA_DIR), whatsapp_service (delivery), push +
user_store (mirror each reminder to the app when an Expo token is
registered via POST /push/register). schedule_departures is called by
main.whatsapp_webhook with plans produced by geo.plan_departure; the poller
run_reminder_loop is started once in main.lifespan.
"""
import asyncio
import json
import logging
import os
from datetime import datetime, date, time as dtime, timedelta

from whatsapp_service import WhatsAppService
import config
import database_service
import secure_store
import push
from user_store import DatabaseService
from tz import IL, now_il, today_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "reminders.json")
_POLL_SECONDS = 20
# How recently the app must have registered its push token for the server to
# treat it as the owner of departure alerts. See _app_owns_departures.
_APP_ALIVE_DAYS = 14


def _load() -> list:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: task text, times, phone numbers. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, [])


def _save(items) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, items)


def _aware(dt: datetime) -> datetime:
    """Attach Israel local time to a legacy naive datetime read from disk (rows
    persisted before the tz fix). Aware datetimes pass through unchanged."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=IL)


def _dest_key(destination: str) -> str:
    return (destination or "").strip().lower()


def schedule(phone: str, hhmm: str, text: str, day: str | None = None,
             dest_key: str | None = None, kind: str | None = None) -> bool:
    """Persist a reminder to fire at HH:MM (Israel local) on `day` (YYYY-MM-DD,
    defaults to today). Skips past datetimes & duplicates — so a future-dated
    appointment fires on the RIGHT day, never today. `dest_key` (when given)
    tags the row with its appointment identity so a later re-plan can find and
    supersede it via _cancel_pending. `kind` marks what this reminder IS —
    "departure" rows are the ones the mobile app also alerts for locally, and
    the poller stands down on them (see _app_owns_departures)."""
    try:
        h, m = (int(x) for x in hhmm.split(":"))
    except (ValueError, AttributeError):
        return False
    try:
        d = date.fromisoformat(day) if day else today_il()
    except (ValueError, TypeError):
        d = today_il()
    fire_at = datetime.combine(d, dtime(hour=h, minute=m), tzinfo=IL)
    if fire_at <= now_il():
        return False
    key = f"{phone}|{fire_at.isoformat(timespec='minutes')}"
    items = _load()
    if any(it.get("key") == key for it in items):
        return False
    row = {
        "key": key, "phone": phone, "fire_at": fire_at.isoformat(), "text": text, "sent": False,
        "dest_key": dest_key, "day": d.isoformat(),
    }
    if kind:
        row["kind"] = kind
    items.append(row)
    _save(items)
    # Shadowed into Postgres (lumi_reminders). The FILE still drives the poller —
    # moving the firing loop onto the table is a separate change with its own
    # failure mode, and a reminder that does not fire is the worst bug this
    # product has.
    database_service.shadow_write(database_service.save_reminder({
        "id": key, "userKey": phone, "text": text,
        "fireAt": fire_at.isoformat(), "kind": kind or "reminder",
        "payload": {"dest_key": dest_key, "day": d.isoformat()}, "sent": False,
    }))
    logger.info("reminder persisted at %s", hhmm)
    return True


def schedule_outgoing(owner_phone: str, to_phone: str, hhmm: str, day: str | None,
                      message: str, recipient_name: str = "") -> bool:
    """Persist a message Lumi will SEND TO SOMEONE ELSE at HH:MM on `day`
    ('write to אימוש happy birthday tomorrow 09:00'). The poller delivers it to
    `to_phone` and tells the owner whether it went out — WhatsApp only allows
    free-form messages inside a recipient's 24h reply window, so on failure the
    owner gets the text ready to forward instead. Skips past times/dupes."""
    try:
        h, m = (int(x) for x in hhmm.split(":"))
        d = date.fromisoformat(day) if day else today_il()
    except (ValueError, TypeError, AttributeError):
        return False
    fire_at = datetime.combine(d, dtime(hour=h, minute=m), tzinfo=IL)
    if fire_at <= now_il():
        return False
    to_digits = "".join(ch for ch in str(to_phone or "") if ch.isdigit())
    if not to_digits:
        return False
    key = f"out|{owner_phone}|{to_digits}|{fire_at.isoformat(timespec='minutes')}"
    items = _load()
    if any(it.get("key") == key for it in items):
        return False
    items.append({
        "key": key, "kind": "outgoing", "phone": owner_phone, "to_phone": to_digits,
        "recipient_name": recipient_name, "fire_at": fire_at.isoformat(),
        "text": message, "sent": False, "day": d.isoformat(),
    })
    _save(items)
    logger.info("outgoing message persisted for %s", fire_at)
    return True


def nudge_slots(now: datetime, until_hour: int = 20, gap_minutes: int = 90,
                max_slots: int = 6) -> list[str]:
    """Check-in times for 'nudge me today': first slot = next :00/:30 at least
    20 minutes away, then every `gap_minutes` until `until_hour`. Pure function
    (testable); consumed by main._try_nudge which schedules each slot."""
    first = now + timedelta(minutes=20)
    minute = first.minute
    if minute == 0 or minute == 30:
        pass
    elif minute < 30:
        first = first.replace(minute=30, second=0, microsecond=0)
    else:
        first = (first + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    slots = []
    t = first
    while t.hour < until_hour or (t.hour == until_hour and t.minute == 0):
        slots.append(t.strftime("%H:%M"))
        if len(slots) >= max_slots:
            break
        t += timedelta(minutes=gap_minutes)
    return slots


def _cancel_pending(phone: str, dest_key: str, day: str) -> None:
    """Drop any not-yet-sent reminders for this same appointment (phone +
    destination + date) before scheduling a fresh plan for it — otherwise
    re-planning mid-conversation (different transport, re-confirmed origin,
    live Directions returning a slightly different ETA) stacks multiple
    stale one-shot reminders that all fire independently."""
    items = _load()
    kept = [
        it for it in items
        if it.get("sent")
        or it.get("phone") != phone
        or it.get("dest_key") != dest_key
        or it.get("day") != day
    ]
    if len(kept) != len(items):
        _save(kept)


def schedule_departures(phone: str, departures: list, language: str = "en") -> int:
    """Schedule wake + leave reminders for each planned departure. Returns count set.
    Supersedes any pending (unsent) reminders for the same appointment first."""
    n = 0
    for dep in departures or []:
        dest = dep.get("destination") or dep.get("destResolved") or "your appointment"
        # Resolve the date the same way schedule() does, so the key _cancel_pending
        # matches against is identical to what gets stored on the new rows below.
        try:
            day = date.fromisoformat(dep["date"]).isoformat() if dep.get("date") else today_il().isoformat()
        except (ValueError, TypeError):
            day = today_il().isoformat()
        dest_key = _dest_key(dest)
        _cancel_pending(phone, dest_key, day)
        if dep.get("wakeUpBy"):
            txt = (f"⏰ קום! יש לך {dest} ב-{dep.get('arriveBy','')}"
                   if language == "he"
                   else f"⏰ Wake up! {dest} at {dep.get('arriveBy','')}")
            n += int(schedule(phone, dep["wakeUpBy"], txt, day, dest_key, kind="departure"))
        if dep.get("leaveHomeBy"):
            mins = dep.get("travelMinutes", "")
            txt = (f"🚪 צא עכשיו ל{dest} (~{mins} דק')"
                   if language == "he"
                   else f"🚪 Leave now for {dest} (~{mins} min)")
            n += int(schedule(phone, dep["leaveHomeBy"], txt, day, dest_key, kind="departure"))
        # One hour ahead: ask for a live location so the route is recomputed
        # from wherever the user ACTUALLY is (office, previous meeting…) —
        # sharing a location routes automatically via the webhook.
        if dep.get("arriveBy"):
            try:
                h, m = (int(x) for x in str(dep["arriveBy"]).split(":"))
                total = (h * 60 + m - 60) % (24 * 60)
                hour_before = f"{total // 60:02d}:{total % 60:02d}"
                txt = (f"⏳ בעוד שעה: {dest} ב-{dep['arriveBy']}. שתפ/י מיקום 📍 "
                       "ואחשב מאיפה שאת/ה את הדרך הכי מהירה 🚌🚆🚲"
                       if language == "he"
                       else f"⏳ In 1 hour: {dest} at {dep['arriveBy']}. Share your "
                            "location 📍 and I'll route you from wherever you are 🚌🚆🚲")
                n += int(schedule(phone, hour_before, txt, day, dest_key, kind="departure"))
            except (ValueError, AttributeError):
                pass
    return n


def pending_for(phone: str) -> list:
    """Upcoming reminders for a phone (for Lumi to confirm what's set)."""
    now = now_il()
    out = []
    for it in _load():
        if it.get("phone") != phone or it.get("sent"):
            continue
        try:
            if _aware(datetime.fromisoformat(it["fire_at"])) > now:
                out.append({"time": it["fire_at"][11:16], "text": it["text"]})
        except (ValueError, KeyError):
            continue
    return sorted(out, key=lambda x: x["time"])


async def _app_owns_departures(phone: str) -> bool:
    """Is the mobile app the one alerting this phone about departures?

    A departure produced THREE pings on the same phone: the app's own local
    notification (NotificationService.scheduleTransitNotifications plans wake /
    leave / "still at home?" from the same route), an Expo push carrying this
    reminder's text, and the WhatsApp message. Same event, same minute, three
    times — which is what "notifications appear 3 times" was.

    A registered Expo push token means the app is installed and linked, and its
    alert is strictly the better one: it carries the route, opens the LeaveNow
    screen and has the "יצאתי ✓" button that silences the follow-ups. So the
    server stands down and the app owns it.

    Fails OPEN. If the token lookup errors we deliver — a reminder that does not
    fire is a far worse bug than one that fires twice.
    """
    if not config.APP_OWNS_DEPARTURE_ALERTS:
        return False
    try:
        if not await DatabaseService.get_push_token_by_phone(phone):
            return False
        # A token alone is not proof the app is still installed. It re-registers
        # on every launch, so a stamp older than this means nobody has opened it
        # in a fortnight — deliver over WhatsApp rather than trust it.
        age = await DatabaseService.push_token_age_days(phone)
        return age is not None and age <= _APP_ALIVE_DAYS
    except Exception as exc:  # noqa: BLE001 — DB down: deliver rather than go silent
        logger.debug("push-token lookup failed for %s: %s", phone, exc)
        return False


async def _push_if_registered(phone: str, text: str) -> None:
    """Also notify the app if this phone registered an Expo push token. Best-effort."""
    try:
        token = await DatabaseService.get_push_token_by_phone(phone)
        if token:
            await push.send_push(token, "Lumi ⏰", text)
    except Exception as exc:  # noqa: BLE001 — DB down or push failed; WhatsApp already sent
        logger.debug("push skipped for %s: %s", phone, exc)


import re as _re
from difflib import SequenceMatcher

# "👊 <subject> — started? …" / "👊 <subject> — התחלת? …" — a check-in ping.
_CHECKIN_RE = _re.compile(r"👊\s*(.+?)\s*[—-]\s*(?:started\?|התחלת\?)", _re.IGNORECASE)


def _is_stale_checkin(it: dict) -> bool:
    """True if this reminder is a check-in whose subject task no longer exists as
    an active today-or-future task — a stale ping scheduled before the subject fix."""
    m = _CHECKIN_RE.search(it.get("text", "") or "")
    if not m:
        return False
    subject = m.group(1).strip()
    try:
        import user_memory
        from tz import today_il
        today = today_il().isoformat()
        active = [t.get("text", "") for t in user_memory.tasks_for_phone(it.get("phone", ""))
                  if t.get("status") not in ("moved", "complete") and str(t.get("date", "")) >= today]
    except Exception:  # noqa: BLE001 — if we can't check, don't drop
        return False
    return not any(SequenceMatcher(None, subject, txt).ratio() >= 0.6 for txt in active)


async def run_reminder_loop() -> None:
    """Background poller: fire due reminders, drop old/sent ones. Started in lifespan."""
    while True:
        try:
            now = now_il()
            items = _load()
            changed = False
            keep = []
            for it in items:
                try:
                    fire_at = _aware(datetime.fromisoformat(it["fire_at"]))
                except (ValueError, KeyError):
                    changed = True
                    continue  # drop malformed
                if it.get("sent"):
                    # keep sent ones for the rest of the day to avoid resends
                    if (now - fire_at).total_seconds() < 6 * 3600:
                        keep.append(it)
                    else:
                        changed = True
                    continue
                if fire_at <= now:
                    if _is_stale_checkin(it):
                        # A check-in whose task is gone/past (scheduled before the
                        # subject-resolution fix) — drop it instead of pinging about
                        # an old class.
                        logger.info("dropped a stale check-in")
                        changed = True
                        continue
                    if it.get("kind") == "departure" and await _app_owns_departures(it["phone"]):
                        # The app already rang for this trip — see
                        # _app_owns_departures. Marked sent, not dropped, so the
                        # row still supersedes correctly and shows in pending_for.
                        logger.info("departure reminder left to the app -> %s: %s",
                                    it["phone"], it.get("text", "")[:50])
                        it["sent"] = True
                        changed = True
                        if it.get("key"):
                            database_service.shadow_write(
                                database_service.mark_reminder_sent(it["key"]))
                        keep.append(it)
                        continue
                    if it.get("kind") == "outgoing":
                        # Scheduled message TO SOMEONE ELSE: deliver, then tell
                        # the owner what happened (24h-window sends can fail).
                        who = it.get("recipient_name") or it.get("to_phone", "")
                        ok = await WhatsAppService.send_message(it["to_phone"], it["text"])
                        note = (
                            f"✅ Sent to {who}: {it['text']}"
                            if ok
                            else f"⚠️ Couldn't deliver to {who} (WhatsApp only allows me to "
                                 f"message people who wrote to me recently). Forward it yourself:\n{it['text']}"
                        )
                        await WhatsAppService.send_message(it["phone"], note)
                        await _push_if_registered(it["phone"], note)
                        logger.info("outgoing fired -> %s (ok=%s)", it.get("to_phone"), ok)
                    else:
                        await WhatsAppService.send_message(it["phone"], it["text"])
                        await _push_if_registered(it["phone"], it["text"])
                        logger.info("reminder fired")
                    it["sent"] = True
                    changed = True
                    if it.get("key"):
                        database_service.shadow_write(
                            database_service.mark_reminder_sent(it["key"]))
                    keep.append(it)
                else:
                    keep.append(it)
            if changed:
                _save(keep)
        except Exception as exc:  # noqa: BLE001 — never let the poller die
            logger.warning("reminder loop tick failed: %s", exc)
        await asyncio.sleep(_POLL_SECONDS)
