# Lumi — Product & Architecture Audit

**Commit:** `6cc161c` (branch `DayTimeline`, 12 files modified in the working tree) · **Date:** 2026-09-08
**Verified this pass:** 488 Python tests pass · 42 TypeScript suites pass (`npm run test:all`, plus the two new ones) · `tsc --noEmit` reports 25 accepted errors in 7 files.

> **Updated 2026-09-08, after the fix pass.** Five items below have been fixed and are marked ✅ where they appear. One finding in the original was **wrong**: `/diag/sync` is *not* unauthenticated — it calls `_require_admin` 26 lines into its own docstring, past where the audit script looked. Corrected in §12.

This replaces the audit written at `34644a4`. That one's central question — *two agents do the same job, which one survives?* — is answered and closed. The phone no longer makes a single model call. What follows is the shape of the product as it now actually is.

---

## 0. What changed since the last audit

| Then (`34644a4`) | Now (`6cc161c`) |
|---|---|
| Two brains: a 12-tool TS agent on the phone, a 19-tool Python agent on the server | **One brain.** `grep -rniE "nebius\|openai\|chat/completions" src/` finds no call site — only comments explaining where it went |
| `EXPO_PUBLIC_NEBIUS_API_KEY` compiled into every APK | Key rotated, removed from the EAS `preview` env, blocked from returning. The old key must still be treated as public |
| LangGraph ReAct loop, ~35 MB resident on a 256 MB machine, OOM-killed in production | `server/react_loop.py` — our own loop against the OpenAI SDK, same tool contract, ~90 lines |
| Server state in ~15 flat JSON files on one Fly volume | Supabase Postgres + pgvector (migrations 0007–0009), 13 tables, RLS on all of them, 127 rows backfilled; JSON kept as a shadow mirror |
| The whole memory blob pasted into every prompt | `memory_recall.py` — embed the message, retrieve the 8 nearest facts (`lumi_match_memories`, cosine ≥ 0.35) |
| Auth by phone number in the URL | Supabase bearer token on every app route (`app_auth`) |
| Flutter rewrite planned | Dropped (`25bb709`). The Expo app is the app |
| HR/job-scout agent | Deleted, with SerpApi and Anthropic keys unset |
| Departure alerts fired three times per trip | The **phone** owns departure alerts; the server stands down when a live Expo token exists (`reminders._app_owns_departures`) |

Two things landed in the working tree and are not yet committed: `src/utils/dayWindow.ts` (the day list no longer hides the afternoon) and the departure-ownership change above.

---

## 1. Current architecture

```
  WhatsApp (Meta Cloud API)  ──webhook──┐
                                        │
  Android app (Expo/RN)  ──HTTPS+JWT──► FastAPI on Fly.io  ──► Nebius (Qwen3-235B)
      │  local: alarms, GPS, cache          `lumi-whatsapp`   ──► Google Maps / Directions
      │                                      ams · 1 machine  ──► Groq (Whisper, WA voice)
      │                                      /data volume     ──► Expo Push
      └──────────Supabase JS SDK────►  Supabase Postgres  ◄──service-role──┘
                                       (tasks + lumi_* server state, pgvector)
  Next.js web app (web/)  ── unused in production
```

Three clients on paper, two in practice (the `web/` app and the two vendored `lumi/`, `lumi avsha/` directories are not part of the shipped product). One server, one database, one model provider.

**The division of labour is now explicit and is the product's best structural property:**
the phone is the *sensor and the siren* (GPS, alarms, notifications, offline cache); the server is the *brain* (the only place that holds a secret, the only thing awake when the app is closed); Supabase is the *shared truth*.

---

## 2. Current frontend

Expo SDK 56 / React Native 0.85 / React 19, TypeScript, Android only. ~37.5 K lines across `src/`.

