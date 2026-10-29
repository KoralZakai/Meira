"""Supabase bridge — writes/reads the SAME `tasks` table the mobile + web apps
use, so a task created over WhatsApp shows up everywhere (and the agent sees
tasks created in the app).

Identity: the app mirrors AppSettings (incl. the linked WhatsApp number) into
`app_settings."whatsAppPhone"` (migration 0003); `user_id_for_phone` maps an
inbound WhatsApp phone to that row's auth userId. Everything here is
best-effort: no SUPABASE_URL/SERVICE_ROLE_KEY configured (or no phone mapping)
=> None/False/[] and the caller falls back to user_memory / DatabaseService.

Dependencies: httpx (already in requirements), config. Consumed by main.py
(webhook task persist) and lumi_agent.get_my_tasks.
"""
import hashlib
import json
import logging
import os
import time
import re
import uuid
from typing import Optional

import httpx

import config
import secure_store
from user_memory import text_similarity

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
logger = logging.getLogger("lumi.supabase")

_TIMEOUT = 8.0
_PENDING_PATH = os.path.join(config.DATA_DIR, "pending_mirror.json")


def _enabled() -> bool:
    return bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY)


def _headers() -> dict:
    key = config.SUPABASE_SERVICE_ROLE_KEY
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _rest(path: str) -> str:
    return f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/{path}"


def _pg_reason(body: str) -> str:
    """A Postgres error WITHOUT the row. 'Failing row contains (…)' echoes the
    whole task — text, place, time — into the Fly logs."""
    try:
        import json as _json
        err = _json.loads(body or "{}")
        return f"{err.get('code')}: {str(err.get('message') or '')[:120]}"
    except Exception:  # noqa: BLE001
        return "(unparsed error body)"


def _digits(phone: str) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _same_phone(a: str, b: str) -> bool:
    """Are these the same number, written differently?

    The queue is written with whatever form the webhook carried ("0542902729")
    and flushed with whatever form the caller passed ("972542902729"). Strict
    equality made every such pair invisible to each other, so tasks queued
    while the phone was unlinked stayed queued forever while /link/verify
    happily answered {"linked": true, "flushed": 0} — a success with no effect,
    which reads as "nothing to do" and means "37 stranded and unseen".

    Last nine digits, the same rule user_id_for_phone already uses to resolve
    the account: long enough to be the subscriber number in both the local and
    international forms, short enough to survive the country prefix.
    """
    da, db = _digits(a), _digits(b)
    if not da or not db:
        return False
    if da == db:
        return True
    if len(da) < 9 or len(db) < 9:
        return False
    return da[-9:] == db[-9:]


def _source_of(task: dict) -> str:
    """The `source` column value for a task, from its provenance envelope."""
    prov = task.get("provenance")
    if isinstance(prov, dict) and prov.get("channel"):
        try:
            import provenance
            return provenance.to_source(prov["channel"])
        except Exception:  # noqa: BLE001
            pass
    return "whatsapp"


def _legacy_task_id(text: str, date: str) -> str:
    """OLD "wa_" + sha1 id scheme — kept ONLY to match pre-migration rows.
    New ids are UUIDs minted once (by user_memory.add_task) and kept for the
    task's lifetime, so a text/date edit no longer forks a duplicate row."""
    return "wa_" + hashlib.sha1(f"{text}|{date}".encode("utf-8")).hexdigest()[:12]


async def user_id_for_phone(phone: str) -> Optional[str]:
    """The auth userId this number is VERIFIABLY linked to (phone_links), or None.

    7.10 audit: this used to read app_settings."whatsAppPhone" — a column the
    user writes herself — with a last-9-digits suffix match. Anyone who typed a
    stranger's number became her. Now only a number that proved itself by
    sending the link code from WhatsApp resolves, and only by exact digits."""
    # An app-only account (no WhatsApp linked) is keyed by its VERIFIED
    # Supabase user id — app_auth.identify sets key = phone or userId.
    if _UUID_RE.match(str(phone or "").strip()):
        return str(phone).strip().lower()
    digits = _digits(phone)
    if not digits:
        return None
    try:
        import phone_links
        return phone_links.user_for(digits)
    except Exception as exc:  # noqa: BLE001 — unreadable links resolve nobody
        logger.warning("user_id_for_phone failed: %s", exc)
        return None


