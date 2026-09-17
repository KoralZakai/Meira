# Lumi — Product Audit (short form)

**Commit:** `34644a4` · **Branches:** all merged, none pending.

---

## 1. Architecture

```
Expo app (Android) ──┐
                      ├─► Supabase (Postgres, shared tasks table)
Web dashboard ────────┘
                              ▲
WhatsApp (Meta) ─► FastAPI server (Fly.io) ─┘
                    ├─ JSON files on disk (/data) — memory, reminders
                    └─ service_role key (bypasses RLS)
```

3 clients, 1 shared DB, 2 backends (Fly server + Supabase). **Two separate brains** (TS on phone, Python on server) that don't share code — this is the root cause of most divergence bugs below.

---

## 2. Frontend

- Expo/React Native, Android only. ~28K lines TS, ~20K TSX.
- Bottom tab bar (Today / Tasks / Trips / Profile) — **contradicts CLAUDE.md**, which says no bottom bar.
- 4+ screens over 900 lines mixing data + UI + AI calls.
- **Decided: moving to Flutter (Android + iOS).** Don't over-invest in RN.

---

## 3. Backend

- FastAPI, `server/main.py` = 2,329 lines, no routers.
- Persistence: Supabase (tasks) + JSON files on Fly volume (memory, reminders, conversations). No locking, no transactions.
- `database_service.py` (dead Postgres code) — **deleted this cycle.**
- New: `POST /agent/chat` — the **only authenticated** route (Supabase token).

---

## 4. AI architecture

| | App | Server |
|---|---|---|
| Runtime | own loop, 12 tools | own loop (LangGraph removed), 19 tools |
| Prompt | ~2 KB | ~23 KB |
| Memory | none between calls | JSON files, no checkpoint |

Both use Nebius Qwen3-235B for everything — including tasks a lookup table could do (see §29).

---

## 5. Agents (9 app-side + 6 server-side = **15 separate AI components**)

**App:** ReAct agent, task splitter, legacy parser, intent classifier, capture/review agent, coach engine, onboarding agent, email extractor, new server-brain client (unused).

**Server:** WhatsApp Lumi, **HR/job scout** (⚠️ decided for removal), personal agents, LLM-judge (self-modifying prompt — risk), profile extractor, dedup scorer.

**4 different "turn sentence into task" agents on the app alone.** Not fixed.

---

## 6. Tools

- App: 12 tools. **9 of 12 are plain math/lookups** (date math, duration math, sort) wrapped in an LLM call for no reason.
- Server: 19 tools, real ones (routes, calendar, reminders).
- `search_contacts` = stub, does nothing.

---

## 7. LLM calls

**Worst offender:** adding 3 tasks by voice = up to **31 separate LLM calls**, 20-90 seconds. One extractor call, then a full agent loop *per task*, sequentially.

No prompt caching anywhere. No cheap-model routing (`LLM_MODEL_CHEAP` defined, never used).

---

## 8. Prompts

- Server prompt = 23 KB, un-versioned, **auto-rewritten by an LLM judge** every 10 replies. No human review.
- App prompts scattered across 5+ files, each reinventing category/date logic.

---

## 9. Memory

- Server: JSON per phone (tasks, behaviors, routines) — unbounded growth, no cleanup.
- App: none between chat turns (closes screen = forgets).
- **Bridge is fragile:** phone ↔ Supabase account link resolved by string-matching, falls back to scanning 500 rows.
- `positionDrift.ts` — was dead code, **now has 3 consumers, fixed.**

---

## 10. RAG

None. No document retrieval. "Memory" = dumping raw JSON into the prompt every time (context stuffing), which gets slower and pricier as history grows.

---

## 11. Database

- Supabase Postgres, 10 tables, migrations 0001–0006.
- `tasks.location` = sometimes object, sometimes string — a real bug source.
- **5 different ID schemes** for the same task concept.
- **Unexplained data loss: 154 → 113 → 92 tasks across syncs. Never explained. Still open.**
- No backups anywhere.

---

## 12. Location services

- Google + on-device geocoding, sometimes give different coordinates for the same address.
- Background location permission requested for one minor feature (proximity nudge) — Play Store risk.

