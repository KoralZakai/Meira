"""Structured long-term memory for each user.

Stores only distilled insights — tasks, behavioral patterns, preferences,
routines. Never stores raw conversation text.

Insights are written to the JSON file AND shadowed into Postgres
(lumi_memories, migration 0007), which is where this is going: the prompt today
carries the whole memory blob every single turn, so a long-standing user costs
more per message than a new one and eventually will not fit at all. The table
has an embedding column so a turn can retrieve the handful of facts that matter
instead of all of them — the retrieval this product has never had.

Dependencies: config (DATA_DIR). Written by lumi_agent (save_memory tool) and
main.py (add_task after persisting an inferred task); read by lumi_agent via
format_for_prompt (injected into the system prompt) and the get_my_tasks fallback.
"""
import hashlib
import json
import logging
import os
import re
import uuid
from typing import Optional

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)
_PATH = os.path.join(config.DATA_DIR, "user_memory.json")

_DEFAULTS: dict = {
    "tasks": [],          # [{"text", "category", "date", "status"}] — last 30
    "behaviors": [],      # ["always studies after 21:00", "skips gym on Mondays"]
    "preferences": [],    # ["prefers coding in the morning", "wants 3h blocks for study"]
    "routines": [],       # ["wakes at 07:30", "arrives home by 19:00 on weekdays"]
    "contacts": [],       # [{"name", "number"}] — shared cards / typed numbers,
                          #   so "write to אימוש …" resolves without re-asking
}


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: tasks, contacts, habits, routines. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def get_memory(phone: str) -> dict:
    """Memory for a phone with all _DEFAULTS keys present — never None."""
    data = _load()
    mem = {k: list(v) for k, v in _DEFAULTS.items()}
    mem.update(data.get(phone, {}))
    return mem


def add_insight(phone: str, kind: str, value: str) -> None:
    """Add a single insight. kind = 'behavior' | 'preference' | 'routine'."""
    key = kind + "s"  # behaviors / preferences / routines
    if key not in _DEFAULTS:
        return
    data = _load()
    mem = {k: list(v) for k, v in _DEFAULTS.items()}
    mem.update(data.get(phone, {}))
    items: list = mem[key]
    if value not in items:
        items.insert(0, value)
        mem[key] = items[:20]  # keep last 20 per category
    data[phone] = mem
    _save(data)
    # Shadowed, never awaited: remembering something must not get slower or
    # less reliable because a second store is now listening.
    database_service.shadow_write(database_service.add_memory(phone, kind, value))


def remove_insight(phone: str, kind: str, prefix: str) -> int:
    """Forget insights of this kind that start with `prefix` (an answer she
    changed, a rule she removed). -> how many were dropped from the file."""
    key = kind + "s"
    prefix = (prefix or "").strip()
    if key not in _DEFAULTS or not prefix:
        return 0
    data = _load()
    mem = data.get(phone)
    if not isinstance(mem, dict):
        return 0
    before = list(mem.get(key) or [])
    kept = [v for v in before if not (isinstance(v, str) and v.startswith(prefix))]
    if len(kept) != len(before):
        mem[key] = kept
        data[phone] = mem
        _save(data)
    database_service.shadow_write(database_service.delete_memories(phone, kind, prefix))
    return len(before) - len(kept)


def _legacy_task_id(text: str, date: str) -> str:
    """OLD deterministic id scheme ("wa_" + sha1). Kept ONLY to match rows created
    before the UUID migration — never used to mint new ids (a text or date edit
    changed the hash, which is the root cause of duplicate-on-edit)."""
    return "wa_" + hashlib.sha1(f"{text}|{date}".encode("utf-8")).hexdigest()[:12]


def text_similarity(a: str, b: str) -> float:
    """Word-overlap similarity (0..1), containment-biased so 'interview
    tomorrow in Ramat Gan' matches its more-detailed retelling ('interview
    tomorrow, Ramat Gan, 11:30, bring CV'). Time tokens and one-letter words
    are ignored. Shared with supabase_tasks for the same-task merge."""
    def words(s: str) -> set:
        s = re.sub(r"\d{1,2}:\d{2}", " ", (s or "").lower())
        return {w for w in re.findall(r"[^\W_]+", s, re.UNICODE) if len(w) > 1}
    wa, wb = words(a), words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


def _resolve_task_id(tasks: list, task: dict, text: str, date: str) -> str:
    """Stable id: explicit id on the task wins (edit flow), else an existing
    stored copy (legacy wa_ hash, exact text+date, or a fuzzy same-date match —
    the SAME task worded differently) keeps its id, else a fresh UUID minted
    once and kept for the task's lifetime."""
    if task.get("id"):
        return str(task["id"])
    legacy = _legacy_task_id(text, date)
    for t in tasks:
        if t.get("id") == legacy or (t.get("text") == text and t.get("date") == date):
            return str(t["id"])
    for t in tasks:
        if t.get("date") == date and text_similarity(t.get("text", ""), text) >= 0.7:
            return str(t["id"])
    return str(uuid.uuid4())


