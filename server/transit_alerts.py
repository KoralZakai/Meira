"""Transit disruptions on HER route — roadworks, closed stations, train changes.

Google Directions plans against the timetable. It does not know that Israel
Railways closed the Tel Aviv–Haifa line for the weekend, that Route 4 is shut
at night for bridge works, or that a strike stopped the buses. Those are in the
NEWS, so this asks the news: one or two Tavily news searches (last few days),
built from the places, stations and line numbers of the trip she is actually
taking.

What makes it hers and not a headline feed is the filter, which is code, not
the model: a result is kept only when its text carries BOTH a disruption word
("עבודות", "סגירה", "שיבוש", "closure", "strike"...) AND one of her terms (a
city on the route, a station she boards at, the line she rides). Anything else
is somebody else's traffic.

Silent-state rule 1: `checked` says whether we actually looked. "No alerts"
(checked=True, alerts=[]) and "couldn't look" (checked=False, reason=...) are
different answers and every caller must say them differently.

A news item is a HINT, never a fact about her ride. Callers phrase it as
"there may be...", with the link, and keep the route they already have.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Iterable, Optional

import tavily_search

logger = logging.getLogger(__name__)

_DAYS = 3                 # news older than this is history, not a warning
_MAX_RESULTS = 8
_TIMEOUT_S = 15.0
_CACHE_TTL_S = 30 * 60    # the same route asked twice in a morning costs one search
_cache: dict[str, tuple[float, dict]] = {}

# Israeli news + operator sites. Tavily searches only these, so a hit is a
# local report and not a Yorkshire road closure that shares a word with us.
NEWS_DOMAINS = [
    "rail.co.il", "gov.il", "ynet.co.il", "mako.co.il", "walla.co.il",
    "maariv.co.il", "haaretz.co.il", "israelhayom.co.il", "kan.org.il",
    "timesofisrael.com", "jpost.com", "calcalist.co.il", "themarker.com",
    "bhol.co.il", "kikar.co.il", "13tv.co.il", "now14.co.il", "ice.co.il",
]

# A result must say SOMETHING is wrong. Stems, matched as substrings, so
# "עבודות"/"עבודת" and "closure"/"closed" are one entry each.
_DISRUPTION = (
    "שיבוש", "עבודות", "עבודת", "חסימ", "חסום", "סגיר", "ייסגר", "נסגר", "סגורה",
    "הסט", "ללא רכבות", "לא יפעל", "לא תפעל", "לא יופעל", "השבת", "שביתה",
    "תאונ", "עומס", "פקק", "אוטובוסים חלופיים", "הסעות חלופיות", "עיכוב",
    "closure", "closed", "roadwork", "road work", "works", "strike", "suspend",
    "divert", "disrupt", "delay", "accident", "shut", "no trains", "replacement bus",
)

_RAIL_MODES = {"train", "rail", "heavy_rail", "commuter_train", "high_speed_train",
               "light_rail", "tram", "subway", "metro"}
_ROAD_MODES = {"bus", "car", "taxi", "drive", "driving", "bike", "scooter"}

_COUNTRY = {"israel", "ישראל", "il"}
_STOPWORDS = {"street", "st", "road", "rd", "רחוב", "רח", "שדרות", "שד", "דרך",
              "station", "תחנת", "תחנה", "רכבת", "מרכז", "center", "centre"}


# Google often hands back "Haifa" while the news says "חיפה". Without this a
# real closure on her line is filtered out for speaking the other language.
_CITY_ALIASES = {
    "tel aviv": "תל אביב", "tel aviv-yafo": "תל אביב", "jerusalem": "ירושלים",
    "haifa": "חיפה", "ra'anana": "רעננה", "raanana": "רעננה", "herzliya": "הרצליה",
    "petah tikva": "פתח תקווה", "rishon lezion": "ראשון לציון",
    "rishon le-zion": "ראשון לציון", "holon": "חולון", "bat yam": "בת ים",
    "ramat gan": "רמת גן", "givatayim": "גבעתיים", "bnei brak": "בני ברק",
    "netanya": "נתניה", "kfar saba": "כפר סבא", "hod hasharon": "הוד השרון",
    "rehovot": "רחובות", "ness ziona": "נס ציונה", "lod": "לוד", "ramla": "רמלה",
    "modi'in": "מודיעין", "modiin": "מודיעין", "ashdod": "אשדוד", "ashkelon": "אשקלון",
    "beersheba": "באר שבע", "be'er sheva": "באר שבע", "beer sheva": "באר שבע",
    "eilat": "אילת", "hadera": "חדרה", "binyamina": "בנימינה", "zichron yaakov": "זכרון יעקב",
    "caesarea": "קיסריה", "nahariya": "נהריה", "acre": "עכו", "akko": "עכו",
    "karmiel": "כרמיאל", "afula": "עפולה", "nazareth": "נצרת", "tiberias": "טבריה",
    "yokneam": "יקנעם", "or yehuda": "אור יהודה", "yehud": "יהוד", "rosh haayin": "ראש העין",
    "ben gurion airport": "נתב\"ג", "yavne": "יבנה", "kiryat gat": "קריית גת",
}
_HE_TO_EN = {}
for _en, _he in _CITY_ALIASES.items():
    _HE_TO_EN.setdefault(_he, _en)


def _with_aliases(places: list[str]) -> list[str]:
    out = list(places)
    for p in places:
        low = p.lower()
        other = _CITY_ALIASES.get(low) or _HE_TO_EN.get(p)
        if other and other.lower() not in (x.lower() for x in out):
            out.append(other)
    return out


def is_configured() -> bool:
    return tavily_search.is_configured()


def places_from_address(address: str) -> list[str]:
    """'Herzl 12, Ra'anana, Israel' → ['Herzl', "Ra'anana"].

    The city is what a news report names; the street matters for roadworks.
    House numbers, postcodes and the country are noise.
    """
    out: list[str] = []
    for part in str(address or "").split(","):
        part = re.sub(r"\d+", " ", part).strip(" -'\"")
        part = re.sub(r"\s+", " ", part)
        if len(part) < 2 or part.lower() in _COUNTRY:
            continue
        out.append(part)
    return out


def _clean_terms(terms: Iterable[str]) -> list[str]:
    seen, out = set(), []
    for t in terms:
        t = re.sub(r"\s+", " ", str(t or "")).strip()
        if len(t) < 2 or t.lower() in _STOPWORDS or t.lower() in _COUNTRY:
            continue
        if t.lower() in seen:
            continue
        seen.add(t.lower())
        out.append(t)
    return out


def _line_terms(lines: Iterable[str]) -> list[str]:
    return [str(x).strip() for x in lines if str(x or "").strip()]


def _matches(text: str, places: list[str], stations: list[str], lines: list[str]) -> list[str]:
    """Which of HER terms this text names. A line number only counts next to
    the word for line, so 'line 4' is not every '4' on the page."""
    low = text.lower()
    hit = [p for p in places + stations if p.lower() in low]
    for ln in lines:
        pat = rf"(קו|קווים|line|lines|bus|route|כביש)\s*(מס['׳]?\s*)?{re.escape(ln.lower())}\b"
        if re.search(pat, low):
            hit.append(ln)
    return hit


def _is_disruption(text: str) -> bool:
    low = text.lower()
    return any(k in low for k in _DISRUPTION)


def _queries(places: list[str], stations: list[str], lines: list[str], rail: bool, road: bool) -> list[str]:
    # The query is Hebrew, so its place names are too where we know them.
    he_places = [p for p in places if re.search(r"[֐-׿]", p)] or places
    where = " ".join((stations + he_places)[:4])
    qs = []
    if rail:
        qs.append(f"רכבת ישראל שיבושים עבודות סגירת קו {where}".strip())
    if road or not rail:
        line_bit = " ".join(f"קו {ln}" for ln in lines[:3])
        qs.append(f"חסימות כבישים עבודות שיבושי תחבורה {where} {line_bit}".strip())
    return qs


async def _search(query: str) -> dict:
    now = time.monotonic()
    hit = _cache.get(query)
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    try:
        res = await asyncio.wait_for(
            tavily_search.search(query, max_results=_MAX_RESULTS, topic="news",
                                 days=_DAYS, include_domains=NEWS_DOMAINS),
            timeout=_TIMEOUT_S)
    except asyncio.TimeoutError:
        logger.warning("transit_alerts: search timed out: %s", query)
        return {"ok": False, "error": "timeout"}
    if res.get("ok"):
        _cache[query] = (now, res)
    return res


async def disruptions_for(*, places: Iterable[str] = (), stations: Iterable[str] = (),
                          lines: Iterable[str] = (), modes: Iterable[str] = ()) -> dict:
    """News that may affect a trip through `places` / `stations` on `lines`.

    Returns {ok: True, checked: True, alerts: [...], queries: [...]} when the
    search ran (alerts may be []), or {ok: False, checked: False, reason}
    when it could not — never [] for both.
    Each alert: {title, link, snippet, published, matched: [her terms]}.
    """
    places = _with_aliases(_clean_terms(places))
    stations = _clean_terms(stations)
    lines = _line_terms(lines)
    if not (places or stations or lines):
        return {"ok": False, "checked": False, "reason": "no_route_terms"}
    if not is_configured():
        return {"ok": False, "checked": False, "reason": "not_configured"}

    mode_set = {str(m or "").lower() for m in modes}
    rail = bool(mode_set & _RAIL_MODES)
    road = bool(mode_set & _ROAD_MODES) or not mode_set
    queries = _queries(places, stations, lines, rail, road)

    results = await asyncio.gather(*(_search(q) for q in queries))
    failed = [r.get("error") or "failed" for r in results if not r.get("ok")]
    if len(failed) == len(results):
        return {"ok": False, "checked": False, "reason": failed[0], "queries": queries}

    alerts, seen = [], set()
    for res in results:
        for r in res.get("results") or [] if res.get("ok") else []:
            link = r.get("link")
            if not link or link in seen:
                continue
            text = f"{r.get('title') or ''} {r.get('snippet') or ''}"
            if not _is_disruption(text):
                continue
            # A national rail closure ("no trains between Tel Aviv and Haifa")
            # names cities, not her boarding station — so cities count, but a
            # report naming none of her terms is somebody else's traffic.
            matched = _matches(text, places, stations, lines)
            if not matched:
                continue
            seen.add(link)
            alerts.append({"title": r.get("title"), "link": link,
                           "snippet": (r.get("snippet") or "")[:400],
                           "published": r.get("published"), "matched": matched})
    out = {"ok": True, "checked": True, "alerts": alerts[:5], "queries": queries}
    if failed:
        out["partial"] = True   # one of two searches failed — say "partly checked"
    return out


def terms_from_plan(plan: Optional[dict], *, origin: str = "", destination: str = "") -> dict:
    """Pull places / stations / lines / modes out of a geo.plan_departure plan
    (legs: {type, line, from, to}) plus the trip's two ends."""
    places = places_from_address(origin) + places_from_address(destination)
    stations, lines, modes = [], [], []
    for leg in (plan or {}).get("legs") or []:
        kind = str(leg.get("type") or "").lower()
        if kind and kind != "walk":
            modes.append(kind)
        if leg.get("line"):
            lines.append(str(leg["line"]))
        for k in ("from", "to"):
            if leg.get(k) and kind != "walk":
                stations.append(str(leg[k]))
    if (plan or {}).get("mode"):
        modes.append(str(plan["mode"]))
    return {"places": places, "stations": stations, "lines": lines, "modes": modes}


def say(result: dict, *, he: bool) -> str:
    """One short line per alert for her, or the honest 'couldn't check'."""
    if not result.get("checked"):
        return ("לא הצלחתי לבדוק עכשיו שיבושי תחבורה בדרך."
                if he else "I couldn't check for transport disruptions right now.")
    alerts = result.get("alerts") or []
    if not alerts:
        return ("בדקתי — אין דיווחים על שיבושים בדרך שלך."
                if he else "Checked — no reported disruptions on your way.")
    head = "⚠️ ייתכן שיבוש בדרך:" if he else "⚠️ Possible disruption on your way:"
    rows = [f"• {a['title']} — {a['link']}" for a in alerts[:3]]
    return "\n".join([head, *rows])
