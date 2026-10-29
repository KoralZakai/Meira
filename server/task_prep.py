"""Meira prepares you for what is next — any task, not only meetings.

Koral, 29.9: "I had a karaoke — why didn't Meira suggest songs to sing, with
the lyrics, to prepare ahead?" The meeting brief already researches a company
and a person before an interview. This is the same bargain for everything
else: karaoke → songs worth practising and where their lyrics are; a doctor →
what to bring and what to ask; a hike → the trail and the weather; a course →
what the first session covers.

THREE STEPS, each doing only what it is good at.

1. PLAN (Nemotron Nano, cheap). Is there anything worth preparing, what KIND of
   preparation, and one or two web searches that would find it. Most tasks
   ("call mum", "laundry") get prep=false and cost nothing further. The model
   decides because this is judgement about meaning — the thing a keyword table
   cannot do and the reason it is a model call at all.

2. SEARCH (Tavily). Live results, numbered as sources.

3. COMPOSE (Nemotron Super). Short, actionable items — and the same rule as
   meeting_brief: EVERY item cites a source it came from, and an item that
   cites nothing is dropped before it reaches her. A song list invented by a
   model is worse than none.

Privacy: the search queries are about the TASK ("karaoke songs"), never about
her — no name, no address, no memory text goes to Tavily. What the model knows
about her (the recalled memory block, e.g. "sings in Hebrew") only shapes the
queries it writes.

Caching: encrypted (secure_store), {user_key: {task_key: {prep, fetched_at}}},
the shape account_deletion walks. A refusal is cached too, shorter.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from typing import Any, Optional

import ai_gate
import config
import llm_usage
import model_router
import secure_store
import tavily_search

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "task_prep.json")
_TTL_S = 3 * 86400
_REFUSAL_TTL_S = 12 * 3600
_MAX_CACHE = 200
_MAX_QUERIES = 2

KINDS = ("songs", "questions", "checklist", "reading", "route_tips", "ideas", "other")


# ── 1. plan ─────────────────────────────────────────────────────────────────

_PLAN_SYSTEM = """You decide whether a personal task deserves preparation \
from a live web search, and if so what to search for.

Prepare ONLY when a search would genuinely help her show up ready:
- karaoke / singing night → popular songs to practise + lyrics (kind "songs")
- doctor / clinic / tests → what to bring, what to ask (kind "questions")
- trip, hike, event, concert, conference → practical tips, what to know (kind "route_tips" or "reading")
- class, course, lecture, workshop → what it covers, what to bring (kind "reading" or "checklist")
- a party, a date, a gift → ideas (kind "ideas")
Do NOT prepare: errands, chores, calls, generic work blocks, gym, anything \
where the web adds nothing ("laundry", "call mum", "work on the app").
Interviews and business meetings are handled elsewhere: prep=false.

Queries: 1-2, short, about the TASK only — never the user's name, address or \
private details. Write them in the language that will find the best results \
(Hebrew for Israeli-local things, e.g. Hebrew karaoke songs if she sings in \
Hebrew). Use the MEMORY block only to tailor the queries.