def add_task(phone: str, task: dict, trust_status: bool = False) -> dict:
    """Record a task in memory (trimmed to last 30). Stores the fields the mobile
    app needs to render it (id, priority, duration, fixed time) and dedups by id
    so the same WhatsApp task isn't stored twice. Returns the stored entry so the
    caller can mirror the SAME id into Supabase (main.py webhook).

    `trust_status`: does the caller's status mean anything? For WhatsApp it does
    not — "יוגה מחר" mentioned again carries a default "pending" that is absence
    of information, so the stored status wins. For the app it is the user's own
    last decision, taken in the UI, and it must win instead. Reading the second
    as the first is what resurrected a tick every time she removed one: the app
    POSTs the full task on every edit, the stored copy still said 'complete'
    from an old chat turn, and the mirror wrote that back to the cloud."""
    from datetime import date as _date

    normalized_phone = "".join(ch for ch in str(phone or "") if ch.isdigit())
    data = _load()
    mem = {k: list(v) for k, v in _DEFAULTS.items()}
    mem.update(data.get(normalized_phone, {}))
    tasks: list = mem["tasks"]
    text = task.get("text", "")
    date = task.get("date", "") or _date.today().isoformat()
    tid = _resolve_task_id(tasks, task, text, date)
    prev = next((t for t in tasks if t.get("id") == tid), None)  # existing copy, if any
    tasks = [t for t in tasks if t.get("id") != tid]  # replace any existing copy
    # Non-clobbering: a plain re-mention (default "pending") must not overwrite a
    # status the user already advanced (e.g. complete) on a previous turn.
    incoming_status = task.get("status", "pending")
    status = incoming_status
    if (not trust_status and prev and incoming_status == "pending"
            and prev.get("status") not in (None, "pending")):
        status = prev.get("status")
    # Merge, don't clobber: a re-mention of the same task ("interview tomorrow")
    # must not wipe details a fuller earlier mention (or the app) already set.
    # More-detailed text wins; defaults defer to previously stored values.
    prev = prev or {}
    # "More-detailed text wins" is for a CHAT re-mention. The app's push is the user's own
    # last decision (trust_status): 21.10, she renamed tomorrow's appointment to "תור
    # לרופא" many times — shorter than the old title — and this line put the old one back,
    # in the mirror AND in Supabase, every time. An edit may shorten.
    if not trust_status and prev.get("text") and len(prev["text"]) > len(text):
        text = prev["text"]
    # Defaults defer to the stored value for a chat re-mention only; from the app a 30-minute
    # duration, a 'general' category or a 'need_to' priority is what she set.
    keep_defaults = not trust_status
    entry = {
        "id": tid,
        "text": text,
        "category": task.get("category") if (not keep_defaults and task.get("category")) or task.get("category") not in (None, "general") else prev.get("category", "general"),
        "priority": task.get("priority") if (not keep_defaults and task.get("priority")) or task.get("priority") not in (None, "need_to") else prev.get("priority", "need_to"),
        "duration_minutes": task.get("duration_minutes") if (not keep_defaults and task.get("duration_minutes")) or task.get("duration_minutes") not in (None, 30) else prev.get("duration_minutes", 30),
        "fixed_time": task.get("fixed_time") or prev.get("fixed_time"),
        "date": date,
        "status": status,
    }
    # Keep the computed route (TaskLocation with transitPlan) so the app can show
    # the map in Task Detail after the chat is gone. Only present for located trips.
    if task.get("location") or prev.get("location"):
        entry["location"] = task.get("location") or prev.get("location")
    # The batch label (task_grouping) — kept so `GET /tasks/{phone}` serves it
    # and the app's task board can group the batch as one project.
    if task.get("subgroup") or prev.get("subgroup"):
        entry["subgroup"] = task.get("subgroup") or prev.get("subgroup")
    # An explicitly requested wake time ("תעירי אותי ב-7"): the app arms the
    # real phone alarm off this. A re-mention of the same task must not erase
    # it — add_task rebuilds the entry from scratch, so it has to be carried.
    # completedAt rides along so the mirror can write the moment the user
    # actually ticked. It is only ever honoured for a complete row (see
    # supabase_tasks._task_row), so a stale stamp on an un-ticked task is
    # harmless here and gone by the time it reaches the cloud.
    for field in ("alarmAt", "alarmState", "completedAt"):
        if task.get(field) or prev.get(field):
            entry[field] = task.get(field) or prev.get(field)
    tasks.insert(0, entry)
    mem["tasks"] = tasks[:30]
    data[normalized_phone] = mem
    _save(data)
    return entry


