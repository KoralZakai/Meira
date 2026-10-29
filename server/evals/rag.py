"""rag — does memory retrieval put the right facts in front of the model?

server/memory_recall.py replaced "the five most RECENT facts" with "the facts
nearest THIS message": embed the message, ask pgvector for the nearest stored
memories above a similarity floor, and render them as the prompt's memory block.
This measures that, on a synthetic person with 30 stored facts (routines,
preferences, habits; Hebrew and English) and 20 questions whose relevant facts
are labelled (plus 2 questions with NO relevant memory).

    Recall@K    share of a query's relevant facts found in the top K (K = 1, 3, 5)
    MRR         mean of 1 / rank of the first relevant fact
    block       does the relevant fact reach the PROMPT — i.e. appear in the text
                memory_recall.block_for() returns (K = TOP_K = 8)
    baseline    the same questions against what the old recency block would have
                sent (user_memory.format_for_prompt: 5 newest per bucket)
    no-match    questions with no relevant memory should retrieve nothing

WHAT IS REAL AND WHAT IS STAND-IN, honestly:
  real      memory_recall.recall / block_for / format_block, the similarity
            floor (MIN_SIMILARITY), the top-K limit, the fall-back-to-None rule,
            user_memory.format_for_prompt for the baseline
  stand-in  the embedding (offline: a deterministic IDF-weighted bag-of-words
            hashed into 1 024 dimensions — LEXICAL ONLY, so a Hebrew question
            about an English-worded fact cannot match, which the real model can)
            and the pgvector query (an in-memory cosine search with the same
            contract as database_service.search_memories: floor, order, limit)
  So offline numbers are a regression gate for memory_recall's logic and a
  lexical LOWER BOUND for retrieval quality. `--live` swaps in the real
  embedding model (Qwen3-Embedding-8B on Nebius) and is the number to quote
  about retrieval quality itself. Queries tagged hard=true are the cross-lingual
  / paraphrase ones; recall is also reported without them.
"""
from __future__ import annotations

import asyncio
import hashlib
import math
import os
import re
from unittest import mock

from evals import metrics as M
from evals.accuracy import load
from evals.result import metric, not_run, ok

ROW = "RAG quality"
DIM = 1024
KS = (1, 3, 5)
_STOP = set("a an the of to in on at is are do does did i my me you your it its and or for with by be "
            "can what when how will should have has had than that this there then if so as from into "
            "את של על עם או אני לי מה מתי כדאי יש לא כל אל זה זו".split())
_HE_PREFIX = "הבלומכש"


def tokens(text: str) -> list:
    out = []
    for raw in re.findall(r"[\w֐-׿:\-]+", (text or "").lower()):
        word = raw.strip("-:")
        if len(word) > 3 and word[0] in _HE_PREFIX and "֐" <= word[1] <= "׿":
            word = word[1:]
        if len(word) > 3 and word.endswith("s") and word.isascii():
            word = word[:-1]
        if len(word) > 1 and word not in _STOP:
            out.append(word)
    return out


class HashEmbedder:
    """A deterministic stand-in for an embedding model: IDF-weighted bag of words,
    hashed into DIM dimensions with a sign bit, L2-normalised. Lexical only."""

    def __init__(self, corpus: list):
        df: dict = {}
        for text in corpus:
            for word in set(tokens(text)):
                df[word] = df.get(word, 0) + 1
        self.n = len(corpus)
        self.df = df

    def idf(self, word: str) -> float:
        return math.log(1 + self.n / (1 + self.df.get(word, 0)))

    def embed(self, text: str) -> list:
        vec = [0.0] * DIM
        for word in tokens(text):
            digest = hashlib.md5(word.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "big") % DIM
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vec[idx] += sign * self.idf(word)
        norm = math.sqrt(sum(v * v for v in vec))
        return [v / norm for v in vec] if norm else vec


def cosine(a: list, b: list) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _recency_block(facts: list) -> str:
    """What the OLD prompt would have carried: the real user_memory.format_for_prompt,
    fed the facts oldest-first so the newest sit at the front as in production."""
    import user_memory
    phone = "972550" + "0000777"
    store = user_memory._load()
    store.pop(phone, None)
    user_memory._save(store)
    for fact in facts:
        user_memory.add_insight(phone, fact["kind"], fact["content"])
    block = user_memory.format_for_prompt(phone)
    store = user_memory._load()
    store.pop(phone, None)
    user_memory._save(store)
    return block


