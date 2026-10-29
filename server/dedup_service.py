"""Duplicate-task detection and merging over the shared Supabase `tasks` table.

Why this exists: the app shows many versions of the same task. The causes are
structural — the two functions that create most tasks do no dedup at all, the
read-time dedup compares EXACT text so "gym at 6" and "workout 18:00" both
survive, and five different id schemes (app random, calendar `gcal-*`, server
uuid, legacy `wa_*`) mean one real appointment can exist as several rows.

Fixing every writer separately would leave the same hole open on the next one.
Instead this reconciles at the point where every path converges: the table.

Scoring is HYBRID on purpose:
  • structured — same date, same clock time, same location/category. Free,
    exact, and language-independent, which matters because most of these tasks
    are Hebrew.
  • text — embeddings when a model is configured (catches "תור לשיניים" vs
    "רופא שיניים", which word overlap scores 0), falling back to the existing
    lexical text_similarity when embeddings are unavailable.

The fallback is not a nicety: Nebius documents only `BAAI/bge-en-icl`, an
ENGLISH model. Until a multilingual one is confirmed working against this
account (GET /diag/embed), Hebrew similarity rests on the structured signals
and the lexical score — so dedup degrades in quality, never in correctness.

Dependencies: config, supabase_tasks (read/patch), user_memory.text_similarity,
httpx. Consumed by main.py (/diag/embed, /admin/dedup) and the periodic sweep.
"""
import logging
import math
from typing import Optional

import httpx

import config
import supabase_tasks
from user_memory import text_similarity

logger = logging.getLogger(__name__)

# Above this two tasks are considered the same thing.
DUPLICATE_THRESHOLD = 0.82
# Below this they are definitely different; between the two a human decides.
UNSURE_THRESHOLD = 0.62

_EMBED_CACHE: dict[str, list[float]] = {}


# ── embeddings ───────────────────────────────────────────────────────────────

async def embed_texts(texts: list[str]) -> Optional[list[list[float]]]:
    """Vectors for `texts`, or None when embeddings aren't usable.

    None is a normal outcome (no key, model not served, network down) — every
    caller falls back to lexical scoring rather than failing the sweep.
    """
    if not config.EMBED_MODEL or not config.LLM_API_KEY:
        return None
    wanted = [t for t in texts if t not in _EMBED_CACHE]
    import ai_gate
    if wanted and ai_gate.closed():
        logger.warning("embeddings skipped: AI balance stop is closed")
        return None
    if wanted:
        base = (config.EMBED_BASE_URL or config.LLM_ENDPOINT or "").rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    f"{base}/embeddings",
                    headers={"Authorization": f"Bearer {config.LLM_API_KEY}"},
                    json={"model": config.EMBED_MODEL, "input": wanted,
                          "encoding_format": "float"},
                )
            if r.status_code != 200:
                logger.warning("embeddings unavailable (HTTP %s): %s",
                               r.status_code, r.text[:160])
                return None
            for text, item in zip(wanted, r.json().get("data", [])):
                _EMBED_CACHE[text] = item.get("embedding") or []
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("embeddings failed: %s", exc)
            return None
    out = [_EMBED_CACHE.get(t) or [] for t in texts]
    return out if all(out) else None


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# ── scoring ──────────────────────────────────────────────────────────────────

def _time_of(task: dict) -> str:
    return (task.get("fixedTime") or task.get("scheduledTime") or "").strip()


def _place_of(task: dict) -> str:
    loc = task.get("location")
    if isinstance(loc, str):
        return loc.strip().lower()
    if isinstance(loc, dict):
        return str(loc.get("displayName") or loc.get("address") or "").strip().lower()
    return ""


def structured_score(a: dict, b: dict) -> float:
    """Agreement on the facts, ignoring wording entirely. 0..1.

    Two tasks at the same time on the same day are almost certainly the same
    appointment however differently they are phrased — which is exactly the
    case exact-text dedup keeps missing. A category DISAGREEMENT is treated as
    strong evidence against, so "buy milk" and "job interview" both at 10:00
    stay separate.
    """
    if (a.get("date") or "") != (b.get("date") or ""):
        return 0.0
    score = 0.35  # same day
    ta, tb = _time_of(a), _time_of(b)
    if ta and tb:
        if ta != tb:
            return 0.0  # same day, different clock time → different things
        score += 0.45
    pa, pb = _place_of(a), _place_of(b)
    if pa and pb and pa == pb:
        score += 0.15
    ca, cb = a.get("category"), b.get("category")
    if ca and cb:
        if ca == cb:
            score += 0.20
        else:
            score *= 0.5  # different kinds of thing — halve the confidence
    return min(score, 1.0)


