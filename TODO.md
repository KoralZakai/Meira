# Lumi — TODO

Single backlog. Source of truth for what is left, in the order it should be done.
Evidence behind most items: [docs/product-audit.md](docs/product-audit.md).

Status key: `[ ]` not started · `[~]` partly done · `[x]` done

---

## 1. Backend consolidation — Python (FastAPI) as the single source of truth  ✅ DONE

Act as a principal backend architect. We are consolidating our system architecture to make Python (FastAPI) the single source of truth for all AI, schedule building, and core business logic.

### Tasks:
1. **Remove Client-Side Agents (TypeScript)**:
   - Deprecate and remove the 9 app-side agents, local task parsers, and prompt files in the frontend code.
   - Refactor the mobile client to act as a "thin client" that strictly sends raw user input (text/voice/location) to the Python backend and renders returned UI data.

2. **Replace LLM Calls with Deterministic Code**:
   - Audit all 12 tools and helper pipelines.
   - Replace LLM-based logic with deterministic Python code for:
     - Whole-day schedule sorting (`buildDaySchedule.ts` equivalent in Python).
     - Date/time arithmetic ("tomorrow", relative offset parsing).
     - Category/priority keyword matching.
     - Distance and simple math tool evaluations.
   - Retain LLM calls ONLY for open-ended chat responses, unstructured task extraction, and email parsing.

3. **Database Unification (JSON to Supabase Postgres)**:
   - Eliminate file-based JSON persistence (`/data`) on Fly.io.
   - Update `database_service.py` / Supabase schema to store all user memory, behavioral routines, and preferences inside Supabase Postgres under the unified `user_id`.
   - Enable `pgvector` on Supabase to handle user memory context retrieval (RAG) instead of dumping full JSON history into prompts.

### Output Required:
Provide a clean refactoring PR outline, the updated Python backend service files, and confirmation that all app-side AI logic has been removed.

### Where it stands right now  (updated 2026-09-06)

Full PR outline: [docs/pr-backend-consolidation.md](docs/pr-backend-consolidation.md).
444 Python tests (was 389), TypeScript suite green, Android bundle builds.

**Step 1 — app-side agents removed. ✅**

- [x] Deleted: `LLMService.ts` (831 lines), `TaskSplitter.ts`, `NebiusClient.ts`, and the two tests that exercised the deleted pipeline
- [x] Rewritten to call the server: `TaskParser.ts` (713 → 523), `LumiCoachEngine.ts`, `LumiOnboardingAgent.ts`, `LumiAgentService.ts`, `GoogleSync.ts`, `MyTasks.tsx`
- [x] `TaskIntent.ts` dropped its LLM fallback — rules only
- [x] New `src/services/LumiServer.ts` — the entire client surface, 5 functions
- [x] `EXPO_PUBLIC_NEBIUS_API_KEY` is no longer required by the build, and is now BLOCKED if it reappears
- [x] Verified: `grep -rniE "nebius|chat/completions|openai" src/` finds no call, only comments
- [x] **Rotate the Nebius key** — done 2026-09-07. New key issued and set as a Fly
  secret; `EXPO_PUBLIC_NEBIUS_API_KEY` deleted from the EAS `preview` environment,
  so it is no longer compiled into the APK. The old key shipped in every build to
  date and should still be treated as public.
- [x] Kept on the phone: the deterministic router in `LumiCoachEngine`, `TaskIntent`, `LumiBrain`, local alarms, the AsyncStorage cache, `fallbackParse` (offline capture), `localFallbackExtraction` (offline onboarding)

**Step 2 — deterministic Python. ✅**

