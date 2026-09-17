# PR outline — Python (FastAPI) becomes the single source of truth

**Branch:** `feat/backend-consolidation` · **Base:** `master`
**Tests:** 421 Python (389 before, minus 35 HR tests, plus 67 new) · TypeScript suite green · Android bundle builds
**Net:** −1,373 lines of app-side AI, −2,000+ lines of HR agent, +2,400 lines of server (services + tests + schema)
**Status:** applied to production 2026-09-07 — migrations run, 127 rows backfilled, deployed to `lumi-whatsapp`

---

## Why

Two brains ran the same job. The phone carried an API key in its bundle, a
12-tool ReAct loop, four task extractors and three schedule builders; the server
carried 19 tools, memory, personality and 362 tests. Every divergence bug in the
last six months traces to that split, and the Flutter port would have had to
port the weaker half.

This PR deletes the phone's half, moves the work it was doing to Python, and
replaces the LLM calls that were never language problems with plain code.

---

## PR 1 — Deterministic core (`server/day_schedule.py`, `server/categorize.py`)

The day was already computed correctly by local code; the server then paid a
235B model to redo the same sort, and clamped the model's answer with the local
one anyway. Sorting a list is not a language problem.

| File | What it does |
|---|---|
| `server/day_schedule.py` | Port of `src/utils/buildDaySchedule.ts` — cursor never starts in the past, fixed times own their slot, 3h study floor, priority→clock ordering. Reads snake_case and camelCase so the app and the agent share it. |
| `server/categorize.py` | The keyword table that was wrapped in an LLM round-trip. Hebrew is first-class in every rule; `merge()` lets the table win where it matched and keeps the model's guess only where it had no opinion. |
| `server/task_store.py` | `fetch_task_rows` lifted out of a closure inside `lumi_agent`, so the app's endpoints read rows through the same function instead of a second copy. |

Wired into `lumi_agent`: `infer_task_details` now labels through `categorize`,
and a new deterministic `build_day_schedule` tool replaces "ask the model to
order the day". The prompt is told to read the tool's order back, not improve it.

**Tests:** `server/tests/test_deterministic_core.py` (16).

## PR 2 — The thin client's doors (`server/routes_app.py`)

First FastAPI **router** in the codebase — `main.py` is 2,386 lines with every
route at top level; new routes go in routers from here.

| Endpoint | Model calls | Replaces |
|---|---|---|
| `POST /app/schedule/build` | **0** | `LLMService.build_schedule` + the "✨ AI" refine path |
| `POST /app/tasks/extract` | 1 (cheap model) | `TaskParser`'s on-device Nebius call |
| `POST /app/profile/extract` | 1 (cheap model) | `LumiOnboardingAgent` |
| `POST /app/checkin/parse` | 1 (cheap model) | `LumiAgentService` |
| `POST /app/email/events` | 1 (cheap model) | the LLM call inside `GoogleSync` |

All five authenticate the way `/agent/chat` always did: the Supabase access
token, verified by Supabase. All five use `config.LLM_MODEL_CHEAP` — defined for
months, never used until now.

New services: `task_extract.py`, `profile_extract.py`, `checkin_parse.py`,
`email_events.py`. Each keeps the model for the language work and takes the
consequential decision away from it — dates come from `tz.resolve_date`, labels
from `categorize`, onboarding completeness from code, and an event that cannot
be dated is dropped rather than hopefully kept.

**Tests:** `test_app_routes.py` (7), `test_thin_client_extractors.py` (10).

## PR 3 — Delete the app's agents

Deleted outright: `LLMService.ts` (831), `TaskSplitter.ts` (124),
`NebiusClient.ts` (46), and the two test files that exercised the deleted
pipeline.

Rewritten to call the server, keeping their deterministic offline half:
`TaskParser.ts` (713 → 523), `LumiCoachEngine.ts`, `LumiOnboardingAgent.ts`,
`LumiAgentService.ts`, `GoogleSync.ts`, `MyTasks.tsx`.
`TaskIntent.ts` simply dropped its LLM fallback — choosing one of four words is
not work for a 235B model, and a wrong rule costs the same confirmation tap the
wrong guess did.

New: `src/services/LumiServer.ts` — the whole client surface, five functions,
each returning `null` (never throwing) so the phone falls back to what it can
still do offline.