Return JSON only:
{"prep": true|false, "kind": "songs|questions|checklist|reading|route_tips|ideas|other",
 "why": "<=12 words", "queries": ["", ""]}"""


async def _llm_json(source: str, system: str, user: str, max_tokens: int) -> Optional[dict]:

    model = model_router.pick(source, prompt_chars=len(system) + len(user))
    client = ai_gate.client()
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            temperature=0.2,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
            timeout=45,
        )
    except Exception as exc:  # noqa: BLE001 — a failed prep is not a failed app
        logger.warning("task_prep %s failed: %s", source, exc)
        return None
    usage = getattr(resp, "usage", None)
    if usage:
        llm_usage.record(source, usage.prompt_tokens or 0, usage.completion_tokens or 0, model)
    try:
        return json.loads(resp.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        logger.warning("task_prep %s: model returned non-JSON", source)
        return None


def _task_facts(task: dict) -> str:
    return (
        f"TASK: {task.get('text') or ''}\n"
        f"CATEGORY: {task.get('category') or '(none)'}\n"
        f"WHEN: {task.get('date') or ''} {task.get('time') or ''}\n"
        f"WHERE: {task.get('location') or '(not given)'}\n"
    )


def _clean_plan(plan: Optional[dict]) -> Optional[dict]:
    if not isinstance(plan, dict):
        return None
    queries = [q.strip() for q in (plan.get("queries") or [])
               if isinstance(q, str) and q.strip()][:_MAX_QUERIES]
    kind = plan.get("kind") if plan.get("kind") in KINDS else "other"
    return {"prep": bool(plan.get("prep")) and bool(queries), "kind": kind,
            "why": str(plan.get("why") or "")[:120], "queries": queries}


async def plan(task: dict, memory: str = "") -> Optional[dict]:
    user = _task_facts(task) + (f"\nMEMORY (about her, private):\n{memory[:800]}\n" if memory else "")
    return _clean_plan(await _llm_json("task_prep_plan", _PLAN_SYSTEM, user, 250))


# ── 2. search ───────────────────────────────────────────────────────────────

async def _gather(queries: list[str]) -> list[dict]:
    out: list[dict] = []
    for q in queries:
        res = await tavily_search.search(q, max_results=5)
        if res.get("ok"):
            out.extend(res["results"])
        else:
            logger.info("task_prep: search %r unavailable (%s)", q, res.get("error"))
    seen, uniq = set(), []
    for r in out:
        link = r.get("link")
        if not link or link in seen:
            continue
        seen.add(link)
        uniq.append(r)
    return uniq[:10]


# ── 3. compose ──────────────────────────────────────────────────────────────

_COMPOSE_SYSTEM = """You prepare her for a task using ONLY the numbered web \
sources given. Short and practical — she reads this on a phone before she goes.

HARD RULES
- Use ONLY the sources. If the sources do not say it, it does not go in.
- Every item ends with the source number(s) it came from, like [2] or [1,3].
- 3-6 items. Each item max 14 words.
- kind "songs": each item is "Song — Artist [n]", from sources that list songs \
or lyrics; prefer sources that carry the lyrics.
- kind "questions": things to ask or bring.
- headline: ONE sentence, max 12 words, what this prep is.
- Write BOTH languages: *_he in Hebrew, *_en in English. Same items, same citations.