def save_contact(phone: str, name: str, number: str) -> None:
    """Remember a contact (name → WhatsApp number) for scheduled messages.
    Same name updates in place; capped at 50."""
    digits = "".join(ch for ch in str(number or "") if ch.isdigit())
    name = (name or "").strip()
    if not digits or not name:
        return
    normalized_phone = "".join(ch for ch in str(phone or "") if ch.isdigit())
    data = _load()
    mem = {k: list(v) for k, v in _DEFAULTS.items()}
    mem.update(data.get(normalized_phone, {}))
    contacts: list = [c for c in mem.get("contacts", []) if c.get("name", "").lower() != name.lower()]
    contacts.insert(0, {"name": name, "number": digits})
    mem["contacts"] = contacts[:50]
    data[normalized_phone] = mem
    _save(data)


def find_contact(phone: str, name: str) -> Optional[dict]:
    """Look up a remembered contact by (fuzzy) name — exact, then substring.
    Keyed the same digits-normalized way save_contact writes."""
    name = (name or "").strip().lower()
    if not name:
        return None
    normalized_phone = "".join(ch for ch in str(phone or "") if ch.isdigit())
    contacts = _load().get(normalized_phone, {}).get("contacts", [])
    for c in contacts:
        if c.get("name", "").lower() == name:
            return c
    for c in contacts:
        cn = c.get("name", "").lower()
        if name in cn or cn in name:
            return c
    return None


def update_task(phone: str, task_id: str, patch: dict) -> Optional[dict]:
    """Patch fields of one remembered task by its stable id (the edit path —
    keeps the id, so no duplicate is forked). Returns the updated entry, or
    None when the id isn't in this phone's memory."""
    normalized_phone = "".join(ch for ch in str(phone or "") if ch.isdigit())
    data = _load()
    mem = data.get(normalized_phone)
    if not mem:
        return None
    for t in mem.get("tasks", []):
        if t.get("id") == task_id:
            t.update({k: v for k, v in patch.items() if v is not None})
            _save(data)
            return t
    return None


def _phone_key(data: dict, phone: str) -> Optional[str]:
    """The stored dict key for a phone — exact digits, else any key sharing the
    last 9 digits (mirrors tasks_for_phone's tolerance)."""
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if digits in data:
        return digits
    tail = digits[-9:]
    if tail:
        for key in data:
            if "".join(c for c in key if c.isdigit()).endswith(tail):
                return key
    return None


def tasks_for_phone(phone: str) -> list:
    """All remembered tasks for a phone, tolerant of number-format differences
    (matches an exact key, else any stored key sharing the last 9 digits).
    Backs the mobile app's GET /tasks/{phone} pull."""
    data = _load()
    key = _phone_key(data, phone)
    return list(data[key].get("tasks", [])) if key else []


def cleanup_tasks(phone: str, today: str) -> dict:
    """Remove duplicate and past-deadline tasks from a phone's store.

    - past: any task whose date is strictly before `today` (YYYY-MM-DD) — an
      overdue 'submit DDP by 24.7' is just clutter once the day passed.
    - duplicates: same date + near-identical text (similarity >= 0.85); the
      entry with the most detail (fixed_time/location) is kept.

    Returns {removed_past, removed_dupes, kept} counts. Safe no-op if nothing
    is stored for the phone."""
    data = _load()
    key = _phone_key(data, phone)
    if not key:
        return {"removed_past": 0, "removed_dupes": 0, "kept": 0}
    tasks = data[key].get("tasks", [])

    survivors, removed_past = [], 0
    for t in tasks:
        d = t.get("date")
        if d and d < today:
            removed_past += 1
        else:
            survivors.append(t)

    # De-duplicate survivors: keep the richest entry per (date, similar-text).
    def _richness(t: dict) -> int:
        return sum(bool(t.get(f)) for f in ("fixed_time", "location", "deadline", "contact"))

    kept, removed_dupes = [], 0
    for t in survivors:
        dup_idx = None
        for i, k in enumerate(kept):
            if k.get("date") == t.get("date") and \
                    text_similarity(k.get("text", ""), t.get("text", "")) >= 0.85:
                dup_idx = i
                break
        if dup_idx is None:
            kept.append(t)
        else:
            removed_dupes += 1
            if _richness(t) > _richness(kept[dup_idx]):
                kept[dup_idx] = t   # keep the more detailed of the two

    data[key]["tasks"] = kept
    _save(data)
    return {"removed_past": removed_past, "removed_dupes": removed_dupes, "kept": len(kept)}


def format_for_prompt(phone: str) -> str:
    """Return a compact memory block to inject into the system prompt."""
    mem = get_memory(phone)
    lines = []
    if mem["routines"]:
        lines.append("Routines: " + " | ".join(mem["routines"][:5]))
    if mem["preferences"]:
        lines.append("Preferences: " + " | ".join(mem["preferences"][:5]))
    if mem["behaviors"]:
        lines.append("Patterns: " + " | ".join(mem["behaviors"][:5]))
    if mem["tasks"]:
        recent = [f"{t['text']} ({t['date']})" for t in mem["tasks"][:5]]
        lines.append("Recent tasks: " + ", ".join(recent))
    return "\n".join(lines)