def pair_score(a: dict, b: dict, vec: Optional[dict] = None) -> float:
    """How likely a and b are the same task.

    Text can only ADD confidence, never subtract it:

        score = structured + (1 - structured) * text

    A linear blend was wrong here. "חדר כושר" and "אימון ערב" are the same
    18:00 gym session but share no words, so lexical text similarity is 0 — and
    a blend let that zero veto overwhelming structural evidence (same day, same
    hour, same category). Hebrew hits this constantly, and it is precisely the
    duplicate the user keeps seeing. Structured agreement is the floor; wording
    lifts it when it happens to match.
    """
    st = structured_score(a, b)
    if st == 0.0:
        return 0.0
    ta, tb = a.get("text") or "", b.get("text") or ""
    if vec and ta in vec and tb in vec:
        txt = cosine(vec[ta], vec[tb])
    else:
        txt = text_similarity(ta, tb)
    return st + (1.0 - st) * max(0.0, min(1.0, txt))


# ── clustering + merge ───────────────────────────────────────────────────────

def _richness(task: dict) -> tuple:
    """How much a row is worth keeping — the survivor of a merge."""
    loc = task.get("location")
    return (
        1 if task.get("status") == "complete" else 0,   # a completed row wins
        1 if loc else 0,
        1 if _time_of(task) else 0,
        len(str(task.get("text") or "")),
        -(task.get("createdAt") or 0),                  # older wins ties
    )


async def find_clusters(tasks: list[dict]) -> list[list[dict]]:
    """Groups of rows that are the same task. Singletons are omitted."""
    pending = [t for t in tasks if t.get("status") != "complete"]
    vec = None
    vectors = await embed_texts([t.get("text") or "" for t in pending])
    if vectors:
        vec = {(t.get("text") or ""): v for t, v in zip(pending, vectors)}
        logger.info("dedup: using embeddings (%s)", config.EMBED_MODEL)
    else:
        logger.info("dedup: embeddings unavailable — lexical + structured only")

    clusters: list[list[dict]] = []
    claimed: set[str] = set()
    for i, a in enumerate(pending):
        if a.get("id") in claimed:
            continue
        group = [a]
        for b in pending[i + 1:]:
            if b.get("id") in claimed:
                continue
            if pair_score(a, b, vec) >= DUPLICATE_THRESHOLD:
                group.append(b)
                claimed.add(b.get("id"))
        if len(group) > 1:
            claimed.add(a.get("id"))
            clusters.append(group)
    return clusters


def merge_fields(cluster: list[dict]) -> tuple[dict, list[dict]]:
    """(survivor, losers) — the richest row, enriched with anything the others
    have and it lacks, so merging never loses a location or a time."""
    ordered = sorted(cluster, key=_richness, reverse=True)
    winner, losers = dict(ordered[0]), ordered[1:]
    for other in losers:
        for key in ("location", "fixedTime", "scheduledTime", "category",
                    "priority", "durationMinutes", "remindMinutesBefore",
                    "alarmAt", "contact", "deadline"):
            if not winner.get(key) and other.get(key):
                winner[key] = other[key]
    return winner, losers


async def dedup_user(user_id: str, date_from: str, date_to: str,
                     apply: bool = False) -> dict:
    """Find (and optionally merge) duplicate tasks for one user.

    apply=False is a dry run — it reports what WOULD merge and changes nothing,
    which is how this should be read the first time.
    """
    tasks = await supabase_tasks.tasks_for_user(user_id, date_from, date_to)
    clusters = await find_clusters(tasks)

    report = {"scanned": len(tasks), "clusters": [], "merged": 0, "applied": apply,
              "embeddings": bool(config.EMBED_MODEL)}
    for cluster in clusters:
        winner, losers = merge_fields(cluster)
        report["clusters"].append({
            "keep": {"id": winner.get("id"), "text": winner.get("text"),
                     "date": winner.get("date"), "time": _time_of(winner)},
            "drop": [{"id": l.get("id"), "text": l.get("text")} for l in losers],
        })
        if not apply:
            continue
        try:
            await supabase_tasks.update_task(user_id, winner["id"], {
                k: winner.get(k) for k in
                ("location", "fixedTime", "scheduledTime", "category", "priority")
                if winner.get(k)
            })
            for loser in losers:
                await supabase_tasks.update_task(
                    user_id, loser["id"],
                    {"status": "moved", "progress": f"merged into {winner['id']}"})
                report["merged"] += 1
        except Exception as exc:  # noqa: BLE001 — never let one cluster stop the rest
            logger.warning("merge failed for cluster %s: %s", winner.get("id"), exc)
    return report