- **Navigation:** `@react-navigation` native stack + a bottom tab bar (`MainTabs`: Today · Tasks · Trips · Profile), and 22 stack screens above it. This still contradicts `CLAUDE.md`, which specifies swipe navigation with a dot indicator and *no* bottom bar.
- **Screens:** 30. Five are over 900 lines and mix layout, storage, routing and notification scheduling in one file — `TodaySchedule.tsx` (1,302), `HomeScreen.tsx` (1,091), `CheckInScreen.tsx` (1,022), `TripsScreen.tsx` (952), `MyTasks.tsx` (932).
- **State:** no store. `useTasks` + `useFocusEffect` re-reads from `TaskStorage` on every screen focus. Cross-screen coordination happens through AsyncStorage and a 25-line event bus (`LumiMood`).
- **Newest UX work (this branch):** `DayTimeline` + `timelineLayout` + `timelineNow` draw the day as a real timeline with the current moment on it; `dayWindow` decides which cards survive the cap — keeping what is *ahead* rather than the first six by clock.
- **Client-side AI: none.** `TaskParser`, `LumiOnboardingAgent`, `LumiAgentService` and `LumiCoachEngine` are now HTTP clients with deterministic offline fallbacks. `LumiServer.ts` is the whole surface: five functions.

## 3. Current backend

FastAPI on Fly.io (`lumi-whatsapp`, ams, 1 shared-cpu machine, 512 MB swap, `/data` volume). ~13.8 K lines of Python.

- `main.py` is **2,303 lines** with 24 top-level routes and ~40 module-level helpers. `routes_app.py` is the first and only `APIRouter` — the pattern is established, the migration is not done.
- Two background pollers started in `lifespan`: `reminders.run_reminder_loop()` (20 s) and `agent_runner.run_agent_loop()` (60 s).
- **Deterministic modules ported off the phone this cycle:** `day_schedule.py` (the schedule builder), `categorize.py` (category/priority/duration keyword table), `clashes.py` (the clash resolver, parity-tested against the TypeScript over golden fixtures), `tz.py` (relative-date arithmetic).
- **Guard rails around the model** — this is unusual and worth naming: `task_rescue.py` (saves the task when the model claims it did and did not), `reply_consistency.py` (rewrites a reply that names a different day than what was stored), `provenance.py` (a closed channel enum on every task), `dedup_service.py`, `agent_turn.override_task_date` (forces the deterministic date when the message carries exactly one relative expression).

## 4. Current AI architecture

One agent, one loop, one door per channel.

```
WhatsApp webhook ─┐
                  ├─► agent_turn.run_turn ─► lumi_agent.handle_whatsapp_message
POST /agent/chat ─┘                             │
                                                ├─ system prompt (static rules + per-user tail)
                                                ├─ conversation history (sanitised)
                                                ├─ memory block (pgvector recall, else recency)
                                                └─ react_loop.create_react_agent → 21 tools
                                                       ↓
                        task_rescue · reply_consistency · provenance · dedup → Supabase
                                                       ↓
                        reminders.schedule_departures → WhatsApp / Expo push
                                                       ↓
                                       judge_service.evaluate (fire-and-forget)
```

### Agents

| Agent | Where | Loop | Tools | Notes |
|---|---|---|---|---|
| **Lumi** (the brain) | `lumi_agent.py`, 1,734 lines | `react_loop`, recursion limit 15, 4 transient retries | 21 | Serves both WhatsApp and the app's Chat tab |
| **User agents** | `agent_runner.py` | none — one completion | **0 by design** | Deterministic prefetch of facts → the model only *phrases* them, so it cannot invent a route and cannot message anyone but its owner |
| **Judge** | `judge_service.py` | none | 0 | Scores every reply; rewrites the guidelines file every 10 evals |
| ~~HR / job scout~~ | deleted | | | |

### Tools (21)

`infer_task_details` · `save_profile` · `plan_departure` · `build_day_schedule` · `find_clashes` · `get_my_tasks` · `find_task` · `update_task` · `check_availability` · `calculate_date` · `schedule_message` · `save_memory` · `set_reminder` · `list_reminders` · `web_search` · `find_place` · `create_agent` · `list_my_agents` · `update_my_agent` · `delete_my_agent` · `send_app_link`

`CLAUDE.md` still documents a 12-tool list that includes `search_contacts`, `search_gmail`, `get_calendar_events`, `suggest_gap_filler`, `verify_task_duration` and `optimize_day`. **None of those six exist on the server.** Gmail and Calendar are read on the phone with the user's own Google token; contact resolution happens through shared WhatsApp contact cards. The spec is stale.

### LLM calls — every site