- [x] `server/day_schedule.py` — port of `buildDaySchedule.ts` (cursor never in the past, fixed times own their slot, 3h study floor, priority→clock)
- [x] `server/categorize.py` — the keyword table, Hebrew first-class, model may only fill blanks
- [x] Date arithmetic already deterministic via `tz.resolve_date`; extraction now copies the user's words and lets Python resolve them
- [x] New deterministic `build_day_schedule` tool + prompt told to read its order back, not re-sort it
- [x] `LLM_MODEL_CHEAP` is used by all five new endpoints (defined for months, never used)
- [x] LLM retained only for: open-ended chat, unstructured extraction, email parsing
- [x] **Prompt caching.** The system prompt opened with the clock, the user's name and today's date, so the ~18KB of rules behind them missed the cache on every message. The invariant rules are now a module constant emitted FIRST (`lumi_agent._STATIC_RULES`, 18,323 chars — **92% of the prompt**, byte-identical across users and turns), and everything per-user/per-turn moved to the tail, where the language lock and personality also sit closest to the message. Verified line-for-line against the old prompt: nothing lost, only reordered. `test_prompt_cache.py` fails if a variable line creeps back to the top.
- [x] **One agent loop per message.** Already true once the app's agent was deleted — the 20–90 s path was `LLMService` running a full loop per task on the phone. The server calls `handle_whatsapp_message` once per message (`agent_turn.run_turn`), one `agent.ainvoke` plus an optional retry, and there is no per-task loop left on either side.
- [x] **Clash resolver ported to Python** — `server/clashes.py`, rule for rule, same option kinds in the same order. Exposed to the agent as `find_clashes(date)`, so WhatsApp can now answer "does this day work?" instead of having no opinion. Parity is not a claim: `tests/run-clash-parity.ts` runs the TypeScript over `tests/fixtures/clash-days.json` and writes a golden file, and `server/tests/test_clash_parity.py` runs the same fixtures through Python and compares every option, time, label and question in both languages. 6 days, 5 clashes, identical.
- [ ] The travel estimate inside a clash is the route from **home** to the second
  task, not from the first task to the second — `travelMinutesBetween` reads
  `to.location.travelMinutes`, and falls back to a flat 15 min when there is no
  route at all. Good enough to offer "leave by 17:45"; wrong whenever the two
  places are not both near home. Needs a real leg-to-leg lookup. The Python
  port has the seam ready — `clashes.travel_minutes_between(first, second,
  leg_lookup=…)` takes an estimator and falls back to today's heuristic when it
  cannot answer — so the remaining work is supplying one from the routing code,
  and then teaching the TypeScript the same answer.

**Step 3 — database unification. ✅ APPLIED TO PRODUCTION 2026-09-07.**

- [x] Migrations `0007_server_state.sql`, `0008_server_operational.sql`, `0009_backfill_idempotency.sql` applied to Supabase (`ybagugvwqtjtbllgxyin`) — 13 tables, RLS verified on all 13, pgvector installed, `lumi_match_memories()` live
- [x] `server/database_service.py` — the single door; `shadow_write` for the sync stores
- [x] All 12 remaining JSON stores wired (`test_stores_shadowed.py` fails if one is ever left behind)
- [x] Backfill run on the live volume: **127 rows moved**, verified table by table, and stable across three further runs
- [x] `server/memory_recall.py` — pgvector retrieval. `EMBED_MODEL` **is already set on the live server**, so this is on
- [x] Deployed to `lumi-whatsapp` (the app holding the `lumi_data` volume — NOT the `lumi-my-ai-assistant` that `fly.toml` names)
- [x] **`fly.toml` fixed** — now the live `lumi-whatsapp` config (port 8000, ams, `lumi_data` mounted), verified byte-for-byte against `fly config save` so a deploy changes no configuration. A bare `fly deploy` was run to prove it: right app, volume still mounted, health OK. The header explains the trap so the file cannot be regenerated wrong.
- [ ] Delete the stale `lumi-my-ai-assistant` app — it has no volume, serves nothing, and answering `/health` is exactly what makes it convincing
- [ ] Retire the `/data` volume once the shadow writes have been watched for a while (`pending_mirror.json` and `active_session.json` stay on it by design)
- [ ] Delete the orphaned HR files still on the volume: `cv_master.json`, `hr_pending.json` (58KB) — personal data and irreversible, so left for you
- [ ] Fix `tasks.location` (object vs string) and the 5 competing ID schemes
- [ ] Automated backups

