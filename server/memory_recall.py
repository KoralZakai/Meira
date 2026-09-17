"""memory_recall — the facts that matter for THIS message, not all of them.

"Memory" has meant one thing here since the beginning: take the user's stored
insights, cut each bucket to the first five by recency, and paste them into the
system prompt every turn. That is not retrieval. The five most RECENT routines
are not the five that bear on "when should I leave for the interview", and a
user who has been here a year has the same five slots as one who arrived
yesterday — their older, truer facts simply fall off the end.

This is the retrieval the product never had. Embed the incoming message, ask
Postgres for the memories nearest it (pgvector, migration 0007), and hand the
prompt those. Relevance instead of recency, and the block stays a fixed size
however long the user stays.

It degrades in one direction, on purpose:

    no EMBED_MODEL, no Supabase, no vectors stored yet, any error
        → None, and the caller keeps using user_memory.format_for_prompt

so turning embeddings on is what switches this on, and turning them off is a
complete rollback. Nothing here can make a turn fail.

Dependencies: dedup_service (embeddings, already configured and cached),
database_service (the vector query). Consumed by lumi_agent's prompt build.
"""
from __future__ import annotations

import logging
from typing import Optional

import config
import database_service
import dedup_service

logger = logging.getLogger(__name__)

#: How many facts a turn is allowed to carry. Small on purpose — the whole
#: complaint about the old block is that it grew.
TOP_K = 8

#: Below this, a "match" is noise dressed as a memory. Distinct from the 0.912
#: MERGE threshold, which decides whether two memories are the SAME fact;
#: recall only has to decide whether one is worth mentioning.
MIN_SIMILARITY = 0.35

_LABELS = {"routine": "Routines", "preference": "Preferences",
           "behavior": "Patterns", "contact": "Contacts", "task": "Recent"}


def available() -> bool:
    """True when retrieval could work at all — used for diagnostics, not gating
    (the real answer is whether `recall` returns something)."""
    return bool(config.EMBED_MODEL and database_service.enabled())


async def recall(user_key: str, message: str, top_k: int = TOP_K) -> Optional[list]:
    """The stored facts nearest this message, or None to fall back."""
    message = (message or "").strip()
    if not message or not available():
        return None
    try:
        vectors = await dedup_service.embed_texts([message])
        if not vectors:
            return None
        return await database_service.search_memories(
            user_key, vectors[0], limit=top_k, min_similarity=MIN_SIMILARITY)
    except Exception as exc:  # noqa: BLE001 — never fail a turn over recall
        logger.warning("memory recall failed: %s", exc)
        return None


def format_block(rows: list) -> str:
    """The retrieved facts as the compact block the prompt already expects —
    same shape as format_for_prompt, so the prompt does not have to know which
    one produced it."""
    grouped: dict[str, list] = {}
    for row in rows or []:
        kind = row.get("kind") or "routine"
        content = str(row.get("content") or "").strip()
        if content:
            grouped.setdefault(kind, []).append(content)
    lines = []
    for kind, label in _LABELS.items():
        if grouped.get(kind):
            lines.append(f"{label}: " + " | ".join(grouped[kind]))
    return "\n".join(lines)


async def block_for(user_key: str, message: str) -> Optional[str]:
    """One call for the prompt builder: a relevance-picked memory block, or
    None when retrieval is not available and the recency block should be used."""
    rows = await recall(user_key, message)
    if not rows:
        return None
    block = format_block(rows)
    return block or None


if __name__ == "__main__":   # self-check: python server/memory_recall.py
    block = format_block([
        {"kind": "routine", "content": "wakes at 07:30"},
        {"kind": "preference", "content": "3h study blocks"},
        {"kind": "routine", "content": "home by 19:00"},
        {"kind": "unknown-kind", "content": "ignored"},
    ])
    assert block.splitlines()[0] == "Routines: wakes at 07:30 | home by 19:00"
    assert "Preferences: 3h study blocks" in block
    assert "ignored" not in block, "an unrecognised kind is not rendered"
    assert format_block([]) == ""
    print("memory_recall self-check OK")