`scripts/prepare-build-env.mjs` no longer requires `EXPO_PUBLIC_NEBIUS_API_KEY`
and no longer exempts it: it matches `CREDENTIAL_ISH`, so if it ever reappears
in a bundle the build **fails** instead of warning.

> **Action for a human:** rotate the Nebius key. It shipped inside every APK
> built to date and must be assumed public.

## PR 4 — JSON files → Supabase Postgres + pgvector

| File | What it does |
|---|---|
| `supabase/migrations/0007_server_state.sql` | 9 tables keyed on the unified `userKey`, RLS on all of them, `vector` column, and `lumi_match_memories()` for retrieval. |
| `server/database_service.py` | The one door to that state. Same degrade-quietly contract as `supabase_tasks`. `shadow_write` lets the synchronous JSON stores mirror into Postgres without blocking a reply on it. |
| `server/migrate_json_to_supabase.py` | Idempotent backfill, `--dry-run` first, deletes nothing. |
| `server/memory_recall.py` | The retrieval this product never had: embed the message, ask pgvector for the nearest facts, hand the prompt those instead of the five most recent. |

Wired: `user_profile.update_profile` and `user_memory.add_insight` now shadow
into Postgres; `lumi_agent` prefers a retrieved memory block and falls back to
the recency block when embeddings or Supabase are not both configured.

**Tests:** `test_database_service.py` (15), `test_memory_recall.py` (7).

---

## What actually ran in production (2026-09-07)

| Step | Result |
|---|---|
| Migrations 0007 + 0008 + 0009 | Applied via the Supabase SQL editor. **13 tables, RLS enabled on all 13**, pgvector installed, `lumi_match_memories()` live |
| Backfill dry run | First attempt reported 0 for conversations / known_places / travel_prefs — three readers written from docstrings rather than bytes. Fixed, then **127 rows** |
| Backfill | 127 rows moved; verified table by table against the dry run's numbers |
| Idempotency | The first re-run **duplicated** conversations (18→36) and sessions (2→4) — surrogate keys with nothing to conflict on. Migration 0009 added a nullable `dedupeKey` + unique index; duplicates removed; three further runs now leave the counts unchanged |
| Deploy | `lumi-whatsapp`, health OK, all five `/app/*` endpoints returning 401 unauthenticated, WhatsApp webhook still verifying |
| Live memory | 122 MB RSS of a 207 MB machine, 75 MB available. No before-figure was captured, so this is a reading, not a measured drop |
| Secrets | `SERPAPI_API_KEY` unset on Fly; `ANTHROPIC_API_KEY` was never set there |

### The fly.toml trap — fixed 2026-09-07

`fly.toml` in this repo says `app = 'lumi-my-ai-assistant'`, `internal_port = 8080`, and carries **no volume mount**. The live backend is `lumi-whatsapp`: port 8000, region ams, with `lumi_data` mounted at `/data`. A plain `fly deploy` therefore goes to the wrong app — and deploying that config *to* the right one would have changed the port (instant outage) and unmounted the volume, which would have left the backfill reading an empty `/data` and reporting "0 rows moved" as success. Deploys during the migration used `fly deploy -c <saved live config> -a lumi-whatsapp`. The file has since been replaced with the live configuration — verified byte-for-byte against `fly config save -a lumi-whatsapp`, so deploying it changes nothing — and a bare `fly deploy` was run to prove it lands on the right app with `lumi_data` still mounted. The header now carries this explanation, because the failure mode is a config file that looks fine.

## What is deliberately NOT in this PR

- **`pending_mirror.json` stays on disk.** It is the retry queue for writes that
  failed *because* Supabase was unreachable. A queue for "the database is down"
  cannot live in the database.
- **The remaining JSON stores** (reminders, agents, conversations, known_places,
  travel_prefs, sessions, llm_usage, bug_reports) have tables and service
  methods, but their modules still write only to disk. The pattern to follow is
  the two already wired — a one-line `shadow_write` per writer.
- **Nothing has been run against the live database.** The migration and backfill
  are written and tested against a stubbed HTTP layer; applying them needs
  Supabase credentials this session did not have.

## Rollback

Each PR is independently revertible. PR 4 is the safest of all: stop calling
`database_service` and the JSON files are still authoritative and current,
because they never stopped being written.