---

## 2. Remove the HR agent from WhatsApp  ✅ DONE

- [x] Deleted `server/hr_agent.py`, `server/cv_pdf.py`, `server/referral.py`, `server/cv_master.sample.json` and the four test modules
- [x] Removed the HR command path in `server/main.py` (`_HR_COMMAND_RE`, `_hr_job_query`, `_extract_city`, both `handle_approval` calls, the CV-PDF and LinkedIn-CSV document branches). `_number_belongs_to` stays — it is what stopped a bare "1" meant for a bus being read as a job pick
- [x] Removed the `hr_job_search` template and its interception in the agent poller (`agent_runner`, `agents_store`)
- [x] `SERPAPI_API_KEY` **unset on Fly**; `ANTHROPIC_API_KEY` was never set there
- [x] `pypdf` and `weasyprint` out of requirements, and with them the Dockerfile's whole apt-get layer (Pango, Cairo, harfbuzz, three font packages) — the new image is 98 MB
- [x] Config entries removed: `SERPAPI_API_KEY`, `HR_JOB_QUERIES`, `HR_JOB_LOCATION`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- [ ] Delete the stored CVs on the volume (`cv_master.json`, `hr_pending.json`) — personal data, irreversible, left for you

---

## 3. Open work not yet done

### 🔴 Blocking / risk

- [ ] **Authentication — top risk.** 10 server routes have zero auth: `/tasks/{phone}`, `/agents/{phone}`, `/link/verify/{phone}`, `/push/register` and others. Knowing a phone number is the only credential. `/agent/chat` already does it correctly with Supabase token verification — apply that same pattern everywhere.
- [ ] **Verify the WhatsApp webhook signature** — currently forgeable.
- [ ] **Unexplained task loss: 154 → 113 → 92 across syncs.** `syncAllTasks` now deletes only rows that positively identify as app-created, which stops that shape of loss but recovers nothing. Root cause still unknown.
- [ ] **Encrypt personal data at rest** — memory, conversations, `.md` files. `server/secure_store.py` exists (uncommitted); finish and adopt it everywhere.
- [ ] `/diag/sync` leaks DB internals with no auth.
- [ ] No retry queue for failed cloud writes.
- [ ] The server JSON store has no locking (resolved by 1.3).
- [ ] WhatsApp dedup is in-memory — lost on every restart.

### 🟠 Product features still owed

- [ ] **3.1 STT through the server.** Add `POST /stt` wrapping the existing Groq `whisper-large-v3` in `server/stt.py`, plus an audio recorder in the client (`expo-speech-recognition` returns transcripts, not buffers). Do **not** ship an on-device Hebrew model — smallest is ~537 MB against a 90 MB APK.
- [ ] **3.2 Lumi should speak** — short, warm, human. `expo-speech` already drives the morning briefing; extend it to alerts.
- [ ] **3.3 Phase 3** (needs its own dedicated session — days, not hours):
  - Known-places store with coordinates (gym, work, studies, supermarket)
  - Real learning of habits and routines
  - Clustering tasks by location
  - An undated backlog — `Task.date` is required today, so "sometime" becomes overdue tomorrow
  - A real `optimize_day` — the current one only sorts; it assigns no times and ignores travel