| # | Site | Model | Purpose | Genuinely language work? |
|---|---|---|---|---|
| 1 | `react_loop` (agent turn) | `LLM_MODEL` | Conversation + tool selection | ✅ |
| 2 | `lumi_agent._extract_profile` | `LLM_MODEL` | Forced `save_profile` extraction — only while profile fields are missing | ✅ |
| 3 | `task_extract` | `LLM_MODEL_CHEAP` | Which words are the tasks | ✅ |
| 4 | `profile_extract` | cheap | Onboarding answer → fields | ✅ |
| 5 | `email_events` | cheap | Gmail subject/snippet → appointment | ✅ |
| 6 | `checkin_parse` | cheap | Check-in intent + update targets | ⚠️ **see §20** |
| 7 | `judge_service` | `LLM_MODEL` | Score every reply | ⚠️ cost + unreviewed prompt mutation |
| 8 | `agent_runner` | `LLM_MODEL` | Phrase precomputed facts | ✅ |
| 9 | `dedup_service.embed_texts` | `EMBED_MODEL` | Embeddings | ✅ |
| 10 | `stt.py` | Groq `whisper-large-v3` | WhatsApp voice notes | ✅ |

### Prompts

- `_STATIC_RULES` — **18,323 characters, 92% of the prompt**, a module constant, byte-identical across users and turns. Deliberately emitted *first* so a provider can cache the prefix; everything per-user (name, home, today's date, the personality block, the language lock) is appended after it. `server/tests/test_prompt_cache.py` fails if a variable line creeps back to the top.
- **But the invariant is enforced one layer too low.** `handle_whatsapp_message` builds the final prompt as:
  ```python
  base = f"WHAT I KNOW ABOUT YOU:\n{mem_block}\n\n{base}"     # varies per user AND per message
  system_prompt = f"{guidelines}\n\n{base}"                    # rewritten every 10 replies
  ```
  Both variable blocks land **in front of** the 18 KB static prefix, so in production the cacheable prefix is whatever the retrieved memory happens to be — usually nothing. `test_prompt_cache.py` tests `_system_prompt` in isolation and passes anyway. **This is the single highest-value cost fix available**, and it is a two-line move.
- The judge rewrites `lumi_guidelines.txt` every 10 replies with no human review, and that file is prepended to the prompt. It is versioned nowhere except a shadowed table.

### Memory & RAG

- **Distilled facts only**, never raw transcript. Kinds: `behavior`, `preference`, `routine`, `contact`, `task`.
- Storage: `lumi_memories` with a dimensionless `vector` column (pgvector; `EMBED_MODEL` is Qwen3-Embedding-8B at 4096 dims, above pgvector's 2000-dim ANN index cap — so exact search, fine at current row counts, needs an `hnsw` index and a pinned dimension later).
- Retrieval: top-8, cosine ≥ 0.35, degrades to the old recency block on any failure. Merge threshold for treating two memories as the same fact is 0.912 — do not lower it.
- Conversation history: last few turns per user (`conversation.py`), sanitised for degenerate model output before being replayed.
- Short-lived per-user *focus* (`session.py`) records which task is being discussed, so "from home, by bus" attaches to the right appointment.

## 5. Database

**Supabase Postgres** (project `ybagugvwqtjtbllgxyin`), 9 migrations, RLS on every table.

| Group | Tables |
|---|---|
| App domain (0001–0006) | `tasks`, `user_profiles`, `user_stats`, `app_settings`, `goals`, `daily_logs`, `schedules`, `reward_events`, `custom_categories`, `personality_quiz` |
| Server state (0007) | `lumi_identities`, `lumi_memories`, `lumi_profiles`, `lumi_conversations`, `lumi_reminders`, `lumi_agents`, `lumi_known_places`, `lumi_travel_prefs`, `lumi_sessions` |
| Operational (0008–0009) | `lumi_user_records`, `lumi_llm_usage`, `lumi_bug_reports`, `lumi_judge_log` |

The unified key is `userKey` — the linked WhatsApp number when one exists, else the Supabase auth user id, with `lumi_identities` mapping both ways.

**Still true, still a problem:**
- The JSON files on `/data` are still written first by every sync store; Postgres is a `shadow_write`. `pending_mirror.json` and `active_session.json` stay on the volume by design.
- ~~**Two different read orders for the same data.**~~ ✅ **Fixed.** Both callers go through `task_store` now: Supabase first, the JSON mirror when it is unreachable or has not seen the user, and `source` on the response says which. Date bounds became optional so the app's whole-list sync could use the same door; `include_location=True` keeps the route on WhatsApp-planned tasks.
- Five competing id schemes (app random, `gcal-*`, `gmail-*`, server uuid, legacy `wa_*`) and `tasks.location` is sometimes an object and sometimes a string.
- No automated backups.

## 6. Location services

`expo-location` on the phone: foreground fix, reverse geocode, distance, background updates, open-in-maps. `ACCESS_BACKGROUND_LOCATION` is requested for one minor feature (nearby-task nudges) — a Play Store review risk for the value returned.

`LiveRoute` + `positionDrift` + `presence` are the good part: the phone is the sensor, the decision is pure and unit-tested, the re-plan is a server-shaped call. `positionDrift` had zero consumers at the last audit; it now has five.

## 7. Routing

**Two independent routing stacks against the same Google APIs.**

| | Client | Server |
|---|---|---|
| Module | `RoutePlanner.ts` + `MultiModalPlanner.ts` (~670 lines) | `geo.py` (598 lines) |
| Key | `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` — **compiled into the APK** | `GOOGLE_MAPS_API_KEY`, a Fly secret |
| Endpoints | Directions, Place Text Search | Directions, Geocode, Place Text Search, Static Maps |
| Chaining | `GoogleSync.ensureTravelChain` | `daychain.py` |

Both derive leave/wake times backwards from an arrival. They are kept close by tests, not by construction. Recent fixes have had to be applied on both sides (`0cc49c2` "train means train", `a6ab97b` "pick the direct train").

## 8. Calendar integrations

Google Calendar and Gmail, read on the **phone** with the user's own OAuth token (`gmail.readonly`, `calendar.readonly`, `calendar.events`). `GoogleSync` pulls a week of events into tasks, scans Gmail for appointments not yet on the calendar, and writes an accepted suggestion back to the real calendar. The mailbox never reaches the server — only extracted subjects and snippets, via `POST /app/email/events`.

Sync is **one-way**: editing an event in Google does not update Lumi.

## 9. STT

- **App:** `expo-speech-recognition`, `he-IL`, EAS builds only (no-ops in Expo Go, TextInput fallback). Returns transcripts, not audio buffers. Transcript preprocessing (filler removal, Hebrew place-name correction) runs locally in `SpeechService`.
- **WhatsApp:** voice notes go to Groq `whisper-large-v3` (`stt.py`). Nebius has no `/audio/transcriptions` endpoint — that 404 is why voice notes silently failed for months.
- **Not built:** `POST /stt` for the app. The app cannot use the server's Whisper because it has no recorder.

## 10. TTS

`expo-speech`, short output only, `he-IL`/`en-US` from the profile. Used by the morning briefing, Today, Check-in and Onboarding. **It cannot speak from a locked screen** — a notification can play a sound and show text; making the phone talk on its own would need a native module outside Expo. Alerts are currently silent-with-text.

## 11. Notifications

Local (`expo-notifications`, EAS only) on two Android channels: `default` and `wake-alarm` (max importance). Real system alarms go through `AlarmClock.ACTION_SET_ALARM`, armed only inside Android's 24 h reach — `AlarmPlanner` is the state machine that comes back to arm a far-future one.

Coverage: wake · get-ready · leave · "still at home?" nags with an **"יצאתי ✓" action button** (now localised, and now sharing one `LiveRoute.confirmDeparture` implementation with the LeaveNow screen — cancel the nags *and* take a GPS fix) · deadline warnings · latest-start · three daily check-ins · focus check-ins · time-verification.

**Fixed this branch:** every alert gate used to ask `if (task.fixedTime)`, which is one of four reasons a task needs alerts. `alertPlan.taskNeedsAlerts` now also covers a route with no appointment hour, a deadline with no clock time, and an explicit alarm. A trip with a real plan and no fixed time used to get **no wake, no leave and no nag at all**.

**Server side:** wake/leave/1-hour-ahead reminders are persisted (`reminders.py`) and delivered over WhatsApp + Expo push — *except* departure reminders for a phone with an Expo token registered in the last 14 days, where the server now stands down and lets the app's own alert win. Fails open: a lookup error means deliver.

**Expo push has never actually delivered.** Firebase project `lumi-db02c` is wired but the FCM private key has not been uploaded; it logs an error roughly every 30 s. Local alarms are unaffected.

## 12. Authentication

| Route class | Auth |
|---|---|
| `/app/*` (5 routes), `/tasks/*`, `/agents/*`, `/link/verify`, `/push/register`, `/personality/complete` | Supabase access token, verified by Supabase (`app_auth`) |
| `/agent/chat` | Same, via `app_auth.identify` |
| `/admin/*`, `/usage`, `/diag/embed`, `/debug/graph` | `ADMIN_TOKEN` shared secret; refuse when unset |
| `/health` | open (correct) |
| `/personality/resolve` | one-time token in the query string |
| `/diag/sync` | `ADMIN_TOKEN`. **Correction:** the first version of this audit called it open. It is not — the guard sits below a 26-line docstring, past where the route scan read |
| `POST /webhook/whatsapp` | Optional. ✅ `_signature_ok` verifies `X-Hub-Signature-256` **when `WHATSAPP_APP_SECRET` is set**, and accepts everything when it is not — there is no Meta Business Account behind this product, so mandatory verification would reject every real message. Setting the secret turns enforcement on with no code change |

App identity is Supabase Auth via Google (`expo-auth-session` → Supabase session), separate from the Google *API* token used for Maps/Calendar/Gmail. Google tokens live in `expo-secure-store`.

## 13. Analytics

**None.** No Sentry, no PostHog, no Amplitude, no Firebase Analytics — verified by grep across `package.json` and `src/`. There is no way to answer "does anyone finish onboarding", "how often is a leave alert acted on", or "which screen do people bounce from".

## 14. Observability

What exists: `GET /health`, `GET /diag/sync` (the four-way sync diagnostic), `GET /diag/embed`, `GET /usage` (token spend today/this month with estimated USD), `lumi_llm_usage` and `lumi_judge_log` tables, `bug_reports.py` (users file bugs from WhatsApp), Python `logging` to Fly's log stream.

What is missing: crash reporting on the phone (`CrashCatcher.tsx` catches renders, reports nowhere), an uptime monitor, alerting. **If the reminder poller dies, nothing tells anyone.** Judge micro-calls, profile extraction and the five `/app/*` endpoints are not in the token ledger, so `/usage` understates spend.

## 15. External APIs

| Service | Used for | Key location | Rate-limit handling |
|---|---|---|---|
| Nebius AI Studio | Qwen3-235B chat + embeddings | Fly secret | 4 transient retries, exponential-ish backoff |
| Groq | Whisper STT | Fly secret | none |
| Google Directions / Geocode / Places / Static Maps | routing | **client key in the APK** + Fly secret | none |
| Google Calendar + Gmail | sync | user OAuth token, SecureStore | none |
| Google Programmable Search | `web_search` tool | Fly secret | 100 q/day free tier, unhandled |
| Meta WhatsApp Cloud API | messaging | Fly secret | best-effort, never raises |
| Expo Push | server→app alerts | none needed | best-effort |
| Supabase | database + auth | anon key in app, service role on server | none |

## 16. Cost drivers

Ranked by expected spend, largest first.

1. ~~**The broken prompt cache (§4).**~~ ✅ **Fixed.** `memory_block` and `guidelines` are now parameters of `_system_prompt` and land after the static prefix, so the 18 KB of rules sit at character zero on every turn. `test_prompt_cache.py` now tests the prompt that is actually sent, and one of its cases fails if any caller concatenates onto the finished string again.
2. **The judge — one extra LLM call per reply**, roughly doubling the call count on the WhatsApp channel to produce a 15-word note. It is not even metered. *(Still open — the largest remaining cost item.)*
2b. ✅ **The check-in no longer calls a model at all** (§20 item 1), removing one cheap-model round trip from the most latency-sensitive screen in the app.
3. **Google Directions.** Routes are recomputed on every screen refresh, by two stacks, with no cache. `TravelEstimator` caches; `RoutePlanner` and `ensureTravelChain` largely do not.
4. **Embeddings** on every inbound message for recall, plus the dedup sweep.
5. Historical, now stopped: a stray Nebius AI endpoint at ~$91/mo, deleted 2026-08-26.

Fly's free tier now costs nothing but buys the reliability problem in §18.

## 17. Latency drivers

- The agent turn: one system prompt of ~20 KB, up to 15 ReAct steps, 4 retries at 0.8–3.2 s of sleep. The observed tail is tens of seconds.
- **Cold starts.** With `auto_stop_machines` on, the first request after idle pays the machine boot plus FastAPI import. Meta retries the webhook up to 4× if it thinks we are slow, which is what the in-memory dedup set exists to absorb.
- Client timeouts: 12 s for schedule build, **30 s** for every extraction call. A user who says a sentence and waits 30 s for nothing is the worst case, and it is reachable.
- `plan_departure` serialises geocode → geocode → directions, each a network round trip.
- The 20 s reminder poll means a leave alert can be up to 20 s late even when everything works.

## 18. Reliability problems

1. ~~**The free-tier sleep is not consistently configured.**~~ ✅ **Fixed by deleting the duplicate.** There is now exactly one fly config, at the repo root, and CI deploys `-c fly.toml`. The setting is `auto_stop_machines = 'stop'` / `min_machines_running = 0`, chosen deliberately: departure alerts are owned by the phone, so nothing that has to ring on time depends on the machine. **Standalone WhatsApp reminders ("remind me at 15:00") will fire late until something pings `/health` on a schedule** — that keep-alive is the remaining work.
2. **WhatsApp dedup is in-memory** (200 ids). Every restart forgets, and a Meta retry across a restart is a duplicate reply.
3. **The webhook accepts unsigned deliveries** — anyone who finds the URL can POST a message as any number. Signature verification is now written and tested, but off until `WHATSAPP_APP_SECRET` exists (no Meta Business Account). Until then the URL is the only secret.
4. **No CI gate.** Every push to `master` auto-deploys; 442 Python and 42 TS suites exist and none of them run in the pipeline.
5. **Push has never delivered** (FCM key not uploaded), so the server's fallback channel for a phone with no WhatsApp is not real.
6. **Unexplained task loss** — 154 → 113 → 92 across syncs. `syncAllTasks` now only deletes rows that positively identify as app-created, which stops that shape of loss; the root cause is still unknown and nothing was recovered.
7. **Single machine, single region, single volume**, no backups.
8. ~~Two read paths for tasks that can disagree (§5).~~ ✅ **Fixed** — `GET /tasks/{phone}` now reads through `task_store.fetch_tasks_with_source`, Supabase first, and the response says which store answered.
9. No rate-limit handling anywhere; a Google 429 surfaces as "no route".

## 19. UX problems

1. **Three ways to add a task** (`AddTaskScreen`, `CheckInScreen`, `MyTasks`, plus `useTasks` invoked from `TodaySchedule`) and **two live home screens** (`HomeScreen` and `TodaySchedule`). The same sentence takes different paths and can produce different results.
2. **The navigation contradicts the spec.** `CLAUDE.md` specifies swipe + dot indicator, no bottom bar. There is a bottom bar.
3. **The day list cap** hid the afternoon: `slice(0, 6)` in clock order meant a 16:00 call added on a busy day appeared nowhere. Fixed by `dayWindow` (8 ahead, 2 behind) — **not yet committed**.
4. **Lumi is silent when it matters.** TTS cannot speak from a locked screen, so the leave alert — the moment the whole product exists for — is text.
5. **Fake confirmations.** "✓ עודכן" has meant "the model said so", not "the store changed". `task_rescue` and `reply_consistency` now catch the known shapes, but the class of bug is structural.
6. **30-second waits** on extraction with no partial feedback.
7. **`Task.date` is required**, so there is no "sometime" backlog — an undated intention becomes overdue tomorrow.
8. **Onboarding asks for a home address** and the profile silently had zero rows for a long time; an empty `homeAddress` is why routes vanish, with no message explaining it.

## 20. Where deterministic logic is still delegated to an LLM

Most of this was fixed in the last cycle — date arithmetic, categorisation, schedule building and clash resolution are all plain Python now, and `build_day_schedule` makes **no model call at all** (~1 ms). What remains:

| # | Where | What the model is deciding | Why it should not be | Fix |
|---|---|---|---|---|
| 1 | ~~`checkin_parse.py`~~ | ~~Which of 9 intents a sentence is~~ | ✅ **Fixed.** `server/task_intent.py` is the Python port of `TaskIntent.ts` — EN+HE verb tables, Hebrew-safe anchors, Hebrew prefix stemming so "הרופא" finds "תור לרופא". `checkin_parse` makes no model call at all now; tasks are built by `task_extract.finalize` and labelled by `categorize`, the same code the capture path uses | Done. Lost with the model: free-form `how`/`why`/contact and `subgroup`, which the screen already treats as optional |
| 2 | `judge_service.py` | Whether a reply was good, and what the prompt should say next | Scoring is arguably model work; **rewriting the production system prompt every 10 replies with no human review is not**. It is an unversioned, unattributed mutation of the most important file in the product | Version the guidelines, require a human diff to promote, or reduce the judge to logging |
| 3 | `lumi_agent` `build_day_schedule` tool | Nothing — but the model is trusted to *echo* the order it returns (still open) | The prompt now says "read its order back, do not re-sort it", which is a rule enforced by hope | Return the day as a rendered block the reply must include verbatim, or assemble the final text in code |
| 4 | `agent_turn.override_task_date` | (already corrected) | The model kept inventing dates — it wrote 24.7 for the day after 26.7, storing an appointment in the past. Python now overrides whenever the message carries exactly one relative expression | Keep. This is the right pattern: **let the model read, let code decide** |
| 5 | `task_extract`, `profile_extract`, `email_events` | Segmentation and extraction only | Correct as-is — each is one cheap call, and every label, date and duration afterwards comes from `categorize` and `tz` | No change |

**The pattern worth stating once:** every remaining correctness guard in this codebase — `task_rescue`, `reply_consistency`, `override_task_date`, the anti-fabrication checks in `plan_departure` — exists because a model was asked to *decide* something rather than to *read* something. The direction of travel is right; items 1–3 are what is left of the old direction.

---

# Flow maps

Every major user action, end to end.

### 1. "Interview tomorrow at 11:30 in Ramat Gan" — spoken into the app

```
USER ACTION       Tap 🎤 on Check-in / Add Task, speak
APP LOGIC         expo-speech-recognition (he-IL) → SpeechService.preprocessTranscript
                  (filler removal, "igal alon" → "יגאל אלון")
                  TaskIntent.classify → create  [rules only, offline, <1 ms]
AI                POST /app/tasks/extract   → ONE cheap-model call: which words are tasks
                  Everything else in code: tz.resolve_date("מחר"), categorize (keyword table)
TOOL              none — this endpoint runs no ReAct loop
DATABASE          TaskStorage (AsyncStorage, canonical) → supabaseRepo mirror → tasks
EXTERNAL          — (routing happens later, when a location is confirmed)
RESPONSE          Task card rendered; NotificationService.armTaskAlerts schedules
                  lead-time alerts; AlarmPlanner decides whether a wake alarm is needed
FALLBACK          Server unreachable → TaskParser.fallbackParse, offline, task still saved
```

### 2. The same sentence, sent on WhatsApp

```
USER ACTION       WhatsApp message (text, or a voice note)
APP LOGIC         POST /webhook/whatsapp → in-memory dedup → [voice: Groq Whisper]
AI                agent_turn.run_turn → lumi_agent → react_loop
                  prompt = judge guidelines + memory block + 18 KB static rules + user tail
TOOL              calculate_date → infer_task_details → (find_task to avoid a duplicate)
                  → plan_departure if a place is known
DATABASE          user_memory JSON (mints the id) → Supabase tasks mirror; provenance stamped
EXTERNAL          Google Geocode ×2 + Directions (arrival_time-anchored)
                  reminders.schedule_departures → wake / leave / 1-hour-ahead rows
RESPONSE          One short WhatsApp line, checked by reply_consistency against what was
                  actually stored; task_rescue saves it anyway if the model only claimed to
POST-HOC          judge_service.evaluate (extra LLM call, fire-and-forget)
```

### 3. Opening the app on the Today tab

```
USER ACTION       Launch / focus Today
APP LOGIC         useFocusEffect → getTasksForDate → sortTasksByPriorityAndTime
                  → dayWindow (8 ahead / 2 behind) → DayTimeline with the current moment
                  resolveClashes + likelySameTask run locally
AI                none
TOOL              none
DATABASE          AsyncStorage read; Supabase pull in the background; WhatsAppTaskSync
                  pulls GET /tasks/{phone} and merges by stable id
EXTERNAL          GoogleSync.syncCalendarToday, Gmail suggestion scan, ensureTravelChain
RESPONSE          The day, immediately, from cache — network results fold in as they land
```

### 4. "Optimize my day"

```
USER ACTION       Tap ✨ Optimize
APP LOGIC         buildDaySchedule locally, or POST /app/schedule/build
AI                NONE — deterministic, ~1 ms, zero cost
                  (this is the call that used to pay a 235B model to redo a sort)
DATABASE          Saved schedule written back
RESPONSE          Re-laid timeline + a one-line summary
GAP               It only sorts. It assigns no times and ignores travel — the real
                  optimize_day described in CLAUDE.md does not exist
```

### 5. The leave-home alert — the product's reason to exist

```
TRIGGER           Local notification at transitPlan.leaveHomeAt (wake-alarm channel)
APP LOGIC         Tap → LeaveNowScreen; or "יצאתי ✓" straight from the shade
AI                none
TOOL              LiveRoute.replanNextTripFromPosition → positionDrift.assessDrift
                  decides whether the plan is stale enough to matter
DATABASE          lastDepartureDetectedAt stamped; leadLearning records the real gap
                  between the alert and the departure
EXTERNAL          expo-location fix → Google Directions from where she ACTUALLY is
RESPONSE          Live route, the real line and stop, a map, and the nags cancelled
SERVER            Stands down entirely when this phone has a live Expo token
                  (reminders._app_owns_departures) — this is the three-pings fix
```

### 6. Chat with Lumi in the app

```
USER ACTION       Type in CoachChat
APP LOGIC         LumiCoachEngine rule router first (EN+HE, <100 ms, offline)
AI                LumiBrain → POST /agent/chat → the SAME agent WhatsApp uses,
                  same history, same memory, same personality
TOOL              any of the 21
DATABASE          lumi_conversations, lumi_memories, tasks
RESPONSE          Short reply + any tasks/departures the turn produced
FALLBACK          Offline → the local router answers; nothing is lost
```

### 7. Onboarding

```
USER ACTION       Answer a spoken question ("I live at Yigal Alon 94, I cycle")
APP LOGIC         OnboardingScreen → LumiOnboardingAgent
AI                POST /app/profile/extract → one cheap call → merged profile
                  + missingFields + the next question
DATABASE          UserProfileStorage (local) + user_profiles (Supabase)
                  AND lumi_profiles — so the WhatsApp brain knows the address too
EXTERNAL          Google Geocode on the home address
RESPONSE          Next question, or done
FALLBACK          502 → localFallbackExtraction; losing a spoken answer is worse than
                  a rough parse
```

### 8. A user-built agent fires

```
TRIGGER           agent_runner poll (60 s) finds a due agent
APP LOGIC         AgentsScreen is management UI only — the agent runs server-side
AI                Deterministic PREFETCH (profile, memory, tasks, precomputed routes and
                  wake math) → ONE completion that only PHRASES those facts
TOOL              ZERO by design — it cannot invent a route and cannot message anyone
                  but its owner
DATABASE          lumi_agents, lumi_memories
EXTERNAL          WhatsApp send
RESPONSE          One message, in the agent's persona, containing only real numbers
```

---

# What to do next, in order

**Done in the 2026-09-08 fix pass** (488 Python tests, 42 TS suites, all green):

1. ✅ Prompt caching — the static prefix is back at character zero, guarded by a test of the real prompt.
2. ✅ One fly config. `server/fly.toml` deleted; CI deploys the root one; free-tier sleep is on.
3. ✅ Webhook signature verification written as **opt-in** (`WHATSAPP_APP_SECRET`), so it can be switched on the day a Meta app exists without touching code. `/diag/sync` was already gated — that finding was wrong.
4. ✅ One task read path, and a deterministic check-in (`task_intent.py`).
5. ✅ `CLAUDE.md` tool inventory corrected: the 21 real tools, and the 6 that never existed named as such.

**Still open, in order:**

1. **Retire the judge, or version it.** One extra LLM call per reply, unmetered, rewriting the production system prompt every 10 replies with no human review.
2. **A keep-alive for standalone reminders.** The machine sleeps now; a free scheduled `GET /health` is what stops "remind me at 15:00" firing late.
3. **Add a CI gate.** 530 tests exist and none of them run before a deploy.
4. **Cache routes and unify the two routing stacks**, or at least give them one shared fixture suite so a fix cannot land on one side only.
5. **Upload the FCM key** — push has never delivered.
6. Then Phase 3: known places with coordinates, real routine learning, location clustering, an undated backlog, and an `optimize_day` that assigns times.