# The tasks table constrains priority and status to a closed set (migration
# 0001). A value outside it does not fail loudly — Postgres rejects the whole
# row with 23514, upsert_task logs a warning and returns None, and main.py's
# caller treats that as "nothing to report". The task is simply gone from the
# cloud while the phone shows 200 OK.
#
# That is not hypothetical: on 2026-09-10 "לעשות lean canvas model" was written
# with priority='high' — a value nothing in categorize.py can produce, so it
# came from the model — and vanished. Clamping HERE rather than at each caller
# is deliberate: this function is the only door to the table, so a synonym
# invented by a future prompt cannot cost a task.
_PRIORITY_ALIASES = {
    "must": "must", "high": "must", "urgent": "must", "critical": "must",
    "asap": "must", "highest": "must", "p0": "must", "p1": "must",
    "have_to": "have_to", "have to": "have_to", "important": "have_to",
    "need_to": "need_to", "need to": "need_to", "medium": "need_to",
    "normal": "need_to", "default": "need_to", "p2": "need_to",
    "nice_to_do": "nice_to_do", "nice to do": "nice_to_do", "low": "nice_to_do",
    "optional": "nice_to_do", "someday": "nice_to_do", "p3": "nice_to_do",
}
_VALID_STATUSES = ("pending", "complete", "missed", "moved", "partial")
_STATUS_ALIASES = {
    "done": "complete", "completed": "complete", "finished": "complete",
    "skipped": "missed", "postponed": "moved", "rescheduled": "moved",
    "in_progress": "partial", "started": "partial",
}


def _clamp_priority(value: object) -> str:
    """Any priority the DB will accept. Unknown words become 'need_to' — a task
    filed under the wrong urgency is recoverable; a task that never saved is not."""
    key = str(value or "").strip().lower()
    resolved = _PRIORITY_ALIASES.get(key)
    if resolved is None and key:
        logger.warning("unknown priority %r -> need_to", value)
    return resolved or "need_to"


def _clamp_status(value: object) -> str:
    """Same contract as _clamp_priority, for the status check constraint."""
    key = str(value or "").strip().lower()
    if key in _VALID_STATUSES:
        return key
    resolved = _STATUS_ALIASES.get(key)
    if resolved is None and key:
        logger.warning("unknown status %r -> pending", value)
    return resolved or "pending"


# ── sealed rows (7.10): what she will do, where and with whom is ciphertext ──
# One `sealed` column (migration 0014) holds these fields as AES-256-GCM JSON,
# under a key derived for THIS account (field_crypto "user:<id>") — the same key
# the app gets from POST /app/data-key, so phone and server read each other's
# rows. The plaintext columns are emptied and `text` reads PLACEHOLDER.
# A row whose `text` is NOT the placeholder was written by an older client in
# plaintext: plaintext wins, and the next sealed write absorbs it.
# SEAL_APP_ROWS=1 (fly.toml) turns it on — only after 0014 has run and every
# tester has the app build that understands sealed rows. Never back to 0.
SEALED_FIELDS = ("text", "location", "contact", "contactName", "contactPhone",
                 "attendees", "meetingUrl", "progress", "subtasks", "how", "why",
                 "locationLat", "locationLng")
PLACEHOLDER = "🔒"


def sealing_on() -> bool:
    import field_crypto
    return os.getenv("SEAL_APP_ROWS", "0") == "1" and field_crypto.enabled()


def open_task_row(user_id: str, row: dict) -> dict:
    """The row with its sealed fields restored; `_unreadable` if they will not open."""
    if not (isinstance(row, dict) and row.get("sealed") and row.get("text") == PLACEHOLDER):
        return row
    import field_crypto
    try:
        blob = json.loads(field_crypto.open_text(row["sealed"], f"user:{user_id}", f"tasks:{row.get('id')}"))
    except Exception as exc:  # noqa: BLE001 — reported, never shown as ciphertext
        logger.warning("a sealed task did not open (%s)", type(exc).__name__)
        return {**row, "_unreadable": True}
    return {**row, **{k: blob.get(k) for k in SEALED_FIELDS if k in blob}}


def seal_task_row(user_id: str, row: dict, prior: Optional[dict] = None) -> dict:
    """`row` ready to write: sensitive fields (row's, else the stored copy's)
    sealed into `sealed`, their columns emptied. Unchanged when sealing is off."""
    if not sealing_on():
        return row
    import field_crypto
    blob = {k: prior[k] for k in SEALED_FIELDS if prior and prior.get(k) not in (None, "")
            and not (k == "text" and prior[k] == PLACEHOLDER)}
    blob.update({k: row[k] for k in SEALED_FIELDS if k in row})
    out = {k: v for k, v in row.items() if k not in SEALED_FIELDS and k != "sealed"}
    out.update({k: None for k in SEALED_FIELDS})
    out["text"] = PLACEHOLDER
    out["sealed"] = field_crypto.seal_text(json.dumps(blob, ensure_ascii=False),
                                           f"user:{user_id}", f"tasks:{row['id']}")
    return out