async def _evaluate(embed_texts, label: str) -> dict:
    """Run every query through memory_recall with `embed_texts` as the embedder."""
    import config
    import database_service
    import dedup_service
    import memory_recall
    facts = load("rag_memories.jsonl")
    queries = load("rag_queries.jsonl")
    by_id = {f["id"]: f for f in facts}

    vectors = await embed_texts([f["content"] for f in facts])
    if not vectors or len(vectors) != len(facts):
        return {"error": "the embedder returned no vectors for the stored facts"}
    stored = {f["id"]: v for f, v in zip(facts, vectors)}

    async def search(user_key, embedding, limit=8, min_similarity=0.2):
        """database_service.search_memories's contract: floor, best first, limit."""
        scored = sorted(((cosine(embedding, stored[i]), i) for i in stored), reverse=True)
        return [{"id": i, "kind": by_id[i]["kind"], "content": by_id[i]["content"], "similarity": s}
                for s, i in scored if s >= min_similarity][:limit]

    baseline_block = _recency_block(facts)
    rankings, relevants, rows_log, block_hits, block_n = [], [], [], 0, 0
    base_hits, base_n = 0, 0
    negatives, negatives_clean = 0, 0
    failures = []
    with mock.patch.multiple(config, EMBED_MODEL=config.EMBED_MODEL or "offline-embedder",
                             SUPABASE_URL="https://offline.invalid", SUPABASE_SERVICE_ROLE_KEY="offline"), \
            mock.patch.object(dedup_service, "embed_texts", embed_texts), \
            mock.patch.object(database_service, "search_memories", search):
        for q in queries:
            rows = await memory_recall.recall("eval-user", q["query"], top_k=max(KS))
            ranked = [r["id"] for r in (rows or [])]
            block = await memory_recall.block_for("eval-user", q["query"]) or ""
            relevant = q["relevant"]
            if not relevant:
                negatives += 1
                negatives_clean += not ranked
                if ranked:
                    failures.append({"input": q["query"], "expected": "nothing retrieved",
                                     "got": ", ".join(by_id[i]["content"] for i in ranked[:3])})
                continue
            rankings.append(ranked)
            relevants.append(relevant)
            for rid in relevant:
                block_n += 1
                block_hits += by_id[rid]["content"] in block
                base_n += 1
                base_hits += by_id[rid]["content"] in baseline_block
            if not set(relevant) & set(ranked[:5]):
                failures.append({
                    "input": q["query"] + ("  [hard]" if q["hard"] else ""),
                    "expected": "; ".join(by_id[r]["content"] for r in relevant),
                    "got": ("; ".join(by_id[i]["content"] for i in ranked[:3]) or "(nothing above the floor)")})
            rows_log.append({"id": q["id"], "hard": q["hard"], "ranked": ranked})
    easy = [i for i, q in enumerate(q for q in queries if q["relevant"]) if not q["hard"]]
    out = {"label": label, "queries": len(rankings), "failures": failures,
           "mrr": M.mrr(rankings, relevants),
           "block_recall": M.rate(block_hits, block_n), "baseline_recall": M.rate(base_hits, base_n),
           "no_match_clean": M.rate(negatives_clean, negatives), "negatives": negatives,
           "empty_rate": M.rate(sum(1 for r in rankings if not r), len(rankings))}
    for k in KS:
        out[f"recall_at_{k}"] = M.mean_recall_at_k(rankings, relevants, k)
        out[f"recall_at_{k}_easy"] = M.mean_recall_at_k(
            [rankings[i] for i in easy], [relevants[i] for i in easy], k)
    out["rows"] = rows_log
    return out


def _metrics(r: dict, prefix: str, how: str) -> list:
    d = {"queries": r["queries"], "empty_rate": r["empty_rate"]}
    out = [metric(f"{prefix}.recall_at_{k}", f"Recall@{k}", r[f"recall_at_{k}"], "ratio", how,
                  r["failures"] if k == 5 else [], {**d, "without_hard_queries": r[f"recall_at_{k}_easy"]})
           for k in KS]
    out += [
        metric(f"{prefix}.mrr", "MRR", r["mrr"], "ratio", how + "; mean 1/rank of the first relevant fact",
               [], d),
        metric(f"{prefix}.block_recall", "Relevant fact reaches the prompt", r["block_recall"], "ratio",
               "share of relevant facts whose text is in memory_recall.block_for()'s output (what the model reads)",
               [], d),
        metric(f"{prefix}.baseline_recall", "Old recency block, same questions", r["baseline_recall"], "ratio",
               "share of relevant facts the old user_memory.format_for_prompt (5 newest per bucket) would have "
               "carried — the thing retrieval replaces", [], d),
        metric(f"{prefix}.no_match_clean", "Nothing retrieved when nothing is relevant", r["no_match_clean"],
               "ratio", f"{r['negatives']} questions with no relevant memory; retrieval should return nothing "
               "so the recency block takes over", [], d),
    ]
    return out


def run() -> dict:
    facts = load("rag_memories.jsonl")
    embedder = HashEmbedder([f["content"] for f in facts])

    async def embed_texts(texts):
        return [embedder.embed(t) for t in texts]

    result = asyncio.run(_evaluate(embed_texts, "offline hashing embedder"))
    if "error" in result:
        return not_run("rag", ROW, result["error"])
    how = (f"{result['queries']} labelled questions over {len(facts)} stored facts; OFFLINE lexical "
           "(hashed IDF bag-of-words) embedder + in-memory cosine search standing in for the model and pgvector")
    return ok("rag", ROW, _metrics(result, "rag", how), {"rows": result["rows"]})


def run_live() -> dict:
    """The same questions with the REAL embedding model (needs NEBIUS_API_KEY)."""
    import config
    import dedup_service
    if not (config.LLM_API_KEY or os.environ.get("NEBIUS_API_KEY")):
        return not_run("rag_live", "RAG quality", "NEBIUS_API_KEY is not set")
    model = config.EMBED_MODEL or "Qwen/Qwen3-Embedding-8B"
    failed = {"why": ""}

    async def embed_texts(texts):
        with mock.patch.object(config, "EMBED_MODEL", model):
            vectors = await dedup_service.embed_texts(list(texts))
        if not vectors:
            failed["why"] = "dedup_service.embed_texts returned None (key rejected, model not served, or AI gate closed)"
        return vectors

    result = asyncio.run(_evaluate(embed_texts, f"live {model}"))
    if "error" in result:
        return not_run("rag_live", "RAG quality", failed["why"] or result["error"])
    how = f"{result['queries']} labelled questions; REAL embeddings ({model}) + in-memory cosine for pgvector"
    return ok("rag_live", "RAG quality", _metrics(result, "rag_live", how), {})
