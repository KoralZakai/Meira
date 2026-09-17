"""Retrieval replaces recency — and never costs a turn.

The failure this guards is not "the wrong memory came back". It is a turn that
breaks, or gets slower, because a retrieval layer that is not configured
anywhere yet was asked a question. Every path that cannot answer must return
None quietly and let the old recency block do its job.
"""
import asyncio
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config              # noqa: E402
import database_service    # noqa: E402
import dedup_service       # noqa: E402
import memory_recall       # noqa: E402


def test_without_an_embed_model_recall_is_simply_off():
    with patch.object(config, "EMBED_MODEL", None):
        assert memory_recall.available() is False
        assert asyncio.run(memory_recall.block_for("k", "when do I leave?")) is None


def test_without_supabase_recall_is_off_even_with_embeddings():
    with patch.object(config, "EMBED_MODEL", "Qwen/Qwen3-Embedding-8B"), \
         patch.multiple(config, SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        assert memory_recall.available() is False
        assert asyncio.run(memory_recall.block_for("k", "anything")) is None


def _configured():
    return patch.multiple(config, EMBED_MODEL="Qwen/Qwen3-Embedding-8B",
                          SUPABASE_URL="https://fake.supabase.co",
                          SUPABASE_SERVICE_ROLE_KEY="service-role-key")


def test_an_embedding_failure_falls_back_instead_of_raising():
    async def no_vectors(texts):
        return None

    with _configured(), patch.object(dedup_service, "embed_texts", no_vectors):
        assert asyncio.run(memory_recall.block_for("k", "when do I leave?")) is None


def test_a_search_error_falls_back_instead_of_raising():
    async def vectors(texts):
        return [[0.1, 0.2]]

    async def boom(*_, **__):
        raise RuntimeError("pgvector unavailable")

    with _configured(), patch.object(dedup_service, "embed_texts", vectors), \
         patch.object(database_service, "search_memories", boom):
        assert asyncio.run(memory_recall.block_for("k", "when do I leave?")) is None


def test_retrieved_facts_become_the_block_the_prompt_expects():
    async def vectors(texts):
        return [[0.1, 0.2]]

    async def rows(user_key, embedding, limit=8, min_similarity=0.2):
        assert user_key == "972500000001"
        return [{"kind": "routine", "content": "wakes at 07:30", "similarity": 0.9},
                {"kind": "preference", "content": "3h study blocks", "similarity": 0.7}]

    with _configured(), patch.object(dedup_service, "embed_texts", vectors), \
         patch.object(database_service, "search_memories", rows):
        block = asyncio.run(memory_recall.block_for("972500000001", "מתי לצאת?"))

    assert "Routines: wakes at 07:30" in block
    assert "Preferences: 3h study blocks" in block


def test_no_matches_means_fall_back_not_an_empty_block():
    async def vectors(texts):
        return [[0.1, 0.2]]

    async def nothing(*_, **__):
        return []

    with _configured(), patch.object(dedup_service, "embed_texts", vectors), \
         patch.object(database_service, "search_memories", nothing):
        assert asyncio.run(memory_recall.block_for("k", "hello")) is None


def test_the_recall_threshold_is_looser_than_the_merge_threshold():
    # 0.912 decides whether two memories are the SAME fact; recall only decides
    # whether one is worth mentioning, and must not inherit that bar.
    assert memory_recall.MIN_SIMILARITY < 0.912
    assert memory_recall.TOP_K <= 10, "the block must stay a fixed, small size"