---

## 13. Routing

- Best-built part of the codebase. Google Directions, timezone-aware, timetable-aware.
- No caching — same route recomputed on every screen refresh.

---

## 14. Calendar integrations

- Google Calendar (read+write), Gmail (read, once/day scan).
- No Outlook/Teams/Slack yet — **on the roadmap (MCP connectors).**
- No two-way sync: editing a Google event doesn't update Lumi.

---

## 15. STT

- WhatsApp voice: Groq Whisper, works well.
- App voice: Android system STT, works in real builds only (not Expo Go).
- **Dead code found:** Hebrew number-word replacement regex never matches anything (`\b` doesn't work on Hebrew letters).

---

## 16. TTS

- expo-speech, wired, works for morning briefing.
- Not used in chat replies yet (planned).

---

## 17. Notifications

- On-device alarms: solid, this is what actually works.
- Server push (Firebase): **just wired this cycle, NOT confirmed delivering yet** — needs one manual key upload.
- Alert-scheduling logic duplicated across 6+ files.

---

## 18. Authentication — 🔴 biggest open risk

**10 server routes have ZERO authentication**, protected only by "does the caller know a phone number":
`/tasks/{phone}`, `/agents/{phone}`, `/link/verify/{phone}`, `/push/register`.

Anyone with a phone number can read/write/delete anyone's tasks and schedule agents that message them. **Only 1 new route (`/agent/chat`) is done correctly** (real Supabase auth) — the pattern exists, just isn't applied everywhere.

**Not fixed. Top priority.**

---

## 19. Analytics

None. Zero product telemetry (no Amplitude/Mixpanel/etc). Can't answer "does anyone finish onboarding" or "do routes get used."

---

## 20. Observability

- Good: `/diag/sync` (catches the real bug class that broke sync before), token-cost ledger.
- Bad: no crash reporting, no uptime monitor. **If the reminder poller silently dies, nobody finds out.**
- No CI. **362 Python + 28 TS test suites, all run by hand.** Every push to master auto-deploys untested by any pipeline.

---

## 21. External APIs

Nebius, Anthropic (CV only — being removed), Groq, Google (Maps/Calendar/Gmail/Search), SerpApi (HR only — being removed), WhatsApp Cloud API, Supabase, Expo Push.

No rate-limit handling anywhere. SerpApi free tier = 100/month, will silently run out.

---

## 22. Cost drivers

1. **1 agent loop per task, not per message** — biggest single cost driver.
2. No prompt caching — 23 KB prompt resent every turn.
3. Flagship model used for trivial classification.
4. LLM-judge fires on every single message.
5. 9/12 app tools are math wrapped in an LLM call.

---

## 23. Latency drivers

- Voice → 3 tasks: 20-90 seconds (see §22.1).
- Chat with deterministic router (Coach engine): <100ms — this is the right pattern, just not used everywhere.
- Today-screen load: 3 sequential network syncs (was 5 racing/buggy, **fixed this cycle**).

---

## 24. Reliability problems

| Status | Problem |
|---|---|
| 🔴 open | Task loss 154→92, unexplained |
| 🔴 open | No retry queue for failed cloud writes |
| 🔴 open | Server JSON store has no locking |
| 🟠 improved | Push: was broken, now wired but unconfirmed |
| 🟠 open | WhatsApp message dedup is in-memory (lost on restart) |
| ✅ fixed | Dead Postgres code — deleted |
| 🟠 open | Model occasionally outputs garbage (Thai/CJK loop) |
| 🟠 fixed | Today-screen race condition (3 syncs now sequential) |
| 🟡 unverified | WhatsApp tasks arriving with no time — not re-checked |
| 🟡 open | No CI, ever |
| 🟡 open | 29 TypeScript errors accepted as baseline (was 36) |

---

## 25. UX problems

1. **20-90s to add 3 tasks by voice** — contradicts the product's own "fast" promise.
2. **3 different "add task" flows**, different results for the same sentence.
3. **2 home screens** both live (HomeScreen + TodaySchedule).
4. Bottom tabs vs. spec's swipe nav — contradiction, unresolved.
5. Contact lookup by name = stub, does nothing.
6. Hebrew silently fails in several English-only regex paths.
7. Unconditional 3-hour minimum block for anything tagged "study" — wrong for short tasks.

---

## 26. Technical debt — **duplication (your question — answer below)**

**Duplication is NOT fixed. Still present, unchanged by last session's merge** (that merge fixed unrelated things — LangGraph, push, positionDrift — not this):

| Concept | # of implementations |
|---|---|
| Category inference | 4 |
| Task extraction from text | 4 |
| Date resolution | 4 |
| Schedule building | 3 |
| Alert/reminder scheduling | 6+ |

Plus: dead HR-related code (slated for deletion anyway), stale docs (2 more added this cycle — 9 total root-level docs now), 94MB APK sitting in the working tree.

**De-duplication has not been started as a task.** It's flagged, not fixed.

---

## 27. Security & privacy risks

| Severity | Risk |
|---|---|
| 🔴 | Nebius/Maps API keys compiled into the APK — extractable from any install |
| 🔴 | 10 unauthenticated routes (§18) |
| 🔴 | WhatsApp webhook doesn't verify Meta's signature — forgeable |
| 🟠 | All personal data (memory, CVs, conversations) stored **unencrypted** on disk — **decided: needs encryption, not done yet** |
| 🟠 | `/diag/sync` leaks DB internals, no auth |
| 🟠 | GitHub Action once logged a secret value in run history |
| 🟡 | No GDPR/export/delete-my-data flow |
| 🟡 | Background location requested for a minor feature |

---

## 28. User action → system trace (core flows only)

**Add task by voice:**
`Mic tap → 2 parsers run on same text (redundant) → 1-31 LLM calls → AsyncStorage + Supabase + server → notifications scheduled`

**Chat with Lumi (in-app):**
`Type/speak → deterministic router checks first (no LLM most of the time) → only unmatched text hits LLM → reply`
✅ This is the correct pattern — used only in one screen.

**WhatsApp message:**
`Meta webhook (no signature check) → dedup (in-memory) → deterministic fast-paths tried first → LLM agent (19 tools) → Python OVERRIDES the model's dates/routes/links with real code anyway → reply`
Server already learned not to trust the LLM for dates/routes/links (see §29) — it just still calls it for those things first, then throws the answer away.

**Build day schedule:**
`Local code computes correct schedule in ~0ms → THEN pays for an LLM call to redo it → LLM's answer gets clamped by the local one anyway`
Pure waste — the deterministic answer was already right.

---

## 29. Where AI is used for things that shouldn't need AI

**Worst offenders — delete these tool calls, use plain code:**

1. **Whole-day scheduling** — a real algorithm already exists and works (`buildDaySchedule.ts`). The LLM version re-does the same sort, slower, then gets overridden anyway.
2. **Date math** ("tomorrow" → date) — computed 3 different ways already (2 in code, 1 by the model), the model version is the one that's wrong most often.
3. **Route planning** — server code admits it in a comment: the model "usually fabricates 'no route found'" so Python routes for real and **deletes the model's route text from the reply.**
4. **Category/priority tagging** — a keyword lookup table, wrapped in a full LLM round-trip.
5. **Simple math tools** — wake time, "+10 min" reminders, day-splitting — all pure arithmetic, all routed through the LLM anyway.

**Where AI is correctly used (keep):** free-text task extraction, open-ended chat replies, email→event extraction.

---

## What's fixed vs. what isn't (direct answer)

**Fixed this cycle:** LangGraph removed, dead Postgres code removed, push wired (not confirmed), positionDrift has consumers, Today-screen race condition fixed, 3 fewer TS errors.

**NOT fixed — still open, unchanged:**
- Duplication (§26) — **the thing you just asked about**
- Auth gap (§18) — biggest risk
- Task loss (§11)
- No CI (§20)
- No encryption on stored personal data (§27)

**Next, per your stated priorities (not yet started):**
1. Fix auth (10 open routes)
2. Remove HR agent
3. De-duplicate (§26 table)
4. Encrypt memory/`.md` files
5. Flutter port
6. MCP connectors (Telegram/Outlook/Teams/Slack/calendars)