_NEW_COLUMNS = {"allDay", "endDate"}   # migration 0017
_HAS_0017: Optional[bool] = None         # learned on the first read: None = not asked yet
_NO_0017_AT = 0.0                        # when it was found missing: asked again after _REPROBE_S
_REPROBE_S = 600


def _task_row(user_id: str, task: dict) -> dict:
    """The `tasks` row for one inbound task, before any merge with the stored
    copy. Split out of upsert_task so the parts that need no network — above
    all the status/completedAt pairing — can be tested directly."""
    from datetime import date as _date

    fixed_time = task.get("fixed_time")
    status = _clamp_status(task.get("status", "pending"))
    row = {
        "userId": user_id,
        "text": task.get("text", ""),
        "category": task.get("category", "general"),
        "priority": _clamp_priority(task.get("priority")),
        "isFixed": bool(fixed_time),
        "fixedTime": fixed_time,
        "durationMinutes": task.get("duration_minutes", 30),
        "date": task.get("date") or _date.today().isoformat(),
        "status": status,
        # Status and its stamp are written together, always. Writing only the
        # status is how ten rows on her phone ended up 'complete' with
        # completedAt=null — a shape the app cannot produce, which made the
        # ticks look self-inflicted for a month. A stamp the app sent is kept;
        # otherwise now; and anything not complete clears it, so a task that
        # was un-ticked does not keep the receipt of a completion it no longer
        # claims.
        "completedAt": (
            (task.get("completedAt") or int(time.time() * 1000))
            if status == "complete" else None
        ),
        # From the Session envelope when the caller stamped one; the literal
        # is the fallback for paths that have not been moved onto provenance
        # yet. Never guess a channel here — a wrong source is exactly the bug
        # provenance exists to end.
        "source": _source_of(task),
        "createdAt": int(time.time() * 1000),
    }
    # The computed route (TaskLocation + transitPlan) belongs in the location
    # jsonb column so the app shows the map in Task Detail. Only for located trips.
    if task.get("location"):
        row["location"] = task["location"]
    # The batch label (task_grouping): what makes eight design tasks read as one
    # project on the app's task board instead of eight unrelated notes.
    if task.get("subgroup"):
        row["subgroup"] = task["subgroup"]
    # What the invitation said beyond title/time/place (what to bring, who is
    # invited) — the app's Notes field is `progress`.
    if task.get("notes"):
        row["progress"] = str(task["notes"])[:400]
    # A whole day / a range (29.10, migration 0017).
    if task.get("allDay"):
        row["allDay"] = True
        row["isFixed"] = False
        end = str(task.get("endDate") or "")[:10]
        # Only a real day after the first one (security review 29.10): ranges are compared as strings.
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", end) and end > str(row.get("date") or ""):
            row["endDate"] = end
    return row


