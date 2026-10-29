"""Central config for the Lumi WhatsApp backend.

Reads from environment (.env in dev via python-dotenv). The LLM defaults point
at Nebius AI Studio (OpenAI-compatible), matching the mobile app — NOT Together.

Dependencies: imported by every other server module (lumi_agent, geo, reminders,
user_store, whatsapp_service, main…) — keep it side-effect free except
load_dotenv().
"""
import logging
import os

from dotenv import load_dotenv

load_dotenv()


def _get(name: str, default: str = "") -> str:
    """Read one env var with a default. All config below routes through here."""
    return os.getenv(name, default)


# ─── WhatsApp Cloud API ───
WHATSAPP_BUSINESS_ACCOUNT_ID = _get("WHATSAPP_BUSINESS_ACCOUNT_ID")
WHATSAPP_BUSINESS_PHONE_ID = _get("WHATSAPP_BUSINESS_PHONE_ID")
WHATSAPP_API_TOKEN = _get("WHATSAPP_API_TOKEN")
WHATSAPP_WEBHOOK_VERIFY_TOKEN = _get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")
WHATSAPP_GRAPH_VERSION = _get("WHATSAPP_GRAPH_VERSION", "v21.0")

# Meta signs webhook deliveries with X-Hub-Signature-256, keyed on the App
# Secret from a Meta *Business* account. We do not have one — the WhatsApp side
# runs through a lightweight/personal gateway — so verification is OPT-IN: unset
# means every delivery is accepted, exactly as before.
#
# The moment a real Meta app exists, `fly secrets set WHATSAPP_APP_SECRET=...`
# turns enforcement on with no code change and no deploy risk. Do not make this
# mandatory before then; it would reject every message we currently receive.
WHATSAPP_APP_SECRET = _get("WHATSAPP_APP_SECRET")

# ─── LLM (Nebius Token Factory, NVIDIA Nemotron) ───
# Reuse the same Nebius creds as the app. EXPO_PUBLIC_* are accepted as a
# fallback so a single .env can power both the app and this server.
LLM_API_KEY = _get("NEBIUS_API_KEY") or _get("EXPO_PUBLIC_NEBIUS_API_KEY")
LLM_ENDPOINT = (
    _get("NEBIUS_BASE_URL")
    or _get("EXPO_PUBLIC_NEBIUS_BASE_URL")
    or "https://api.studio.nebius.ai/v1"
)
# Legacy single-model setting. No chat call reads it: model_router picks a
# Nemotron tier per call. It remains only as the fallback for the graph
# diagram and the usage summary, so its default is the medium tier, not the
# Qwen model this project ran on before the tiers existed.
LLM_MODEL = (
    _get("NEBIUS_MODEL")
    or _get("EXPO_PUBLIC_NEBIUS_MODEL")
    or "nvidia/nemotron-3-super-120b-a12b"
)

# Optional override for Tier-1 extraction (tasks, profile, email events). When
# set it REPLACES the small Nemotron tier for those calls; unset, they go
# through model_router like everything else. GET /health names it.
LLM_MODEL_CHEAP = (
    _get("NEBIUS_MODEL_CHEAP")
    or _get("EXPO_PUBLIC_NEBIUS_MODEL_CHEAP")
    or None
)

# ─── Google Maps (geocoding + directions) ───
#
# The fallback is a landmine and is kept only so a local dev shell with one
# .env still works. The EXPO_PUBLIC_ key is the one compiled into the APK, and
# it is restricted to `meira.secretary` + SHA-1 — a restriction Google enforces
# through headers only the Maps SDK sends. A server using it gets
# REQUEST_DENIED on every Geocoding and Directions call, which is exactly the
# failure `/app/geocode` and `/app/route/directions` exist to END: 107 refused
# calls in one day, reported to the user as "no route for the chosen way of
# getting there".
#
# So falling back is survivable but never correct in production, and it says so
# out loud rather than looking like a working server that finds no routes.
GOOGLE_MAPS_API_KEY = _get("GOOGLE_MAPS_API_KEY")
_MAPS_KEY_IS_THE_PHONES = False
if not GOOGLE_MAPS_API_KEY:
    GOOGLE_MAPS_API_KEY = _get("EXPO_PUBLIC_GOOGLE_MAPS_API_KEY")
    if GOOGLE_MAPS_API_KEY:
        _MAPS_KEY_IS_THE_PHONES = True
        logging.getLogger(__name__).warning(
            "GOOGLE_MAPS_API_KEY is not set — falling back to the APK's "
            "EXPO_PUBLIC_GOOGLE_MAPS_API_KEY, which is restricted to the "
            "Android app and will be REQUEST_DENIED for every route and "
            "geocode. Fix: fly secrets set GOOGLE_MAPS_API_KEY=... -a lumi-whatsapp"
        )

# ─── Google Programmable Search (lumi_agent.web_search) ───
# Free tier: 100 queries/day. Needs the "Custom Search API" enabled on the same
# Google Cloud project and a search engine configured to search the entire web;
# GOOGLE_CSE_ID is that engine's cx id. The Maps key is reused unless a separate
# GOOGLE_SEARCH_API_KEY is set (do that if the Maps key is API-restricted).
GOOGLE_CSE_ID = _get("GOOGLE_CSE_ID")
GOOGLE_SEARCH_API_KEY = _get("GOOGLE_SEARCH_API_KEY") or GOOGLE_MAPS_API_KEY