Return JSON only:
{"headline_he":"","headline_en":"","items_he":[""],"items_en":[""]}"""


def _cite_ok(line: str, n_sources: int) -> bool:
    nums: list[int] = []
    for group in re.findall(r"\[([\d,\s]+)\]", line):
        for part in group.split(","):
            part = part.strip()
            if part.isdigit():
                nums.append(int(part))
    return bool(nums) and all(1 <= n <= n_sources for n in nums)


def _clean(prep: dict, n_sources: int) -> dict:
    """Drop every item that does not cite a source we actually fetched."""
    dropped = 0
    for key in ("items_he", "items_en"):
        kept = []
        for line in prep.get(key) or []:
            if isinstance(line, str) and line.strip() and _cite_ok(line, n_sources):
                kept.append(line.strip())
            else:
                dropped += 1
        prep[key] = kept[:6]
    prep["dropped_items"] = dropped
    return prep


async def _compose(task: dict, kind: str, sources: list[dict]) -> Optional[dict]:
    listing = "\n".join(
        f"[{i+1}] {s.get('title')} — {s.get('link')}\n{(s.get('snippet') or '')[:600]}"
        for i, s in enumerate(sources))
    user = _task_facts(task) + f"KIND: {kind}\n\nSOURCES:\n{listing}"
    return await _llm_json("task_prep", _COMPOSE_SYSTEM, user, 700)


# ── cache ───────────────────────────────────────────────────────────────────

def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def task_key(task: dict) -> str:
    """Id plus the words: an edited title is a different thing to prepare for."""
    raw = f"{task.get('id') or ''}|{(task.get('text') or '').strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _cache_read(user_key: str, key: str) -> Optional[dict]:
    row = (_load().get(user_key) or {}).get(key)
    if not row:
        return None
    ttl = _TTL_S if row.get("prep", {}).get("ok") else _REFUSAL_TTL_S
    if time.time() - row.get("fetched_at", 0) > ttl:
        return None
    return row.get("prep")


def _cache_write(user_key: str, key: str, prep: dict) -> None:
    try:
        store = _load()
        mine = store.setdefault(user_key, {})
        mine[key] = {"prep": prep, "fetched_at": time.time()}
        if len(mine) > _MAX_CACHE:
            for k in sorted(mine, key=lambda k: mine[k].get("fetched_at", 0))[:len(mine) - _MAX_CACHE]:
                mine.pop(k, None)
        _save(store)
    except Exception as exc:  # noqa: BLE001 — a cache miss is not a failure
        logger.warning("task_prep cache write failed: %s", exc)


def forget(user_key: str, text: str) -> int:
    """Drop cached prep for a task with these words — after a 👎, so the next
    ask is rebuilt with her verdict instead of served stale. Returns how many."""
    want = (text or "").strip().lower()
    if not want:
        return 0
    store = _load()
    mine = store.get(user_key) or {}
    gone = [k for k, row in mine.items()
            if str(((row.get("prep") or {}).get("task") or {}).get("text") or "").strip().lower() == want]
    for k in gone:
        mine.pop(k, None)
    if gone:
        _save(store)
    return len(gone)


# ── entry point ─────────────────────────────────────────────────────────────

async def _memory_for(user_key: str, text: str) -> str:
    block = ""
    try:
        import memory_recall
        block = (await memory_recall.block_for(user_key, text)) or ""
    except Exception as exc:  # noqa: BLE001 — prep works without memory
        logger.info("task_prep: memory recall unavailable (%s)", exc)
    # Her 👍/👎 on past prep, handed over directly — it must count even when
    # retrieval is down (feedback_store).
    try:
        import feedback_store
        verdicts = feedback_store.lines(user_key, "prep")
        if verdicts:
            block = f"{block}\nHER VERDICTS ON PAST PREP:\n{verdicts}".strip()
    except Exception as exc:  # noqa: BLE001
        logger.info("task_prep: verdicts unavailable (%s)", exc)
    return block


async def build(task: dict, user_key: str, *, force: bool = False) -> dict:
    """One task → {ok, kind, headline_*, items_*, sources[]} or {ok: false, reason}.

    Every refusal names its reason, because "nothing to prepare for laundry"
    and "the search key is dead" must not look the same (CLAUDE.md rule 1)."""
    if not (task.get("text") or "").strip():
        return {"ok": False, "reason": "no_task"}
    key = task_key(task)
    if not force:
        cached = _cache_read(user_key, key)
        if cached:
            return {**cached, "cached": True}

    if not tavily_search.is_configured():
        return {"ok": False, "reason": "search_not_configured"}

    p = await plan(task, await _memory_for(user_key, task.get("text") or ""))
    if p is None:
        return {"ok": False, "reason": "plan_failed"}
    if not p["prep"]:
        out = {"ok": False, "reason": "nothing_to_prepare", "why": p["why"]}
        _cache_write(user_key, key, out)
        return out

    sources = await _gather(p["queries"])
    if not sources:
        return {"ok": False, "reason": "no_sources", "queries": p["queries"]}

    composed = await _compose(task, p["kind"], sources)
    if not composed:
        return {"ok": False, "reason": "compose_failed"}
    prep = _clean(composed, len(sources))
    if not (prep["items_he"] or prep["items_en"]):
        return {"ok": False, "reason": "nothing_cited"}

    prep.update({
        "ok": True,
        "kind": p["kind"],
        "why": p["why"],
        "queries": p["queries"],
        "sources": [{"n": i + 1, "title": s.get("title"), "link": s.get("link")}
                    for i, s in enumerate(sources)],
        "task": {"id": task.get("id"), "text": task.get("text"), "date": task.get("date")},
    })
    _cache_write(user_key, key, prep)
    return {**prep, "cached": False}