async def upsert_task(user_id: str, task: dict, trust_status: bool = False) -> Optional[str]:
    """Insert/update one WhatsApp task into the shared tasks table. Returns the
    row id on success, None on failure (truthy/falsy compatible with the old
    bool return).

    Id: task["id"] wins (main.py passes the id user_memory minted, so both
    stores share one UUID); else an existing row with the legacy wa_ hash or
    the exact same text+date keeps its id; else a fresh UUID.

    Non-clobbering: a WhatsApp re-mention of an existing task must not reset a
    status the user changed in the app/web (e.g. completed) nor churn createdAt.
    We read the existing row first and preserve those fields when the inbound
    task only carries defaults.

    `trust_status` turns that preservation off for the one caller it harms: a
    push from the app, whose status is the user's own last decision rather than
    a default. See user_memory.add_task."""
    if not _enabled():
        return None

    text = task.get("text", "")
    tid = str(task["id"]) if task.get("id") else None
    incoming_status = _clamp_status(task.get("status", "pending"))
    row = _task_row(user_id, task)
    date = row["date"]
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            # Look up the existing row so we don't clobber user-set fields — and,
            # when no id was passed, so a re-mention reuses the stored id instead
            # of forking a duplicate.
            existing = None
            try:
                if tid:
                    er = await client.get(
                        _rest("tasks"),
                        headers=_headers(),
                        params={
                            "select": "*",
                            "userId": f"eq.{user_id}",
                            "id": f"eq.{tid}",
                            "limit": "1",
                        },
                    )
                    existing = (er.json() or [None])[0] if er.status_code == 200 else None
                    existing = open_task_row(user_id, existing) if existing else None
                if not existing:
                    # Same-date rows fetched and matched in Python (PostgREST eq.
                    # filters choke on commas/parens in free text). Catches legacy
                    # wa_ rows, exact re-mentions, AND the same task worded
                    # differently (fuzzy word overlap) — so "interview tomorrow"
                    # and "interview tomorrow, Ramat Gan 11:30" stay ONE row.
                    legacy = _legacy_task_id(text, date)
                    er = await client.get(
                        _rest("tasks"),
                        headers=_headers(),
                        params={
                            "select": "*",
                            "userId": f"eq.{user_id}",
                            "date": f"eq.{date}",
                        },
                    )
                    cands = [open_task_row(user_id, c) for c in (er.json() if er.status_code == 200 else [])]
                    for cand in cands:
                        if cand.get("id") == legacy or cand.get("text") == text:
                            existing = cand
                            break
                    if not existing:
                        for cand in cands:
                            if text_similarity(cand.get("text", ""), text) >= 0.7:
                                existing = cand
                                break
            except Exception:  # noqa: BLE001 — lookup is best-effort
                existing = None
            if existing:
                tid = existing["id"] if not tid else tid
                if existing.get("createdAt"):
                    row["createdAt"] = existing["createdAt"]
                # Only a default "pending" re-mention should defer to the stored
                # status; an explicit status change over WhatsApp still applies,
                # and a push from the app (trust_status) is never a re-mention —
                # deferring to the stored row there is what wrote a stale
                # 'complete' back over an untick the user had just made.
                if (not trust_status and incoming_status == "pending"
                        and existing.get("status") not in (None, "pending")):
                    row["status"] = existing["status"]
                    # The stamp travels with the status it belongs to, or the
                    # row reappears in the impossible shape this fix exists to
                    # end (complete, completedAt null).
                    row["completedAt"] = (
                        existing.get("completedAt") or int(time.time() * 1000)
                        if row["status"] == "complete" else None
                    )
                # Merge, don't clobber: a less-detailed re-mention keeps the
                # richer stored values (longer text, set time/location, non-
                # default category/priority/duration).
                if existing.get("text") and len(existing["text"]) > len(row["text"]):
                    row["text"] = existing["text"]
                if not row.get("fixedTime") and existing.get("fixedTime"):
                    row["fixedTime"] = existing["fixedTime"]
                    row["isFixed"] = True
                if row.get("category") == "general" and existing.get("category"):
                    row["category"] = existing["category"]
                if row.get("priority") == "need_to" and existing.get("priority"):
                    row["priority"] = existing["priority"]
                if row.get("durationMinutes") == 30 and existing.get("durationMinutes"):
                    row["durationMinutes"] = existing["durationMinutes"]
                if not row.get("location") and existing.get("location"):
                    row["location"] = existing["location"]
            row["id"] = tid or str(uuid.uuid4())
            if existing and existing.get("_unreadable"):
                logger.warning("upsert_task: the stored copy will not open — not overwriting it")
                return None
            row = seal_task_row(user_id, row, existing if existing and existing.get("id") == row["id"] else None)
            global _HAS_0017, _NO_0017_AT
            if _HAS_0017 is False and time.time() - _NO_0017_AT <= _REPROBE_S:
                row = {k: v for k, v in row.items() if k not in _NEW_COLUMNS}   # known missing: no doomed POST
            r = await client.post(
                _rest("tasks"),
                headers={**_headers(), "Prefer": "resolution=merge-duplicates"},
                params={"on_conflict": "userId,id"},
                json=[row],
            )
            ok = r.status_code in (200, 201, 204)
            if not ok and _NEW_COLUMNS & set(row) and "PGRST204" in (r.text or ""):
                # Migration 0017 not run yet: the row is saved without the
                # whole-day columns, and the log says so (never a lost task).
                logger.warning("upsert_task: tasks.allDay/endDate missing — run migration 0017; saved without them")
                _HAS_0017, _NO_0017_AT = False, time.time()
                row = {k: v for k, v in row.items() if k not in _NEW_COLUMNS}
                r = await client.post(
                    _rest("tasks"),
                    headers={**_headers(), "Prefer": "resolution=merge-duplicates"},
                    params={"on_conflict": "userId,id"},
                    json=[row],
                )
                ok = r.status_code in (200, 201, 204)
            if not ok:
                logger.warning("upsert_task rejected (%s): %s", r.status_code, _pg_reason(r.text))
                return None
            # Converge: the same task matched under an old id (legacy wa_ hash) —
            # its data now lives in row["id"], so remove the stale twin.
            if existing and existing.get("id") and existing["id"] != row["id"]:
                await client.delete(
                    _rest("tasks"),
                    headers=_headers(),
                    params={"userId": f"eq.{user_id}", "id": f"eq.{existing['id']}"},
                )
            return str(row["id"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("upsert_task failed: %s", exc)
        return None


# ── pending-mirror queue ─────────────────────────────────────────────────────
# When a WhatsApp task arrives before the phone is linked to an app account
# (no app_settings.whatsAppPhone match yet), the mirror used to be silently
# dropped. Now it queues here (JSON on the DATA_DIR volume, same durability as
# user_memory) and is flushed on the next webhook or /link/verify call.


def _load_pending() -> list:
    """Through secure_store, like every other store holding personal data.

    This queue is task TEXT keyed by phone number — the same class of data as
    user_memory — and it read and wrote raw JSON, so it sat plaintext and
    world-readable on the volume while the stores around it were encrypted.
    Found 2026-09-17 by auditing /data rather than trusting the module list.
    """
    return secure_store.read_json(_PENDING_PATH, [])


def _save_pending(items: list) -> None:
    try:
        secure_store.write_json(_PENDING_PATH, items)
    except OSError as exc:
        logger.error("pending mirror save failed: %s", exc)


def queue_pending(phone: str, task: dict) -> None:
    """Remember a task whose phone→userId mapping isn't resolvable yet."""
    items = _load_pending()
    phone_digits = _digits(phone)
    tid = task.get("id")
    # One queued copy per task id (a re-mention replaces the older payload).
    if tid:
        items = [it for it in items if it.get("task", {}).get("id") != tid]
    items.append({"phone": phone_digits, "task": task, "queued_at": int(time.time())})
    _save_pending(items[-200:])


async def flush_pending(phone: str) -> int:
    """Try to mirror every queued task for this phone; returns how many landed.
    Items stay queued on failure (no data loss), succeed-and-remove otherwise."""
    items = _load_pending()
    phone_digits = _digits(phone)
    # Suffix-tolerant: the queue and the flush disagree about country prefix
    # more often than not. See _same_phone.
    mine = [it for it in items if _same_phone(it.get("phone", ""), phone_digits)]
    if not mine:
        return 0
    uid = await user_id_for_phone(phone_digits)
    if not uid:
        return 0
    flushed = []
    for it in mine:
        if await upsert_task(uid, it.get("task", {})):
            flushed.append(it)
    if flushed:
        _save_pending([it for it in items if it not in flushed])
    return len(flushed)


# snake_case (agent/user_memory) -> camelCase (Supabase tasks columns)
_PATCH_MAP = {
    "text": "text",
    "category": "category",
    "priority": "priority",
    "duration_minutes": "durationMinutes",
    "fixed_time": "fixedTime",
    "date": "date",
    "status": "status",
    "location": "location",
    "notes": "progress",
    # Where it was before she moved it: the phone's calendar re-import reads this so
    # Google's old date does not pull her move back (TaskStorage.reconcileExternalTask).
    "moved_from_date": "movedFromDate",
}


async def update_task(user_id: str, task_id: str, patch: dict) -> bool:
    """PATCH selected fields of one existing task row by id — the edit path
    (lumi_agent update_task tool). Never inserts; unknown keys are dropped."""
    if not _enabled():
        return False
    body = {_PATCH_MAP[k]: v for k, v in patch.items() if k in _PATCH_MAP and v is not None}
    if not body:
        return False
    if "fixedTime" in body:
        body["isFixed"] = bool(body["fixedTime"])
    # A status never travels without its stamp. This is the other door into the
    # same bug: completing a task over WhatsApp patched `status` alone, leaving
    # the row 'complete' with completedAt null — indistinguishable from a write
    # nobody can account for, which is how it went a month unexplained.
    if "status" in body:
        body["completedAt"] = (
            patch.get("completedAt") or int(time.time() * 1000)
            if body["status"] == "complete" else None
        )
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            if sealing_on() and any(k in SEALED_FIELDS for k in body):
                # Sealed fields live in one blob: read it, merge the patch, reseal.
                er = await client.get(_rest("tasks"), headers=_headers(),
                                      params={"select": "*", "userId": f"eq.{user_id}",
                                              "id": f"eq.{task_id}", "limit": "1"})
                stored = (er.json() or [None])[0] if er.status_code == 200 else None
                if not stored:
                    return False
                stored = open_task_row(user_id, stored)
                if stored.get("_unreadable"):
                    logger.warning("update_task: the stored copy will not open — not overwriting it")
                    return False
                body = seal_task_row(user_id, {**body, "id": task_id}, stored)
                body.pop("id", None)
            r = await client.patch(
                _rest("tasks"),
                # The row back, so "no such row" is not a success: a PATCH that
                # matches nothing is a 204 too. Live, 20.10: Meira "moved" a call
                # she had deleted on the phone and confirmed it ✓ (rule 3).
                headers={**_headers(), "Prefer": "return=representation"},
                params={"userId": f"eq.{user_id}", "id": f"eq.{task_id}"},
                json=body,
            )
            if r.status_code not in (200, 204):
                logger.warning("update_task rejected (%s): %s", r.status_code, _pg_reason(r.text))
                return False
            try:
                rows = r.json() if r.status_code == 200 and r.content else []
            except ValueError:
                rows = []
            if not rows:
                logger.warning("update_task: no such task in the cloud (deleted on the phone?)")
                return False
            return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("update_task failed: %s", exc)
        return False


async def tasks_for_user(user_id: str, date_from: Optional[str] = None,
                         date_to: Optional[str] = None,
                         include_location: bool = False) -> list:
    """The user's tasks (any source — app, web, WhatsApp), mapped to the
    snake_case dict shape the agent/user_memory already use.

    Both dates are optional: omitting them returns the whole task list, which is
    what GET /tasks/{phone} needs — it syncs everything the user has, not a
    window. The agent's get_my_tasks still passes a range.

    `include_location` is off by default on purpose. The agent reads these rows
    into a prompt and a route blob per task is a lot of tokens for nothing; the
    app's sync endpoint asks for it because losing the route is losing the
    reason the task was planned.
    """
    if not _enabled():
        return []
    columns = "id,text,category,priority,durationMinutes,fixedTime,date,status"
    if include_location:
        columns += ",location"
    if sealing_on():
        columns += ",sealed"
    date_filter = []
    if date_from:
        date_filter.append(f"gte.{date_from}")
    if date_to:
        date_filter.append(f"lte.{date_to}")
    global _HAS_0017, _NO_0017_AT
    if _HAS_0017 is False and time.time() - _NO_0017_AT > _REPROBE_S:
        _HAS_0017 = None          # the migration may have run since: ask again
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async def ask(cols: str):
                return await client.get(
                    _rest("tasks"),
                    headers=_headers(),
                    params={
                        "select": cols,
                        "userId": f"eq.{user_id}",
                        "order": "date.asc,fixedTime.asc.nullslast",
                        **({"date": date_filter} if date_filter else {}),
                    },
                )
            r = await ask(columns + (",allDay,endDate" if _HAS_0017 is not False else ""))
            if r.status_code == 400 and _HAS_0017 is not False and ("42703" in r.text or "PGRST204" in r.text) \
                    and ("allDay" in r.text or "endDate" in r.text):
                # Migration 0017 not run: read as before, and say so once.
                logger.warning("tasks_for_user: tasks.allDay/endDate missing — run migration 0017")
                _HAS_0017 = False
                _NO_0017_AT = time.time()
                r = await ask(columns)
            elif r.status_code == 200:
                _HAS_0017 = _HAS_0017 if _HAS_0017 is False else True
            if r.status_code != 200:
                logger.warning("tasks_for_user rejected (%s): %s", r.status_code, _pg_reason(r.text))
                return []
            return [
                {
                    "id": row.get("id"),
                    "text": row.get("text"),
                    "category": row.get("category"),
                    "priority": row.get("priority"),
                    "duration_minutes": row.get("durationMinutes"),
                    "fixed_time": row.get("fixedTime"),
                    "date": row.get("date"),
                    "status": row.get("status"),
                    **({"location": row["location"]} if row.get("location") else {}),
                    **({"allDay": True} if row.get("allDay") else {}),
                    **({"endDate": row["endDate"]} if row.get("endDate") else {}),
                }
                for row in (open_task_row(user_id, raw) for raw in r.json())
                if not row.get("_unreadable")
            ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("tasks_for_user failed: %s", exc)
        return []