# The job scout (SerpApi → Google Jobs) and the Claude CV designer were removed
# on 2026-09-07 along with hr_agent. SERPAPI_API_KEY, HR_JOB_QUERIES,
# HR_JOB_LOCATION, ANTHROPIC_API_KEY and ANTHROPIC_MODEL are no longer read by
# anything — clear those secrets on Fly so nobody is billed for a feature that
# does not exist.

# ─── Speech-to-text (Groq hosts Whisper behind an OpenAI-compatible API) ───
# Nebius does NOT serve audio transcription — /audio/transcriptions there
# returned 404 on every voice note, which is why they never worked. Unset keeps
# the old behaviour (ask the user to type) rather than erroring.
GOOGLE_TTS_API_KEY = _get("GOOGLE_TTS_API_KEY")   # optional; else the Maps server key (tts.py)
GROQ_API_KEY = _get("GROQ_API_KEY")

# ─── Embeddings (duplicate-task detection) ───
# Unset disables embeddings entirely and dedup falls back to lexical +
# structured scoring — correct, just less able to spot differently-worded
# duplicates. NOTE: Nebius documents only BAAI/bge-en-icl, which is ENGLISH;
# most Lumi tasks are Hebrew, so verify a multilingual model against this
# account with GET /diag/embed before trusting embedding scores.
EMBED_MODEL = _get("EMBED_MODEL")
EMBED_BASE_URL = _get("EMBED_BASE_URL")   # defaults to LLM_ENDPOINT
GROQ_BASE_URL = _get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
STT_MODEL = _get("STT_MODEL", "whisper-large-v3")

# ─── Supabase (shared tasks table with the mobile + web apps) ───
# Service-role key bypasses RLS — server-side only, set via `fly secrets set`.
SUPABASE_URL = _get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = _get("SUPABASE_SERVICE_ROLE_KEY")

# ─── Server ───
PORT = int(_get("PORT", "8000"))
ENV = _get("APP_ENV", "development")
DATA_DIR = _get("DATA_DIR", ".")  # set to /data on Fly.io via fly secrets

# ─── Encryption at rest (secure_store) ───
# 32 bytes, base64 or hex. When unset, the JSON stores on DATA_DIR are written
# in PLAINTEXT (current behaviour, warned about once at startup) — so the key
# can be introduced without a flag day. Once set, every write is AES-256-GCM and
# legacy plaintext files migrate on their next write.
#   fly secrets set LUMI_DATA_KEY=$(openssl rand -base64 32)
# Losing this key loses the encrypted data; it is not recoverable by design.
LUMI_DATA_KEY = _get("LUMI_DATA_KEY")

# ─── Admin API ───
# Shared secret for /admin/* . These endpoints read personal data (bug reports,
# tasks) and /admin/dedup MUTATES tasks with apply=true, on a public URL — so
# when this is unset the endpoints refuse rather than staying open.
#   fly secrets set ADMIN_TOKEN=$(openssl rand -hex 24)
ADMIN_TOKEN = _get("ADMIN_TOKEN")

# ─── Departure alerts: who delivers them ───
# Wake / leave reminders for a planned trip exist in TWO places. The server
# schedules them here (schedule_departures) and delivers over WhatsApp + Expo
# push; the mobile app schedules its OWN local notifications for the same trip
# from the same route (NotificationService.scheduleTransitNotifications). So one
# departure produced three pings on the same phone: the app's alert, an
# identical push, and the WhatsApp message.
#
# When a phone has registered an Expo push token the app is installed and
# linked, and its alert is the better one — it carries the route, opens the
# LeaveNow screen and has the "יצאתי ✓" button. So the server stands down for
# departure reminders on that phone. Set to 0 to go back to server delivery
# (e.g. if the app is uninstalled but the number is still linked).
APP_OWNS_DEPARTURE_ALERTS = _get("LUMI_APP_OWNS_DEPARTURE_ALERTS", "1") not in ("0", "false", "False", "")

# ─── Tavily (agent-grade web search — lumi_agent.web_search, meeting_brief) ───
# Preferred over Google Custom Search: it returns cleaned page text rather than
# snippets, so one call replaces search-then-fetch-then-read, and it is not
# capped at 100 queries/day. Google stays wired as the fallback.
#   fly secrets set TAVILY_API_KEY=tvly-...
# Server-side ONLY. Never EXPO_PUBLIC_* — that would inline it into every APK.
TAVILY_API_KEY = _get("TAVILY_API_KEY")

# Where share links point (group invites, /g/{token}).
PUBLIC_URL = _get("PUBLIC_URL", "https://lumi-whatsapp.fly.dev")

# ─── LLM budget (model_router) ───
# A monthly ceiling in USD for Nebius model spend. 0/unset = no limit and the
# router never downshifts. Past LLM_BUDGET_SOFT_PCT of it the large tier is
# withdrawn; past 100% every call runs on the small tier. Lumi degrades, it
# never goes dark — a personal assistant that stops answering at month-end is
# worse than one that gets terser.
#   fly secrets set LLM_MONTHLY_BUDGET_USD=25
LLM_MONTHLY_BUDGET_USD = float(_get("LLM_MONTHLY_BUDGET_USD", "0") or 0)
LLM_BUDGET_SOFT_PCT = float(_get("LLM_BUDGET_SOFT_PCT", "0.8") or 0.8)
