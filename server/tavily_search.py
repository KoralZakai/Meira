"""Tavily — live web search and page extraction, server-side only.

Why this exists next to the Google Custom Search path: Google's free tier is
100 queries/day and returns snippets written for a human to click. Tavily is
built for agents — it returns cleaned page text and, optionally, a single
synthesised answer, so the model gets facts instead of link bait, and one
call replaces search-then-fetch-then-read.

Key handling: TAVILY_API_KEY is an encrypted Fly secret and is read from the
environment here. It is NEVER an EXPO_PUBLIC_* var and never reaches the
phone — an EXPO_PUBLIC value is inlined into the APK at build time, which is
how the old Nebius key shipped to every user (CLAUDE.md → ENV VARIABLES).

Every function is best-effort: a network flake returns {"ok": False, ...} and
never raises, because a failed search must not kill a conversation turn.
"""
import logging
from typing import Optional

import httpx

import config

logger = logging.getLogger(__name__)

_BASE = "https://api.tavily.com"
_TIMEOUT = 20.0          # advanced search genuinely takes ~5-10s
_EXTRACT_TIMEOUT = 30.0


def is_configured() -> bool:
    return bool(config.TAVILY_API_KEY)


def _headers() -> dict:
    return {"Authorization": f"Bearer {config.TAVILY_API_KEY}",
            "Content-Type": "application/json"}


async def search(
    query: str,
    *,
    max_results: int = 5,
    depth: str = "basic",
    include_answer: bool = False,
    topic: str = "general",
    days: Optional[int] = None,
    include_domains: Optional[list[str]] = None,
) -> dict:
    """One web search. Returns {ok, query, answer?, results:[{title,link,snippet,published}]}.

    depth="advanced" costs more Tavily credits and is slower, but returns
    longer, cleaner page content — worth it for research, not for "what time
    does the gym close".
    """
    if not is_configured():
        return {"ok": False, "error": "tavily_not_configured"}

    payload: dict = {
        "query": query,
        "max_results": max(1, min(int(max_results or 5), 20)),
        "search_depth": "advanced" if depth == "advanced" else "basic",
        "include_answer": bool(include_answer),
        "topic": "news" if topic == "news" else "general",
    }
    if days:
        payload["days"] = int(days)
    if include_domains:
        payload["include_domains"] = include_domains

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(f"{_BASE}/search", headers=_headers(), json=payload)
        if resp.status_code == 401:
            logger.error("tavily: key rejected (401) — rotate TAVILY_API_KEY")
            return {"ok": False, "error": "unauthorized"}
        if resp.status_code == 429:
            logger.warning("tavily: rate limited / credits exhausted")
            return {"ok": False, "error": "rate_limited"}
        if resp.status_code != 200:
            logger.warning("tavily search HTTP %s: %s", resp.status_code, resp.text[:200])
            return {"ok": False, "error": f"http_{resp.status_code}"}
        data = resp.json()
    except Exception as exc:  # noqa: BLE001 — never break the caller's turn
        logger.warning("tavily search failed: %s", exc)
        return {"ok": False, "error": "unreachable"}

    results = [
        {
            "title": r.get("title"),
            "link": r.get("url"),
            "snippet": (r.get("content") or "")[:1200],
            "published": r.get("published_date"),
            "score": r.get("score"),
        }
        for r in (data.get("results") or [])
    ]
    out = {"ok": True, "query": query, "results": results, "source": "tavily"}
    if data.get("answer"):
        out["answer"] = data["answer"]
    return out


async def extract(urls: list[str], *, depth: str = "basic") -> dict:
    """Fetch and clean the text of up to 20 pages. {ok, pages:[{url, text}]}.

    Use after search() when a snippet is not enough — an "about" page, a job
    description, a press release.
    """
    if not is_configured():
        return {"ok": False, "error": "tavily_not_configured"}
    urls = [u for u in (urls or []) if u][:20]
    if not urls:
        return {"ok": True, "pages": []}
    try:
        async with httpx.AsyncClient(timeout=_EXTRACT_TIMEOUT) as client:
            resp = await client.post(
                f"{_BASE}/extract", headers=_headers(),
                json={"urls": urls,
                      "extract_depth": "advanced" if depth == "advanced" else "basic"})
        if resp.status_code != 200:
            logger.warning("tavily extract HTTP %s: %s", resp.status_code, resp.text[:200])
            return {"ok": False, "error": f"http_{resp.status_code}"}
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("tavily extract failed: %s", exc)
        return {"ok": False, "error": "unreachable"}

    pages = [
        {"url": r.get("url"), "text": (r.get("raw_content") or "")[:20000]}
        for r in (data.get("results") or [])
    ]
    return {"ok": True, "pages": pages, "failed": data.get("failed_results") or []}


async def place_facts(place: str, *, address: str = "") -> dict:
    """What the live web says about a place RIGHT NOW: hours, and whether it
    still exists. {ok, place, answer, closed_hint, results[]}.

    Two questions in one search, because they are the same question in
    practice — "can I still get there today" is useless if the business shut
    down in March. Google Places (geo.find_place) knows where somewhere is; it
    happily returns an address for a shop that closed last year.

    `closed_hint` is True when the snippets contain a permanent-closure phrase.
    It is a HINT and named like one: the caller must show it as doubt, never
    state it as fact.
    """
    query = f"{place} {address}".strip() + " opening hours today permanently closed"
    res = await search(query, max_results=5, include_answer=True, depth="basic")
    if not res.get("ok"):
        return res

    blob = " ".join(
        f"{r.get('title') or ''} {r.get('snippet') or ''}" for r in res["results"]
    ).lower() + " " + str(res.get("answer") or "").lower()
    closed_markers = ("permanently closed", "temporarily closed", "סגור לצמיתות",
                      "נסגר", "closed down", "out of business")
    return {
        "ok": True,
        "place": place,
        "answer": res.get("answer"),
        "closed_hint": any(m in blob for m in closed_markers),
        "results": res["results"],
    }