- [ ] **3.4 Dynamic origin from GPS.** `utils/positionDrift.ts` (`assessDrift`, `describeReplan`, `npm run test:drift`) is written and tested but still has **zero consumers**. Wire it to the alert path and the map.
- [ ] **3.5 Confirm push delivery.** Firebase project `lumi-db02c` is wired but has never delivered — needs the FCM private key uploaded (Koral's to do). It logs an error every ~30 s meanwhile. Local alarms are unaffected.
- [ ] **3.6 MCP connectors** — Telegram, Outlook, Teams, Slack, calendars.
- [ ] **3.7 Two-way Google Calendar sync** — editing in Google does not update Lumi today.
- [ ] **3.8 Contact lookup** — `search_contacts` is a stub that does nothing.

### 🟡 Quality, cost and hygiene

- [x] **Add CI.** ✅ 2026-09-21. `.github/workflows/tests.yml` runs the Python
  suite, the TypeScript suites and a clash-golden freshness check on every push
  and PR, and `fly-deploy.yml` now `needs:` it — a red suite stops the deploy.
  The manual override is a visible `skip_tests` input, not the default.

  Four things were found by turning it on, all the same shape — *the suite's
  greenness was a fact about the machine, not the code*:

  - **`pytest-asyncio` was declared nowhere.** On a clean checkout the four
    GDPR account-erase tests failed. `server/requirements-dev.txt` declares it.
  - **`tsx` was not a dependency either.** All 64 TypeScript suites ran through
    whatever version `npx` fetched from the registry at that moment. Now a
    pinned devDependency, resolved from `node_modules/.bin` — which also took
    the suite from 26 s to **8.2 s** (it was ~79 s before concurrency).
  - **11 of 68 test scripts were never invoked.** `test:all` was a hand-written
    57-link `&&` chain. `tests/run-clash-parity.ts` had no script at all.
    `scripts/run-ts-tests.mjs` discovers `tests/run-*.ts` instead, so a suite
    cannot be forgotten, and it reports ALL failures rather than stopping at
    the first.
  - **`test:wake` had been red for a week.** It asserted the retired
    `'earlier-than-usual'` alarm rule; the shipped default is `'every-morning'`
    (`1c1c273`). Nobody saw it because the chain never ran it.

  Removed: `tests/run-edd.ts`, `tests/edd-evaluator.ts` and their exclusive
  fixtures. The harness imported `services/TaskParser`, which pulls
  react-native and cannot load under tsx — it had never been runnable.
  `nebius/job-eval/evaluate.py` is a self-contained Python port and is
  unaffected; the docs that pointed at the deleted files were corrected.
- [ ] Crash reporting and an uptime monitor — if the reminder poller dies silently, nobody finds out.
- [ ] Product analytics — zero telemetry today; cannot answer "does anyone finish onboarding".
- [ ] Clear the 29 accepted TypeScript errors.
- [ ] Collapse the **3 different "add task" flows** into one, and the **2 live home screens** into one — same sentence, three flows, three results
- [ ] Swipe navigation with a page indicator instead of the bottom tab bar (the current app contradicts `CLAUDE.md`)
- [ ] Split `server/main.py` (2,329 lines, no routers) into routers.
- [ ] Version the 23 KB server prompt and stop the LLM judge rewriting it every 10 replies with no human review.
- [ ] Rate-limit handling for every external API — there is none anywhere.
- [ ] One geocoder, not two that disagree on the same address.
- [ ] Cache route calculations — recomputed on every screen refresh.
- [ ] Drop the background-location permission (requested for one minor feature; Play Store review risk).
- [ ] Fix the Hebrew number-word regex — `\b` does not match Hebrew letters, so that path is dead code.
- [ ] Remove the unconditional 3-hour minimum applied to anything tagged "study".
- [ ] Repo cleanup: 9 contradicting root-level docs, a 94 MB APK committed in the tree, 2 unrelated vendored directories.
- [ ] GDPR export / delete flow.
- [ ] Read the two bug reports Koral filed via the WhatsApp bug agent — `/admin/bugs` needs `ADMIN_TOKEN` (set on Fly, not held locally).
- [ ] Restart the bug-agent daemon: `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.lumi.bugagent.plist`

---

## Order of work

1. ~~Auth~~ — done in a previous cycle (`test_route_authorization.py` guards it)
2. ~~Task 1 step 1~~ — the TS agents are deleted
3. ~~Task 1 step 2~~ — deterministic Python
4. ~~Task 2~~ — the HR agent is gone
5. ~~Task 1 step 3~~ — Supabase + pgvector, applied and backfilled
6. ~~Fix `fly.toml`~~ — done
7. ~~CI~~ — done: tests gate the deploy (see above)
8. Phase 3 (3.3) — dedicated session
