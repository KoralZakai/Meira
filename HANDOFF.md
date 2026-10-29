# Lumi — handoff

`master` @ latest, pushed, Fly + Vercel deployed. Read `CLAUDE.md` first.
Memory: `~/.claude/projects/-Users-user-dev-Lumi-My-AI-Assistant/memory/`.

## The sync WORKS. Read `keyRole` before believing any number.

```bash
curl -s "https://lumi-whatsapp.fly.dev/diag/sync?phone=972542902729" | python3 -m json.tool
```
Expect `keyRole: service_role`, `phone.linked: true`, `taskRowCount` ~95.

It was **two** silent bugs, not one, and both produced the identical symptom:

1. **The app could not sign in.** Local builds shipped with no `EXPO_PUBLIC_*`
   — they are inlined at build time and there is no committed `.env`. Fixed:
   `npm run build:env` now refuses to build without them. Note `eas env:pull`
   alone is NOT enough: it writes `.env.local`, and `.easignore` ships only
   `.env.production`.
2. **The server could not SEE.** `SUPABASE_SERVICE_ROLE_KEY` on Fly held the
   **anon** key, which is subject to RLS — so every query returned `200 OK`
   with an empty array, forever.

**`200 OK` with zero rows is not evidence of emptiness.** Three sessions read a
blind probe as fact. `/diag/sync` now reports `projectRef` and `keyRole`.

## Working and verified on the phone

Zoom links no longer get a bus route or a wake alarm · clashes are detected
(including back-to-back in two places) and offer real choices · travel origin
chains place-to-place instead of always starting from home · alerts name where
you're going and by when · Done/Reschedule/Delete on tasks whose time has
passed · Upcoming sorted · search by text and by topic · home address in
Profile · the join link and attendees on task detail.

`npm run test:all` → 17 suites, all green. `npx tsc --noEmit` → **36 errors is
the baseline**, do not chase it. Python: `cd server && python3 -m pytest tests/ -q`
→ 158.

## Open — in priority order

1. **The WhatsApp agent saves badly.** See `lumi-whatsapp-agent-not-saving` in
   memory. It replies and creates *some* tasks, but "gym and party this
   evening" produced only the party, and **every task arrives with no time**
   (`--:--` server-side), which also keeps them off the Today timeline. Start
   at `server/lumi_agent.py`; needs `ADMIN_TOKEN` or `fly ssh` to read a real
   conversation — ask Koral.
2. **STT through the server.** Settled by evidence: WhatsApp voice notes
   transcribe well in Hebrew and English via Groq `whisper-large-v3`
   (`server/stt.py`). Add `POST /stt` + an audio recorder in the app. Do NOT
   ship an on-device model — every Hebrew Whisper is ≥1.5GB against a 90MB APK.
3. **Lumi should speak** — short, warm. `expo-speech` is already used for the
   morning briefing.
4. **Dynamic origin from real GPS.** The chain now re-plans when the *schedule*
   implies a different start. Koral wants it to follow where she actually is.
   `utils/positionDrift.ts` is written and tested and has **zero consumers**.
5. **Phase 3** (needs its own session): known-places store, real learning,
   location clustering, an undated backlog, and a real `optimize_day` — the
   current one at `LLMService.ts:644` only SORTS.

Also: Firebase/FCM unconfigured so server push has never worked (local alarms
unaffected; Koral deferred it deliberately — adding Firebase to the GCP project
is irreversible). Two bug reports filed from WhatsApp are unread.

**Unresolved:** cloud task count fell 154 → 113 → 92 across syncs. Not
explained. `syncAllTasks` now deletes only rows that positively identify as
app-created, which stops that shape of loss but recovers nothing.

## Working in this repo

The bug-agent daemon runs on a timer and used to `git checkout master` in the
live directory, which two handoffs blamed on EAS builds. It now works in a git
worktree under `~/dev/.lumi-bug-worktrees/` — verified in production, three
bugs processed while the main checkout stayed on master.

**Another session may be editing this tree concurrently.** Check `git status`
before committing and stage only your own files.

## How she works

Hebrew, short, concrete. ADHD — bullets, no walls of text. Wants root causes and
evidence, not reassurance. Proving a premise wrong with a command is welcome;
several were wrong across these sessions and saying so plainly was the useful
move.

---

## 2026-10-19 — release/play-v1: server latency (B1–B4)

Branch `release/play-v1` (worktree `../lumi-play-v1`), cut from `origin/master` + the 3 commits that were only on feat/hackathon. **Committed, not deployed** — nothing is pushed.

**Done**
- `7a7452a` Nemotron's hidden thinking is OFF on every model call (`ai_gate.without_thinking`, `LLM_THINKING=on` reverts). Probed on Fly: nano/super spent 44-47 tokens on a 6-token reply; the usage ledger showed calls ending exactly at max_tokens (email_events 600 every call). `/no_think` does not work; `chat_template_kwargs.enable_thinking=false` does. Client timeout 30 s, one retry (was 600 s × 3).
- `66bb615` Mic turn: when `understand` already saved everything a "do" message asked, the ReAct agent is not run just to say "saved" (5-20 s). Reminders / alarms / delete / send / routines / questions still go to the agent. One `turn timing:` log line per turn.
- `5535f14` Profile extraction runs in the background unless the message may state a profile fact.

**Verified:** pytest 1316 passed; each new test fails on the old code. **Not verified on the phone / in prod** — needs a push to master (deploy) first.

**Pending / decided not now**
- B5 `asyncio.gather` of lookups, B6 second `understand` on typed chat — skipped: small gain, B6 is the "agent talked and saved nothing" safety net.
- STT `whisper-large-v3-turbo`: needs a test on real Hebrew recordings before switching.
- TTS one round trip instead of two: ~0.3 s, later.

**Next command (after Koral pushes to master):**
```bash
fly logs -a lumi-whatsapp --no-tail | grep "turn timing"
```

## 2026-10-19 — vehicle pickup planner (bike/car somewhere else)

**Done:** `server/vehicle_chain.py` + `server/tests/test_vehicle_chain.py` (10 tests).
- `plan()`: a named event — fetch_first / fetch_after / leave_it, timed back from the start, ranked (on time › minutes › bike ends home). A failed leg is reported, not dropped.
- `plan_pickup()`: "pick up my bike from Florentin, plan it" — branches via each of the next 3 located events + a trip of its own now, priced by minutes ADDED to her day.
- `say()` / `say_pickup()` EN+HE, bus line + boarding time.

**Not wired yet (next):**
1. `understand._SYSTEM` + `lookup_of`: lookup `{"what":"vehicle","vehicle":"bike|car","vehicle_at":"…","event_task_id":"id from HER DAY or null"}`.
2. `agent_turn.answer_lookup`: on what=vehicle — resolve here/vehicle/home with `place_ranker.resolve_origin/resolve_destination`; today's events from `supabase_tasks.tasks_for_user(uid, today, today, include_location=True)`; `plan()` when event_task_id matches, else `plan_pickup()`; route = `geo.directions_detailed`.
3. Live check through Meira MCP: "האופניים שלי ברחוב פלורנטין, ואני צריכה להיות במפגש של באות" (baseline 19.10: she asked "where is the meetup?").

**Next command:**
```bash
cd server && /Users/user/dev/Lumi-My-AI-Assistant/server/.venv/bin/python -m pytest tests/test_vehicle_chain.py -q
```

**Wired (same day):** `understand` now returns lookup `what=vehicle` (vehicle, vehicle_at, event_task_id matched from HER DAY); `agent_turn.answer_vehicle` resolves here / the vehicle / home, reads today's tasks WITH location, and answers with `vehicle_chain.plan` (event named) or `plan_pickup` (no event) — no agent loop. Typed chat with אופניים / לאסוף / תכנני / bike / pick up is understood first. Tests: `tests/test_vehicle_answer.py` (fail on the old code). **Live check still owed** after the push: ask Meira the Baot question.

---

## 2026-10-19 — perf/app-speed: the app side of "super slow" (B8–B10)

Branch `perf/app-speed`, cut from `release/play-v1`. **Committed, not pushed, not deployed.** Timings: `adb logcat -s ReactNativeJS:V | grep '\[Perf\]'` (console.warn, so release builds keep them).

- `76c142d` `[Perf]` marks: Today load → rows, first paint since bundle load, each full task download (ms, rows), voice stop → transcript → result.
- `b682b06` **getAllTasks: one shared download, reused 3 s.** ~57 callers each downloaded every row; one Today focus = 4 downloads. Concurrent callers join one download; any write (local list, local-ahead flag, each cloud task write when it settles) ends the reuse; a read begun before a write never fills the cache after it; each caller gets its own copy. `getAllTasksChecked()` returns `cloudError` (rule 1), `getLocalTasks()` = phone copy, no network. Test: `tests/run-tasks-read-cache.ts` (it caught a real race: the in-flight slot was cleared a few microtasks late, so a caller could join a finished, expired download).
- **Today draws the phone copy first** (`TodaySchedule.load`). It used to await a full task download AND cloud settings behind a spinner. Now: `getLocalTasks` + `getLocalSettings` → draw, spinner off → `getAllTasksChecked` + `getSettings` redraw. Empty phone copy (fresh install) keeps the spinner. A failed cloud read shows a pill "☁️ Couldn't refresh — showing what's on this phone. Tap to retry" (HE too); same after the post-sync refresh. `carried` now comes from the same read. Test: `tests/run-today-local-first.ts` (source rule).
- **Sign-in backfill once per sign-in, not per launch** (`App.tsx` auth handler). It ran on every auth event with a session; measured: every cold start re-uploaded 245 tasks. Gating on `SIGNED_IN` alone is NOT enough — auth-js emits SIGNED_IN when it restores a stored session at launch (`_recoverAndRefresh`). Gate = SIGNED_IN AND `lumi.cloudBackfilledFor.v1 !== userId`; mark set only when the backfill reached the cloud, cleared on SIGNED_OUT. `onAuthChange` now passes the event. Account change also ends the shared task read. Test: `tests/run-signin-backfill-gate.ts`. **Still open (not changed here):** the backfill body is `saveAllTasks(await getAllTasks())` — the wholesale save of a cloud-merged read that the cloud-over-local rule forbids; it now runs once per sign-in instead of every launch, but it should push the phone's own rows instead.

**Baseline on her phone (before, 19.10, release APK with only the [Perf] marks, 2 cold starts):** Today rows 2.3–2.5 s after load; first paint 3.0–3.2 s after bundle load; **34–38 full downloads of all ~250 task rows in the first 25 s** (0.5–2.4 s each, 55–67 s of network summed); "post-sign-in: pushed 245 task(s)" on every launch.
- **Voice turn stops waiting for niceties** (`VoicePlanFlow`). The reverse-geocode label started only after the transcript and held the call to Meira up to 3 s; it now starts at mic-open (`VoiceContext.label`) and is sent only if already there — coordinates always go. The calendar wait before planning is 1 s, not 5 s (it has had her sentence + STT + Meira's turn to finish; "not finished" stays not-run, never a Google error). Test `tests/run-voice-no-wait.ts`: old code 3000 ms / 5002 ms, new 2 ms / 1001 ms.
- **The sleeping server is knocked on before she needs it** (`LumiServer.warmServer`): GET `/health`, fire-and-forget, ≤ once a minute (a failed knock does not count). Triggers: cold start + AppState `active` at the root (App.tsx), and the mic sheet opening (VoiceSheet). The brief said to call `serverAvailable()` — it only checks the local session and makes no request, so it could not wake anything. Test `tests/run-server-warm.ts`. The paid fix (`min_machines_running=1`) is still Koral's decision.

**After, same phone, APK from `3d77b69` installed 13:29 (3 cold starts):** Today rows from the phone copy **140–162 ms** (was 2.3–2.5 s); first paint **0.61–0.70 s** after bundle load (was 3.0–3.2 s); cloud redraw 1.6–1.9 s; **8 full task downloads in 25 s** (was 34–38; summed 9.6–11.3 s, was 55–67 s); no "post-sign-in: pushed" on launch; server warm-up on launch 200 in 0.34–0.55 s. **Voice timings not measured** — needs her to speak; marks are in place (`[Perf] voice: …`).
- Phone contention: Section A's session also installs on this phone (replaced my baseline APK at 13:11). The installed APK is perf/app-speed ONLY — build once from the merge of both branches.
- **Fixed after the measurement:** the two `saveAllTasks(getAllTasks())` in App.tsx. The launch alert re-arm now saves only `notificationIds`, row by row (`updateTaskFields`), as Today already did. The sign-in backfill calls `TaskStorage.pushLocalTasksToCloud()`: local rows the cloud lacks + local-ahead rows, upsert only — no local write, no cloud deletes, no stale copy over a server retitle. Test `tests/run-signin-push.ts`. Still open: `StoreMigration` does the same once per migration version; the remaining 8 downloads come from writes ending the cache (calendar sync, route updates).

**Installed now: APK from `76b338c`, 14:58 on 19.10.** Run 1 was the first launch after the install: first paint 2.07 s, 15 downloads. Run 2: rows from the phone copy 113 ms, first paint 0.50 s, cloud redraw 1.5 s, 10 downloads in 25 s, server warm-up 316 ms. Today renders normally (screenshot checked), with no refresh-failed pill.

---

## 2026-10-19 — release/play-v1-section-a: Play blockers & security (plan section A)

Branch `release/play-v1-section-a`, cut from `release/play-v1` (3b1c982). **Committed, not pushed, not deployed.**

**A1 — USE_EXACT_ALARM removed** (Play grants it only to alarm-clock / calendar apps)
- Done: dropped from `app.json` permissions and added to `blockedPermissions` so a library cannot re-add it; `tests/run-release-config.ts` pins both. `SCHEDULE_EXACT_ALARM` stays. The wake alarm is unaffected — it is set in the clock app via `ACTION_SET_ALARM`. Focus-session starts / notifications fall back to inexact when exact alarms are not granted (already coded in `FocusScheduler.arm`).
- Verified: `npm run test:relconfig` 37/37, `npm run test:all` 140/140. **Not verified on the phone.**
- Next: after the next build, `aapt dump permissions <apk> | grep EXACT` must show SCHEDULE_EXACT_ALARM only.

**A2 — rate limits on the model-calling app doors, /health trimmed**
- Done: `rate_limit.APP_MODEL_LIMIT` (20/min per account, per door) on `tasks/extract`, `profile/extract`, `email/events`, `meeting/brief`, `task/prep`, `questions/answer` and also `errands/along` (it calls the model too and had no ceiling). The 429 is `{ok:false, reason:"rate_limited"}` or `{error:"rate_limited"}` in each door's own shape, with Retry-After. `GET /personality/resolve`: 10/min per client IP (`Fly-Client-IP`). `GET /health` now returns `{"status":"ok"}` only; model tiers stay on admin-only `/diag/models`. Nothing read the removed fields (Fly check, ship skill, web pinger look only at the status).
- Verified: new tests in `server/tests/test_rate_limit_routes.py` (9 of 10 fail on the old code); full pytest 1326 passed; `test_no_open_doors.py` green.
- Pending (not mine, LumiServer.ts is another session's): `LumiServer.call` turns ANY non-2xx into `null`, so on the phone a 429 on brief/prep/extract reads as "server unreachable". Not cached, so it retries next time — acceptable, but the reason is lost (rule 3).
- Next (after the push): `curl -s https://lumi-whatsapp.fly.dev/health` must print `{"status":"ok"}`.

**A3 — focus-guard prominent disclosure + privacy page**
- Done: `FocusDisclosureCard` (EN+HE, 4 short lines: what Usage access sees and only during a session, what the overlay is for, stays on the phone, how to turn off; "Got it, open Settings ›" / "Not now"). `FocusSessionService.requestPermission` is now async and refuses with `disclosure_needed` until `acceptDisclosure()` (key `meira.focus.disclosure.v1`), so no caller can open Settings without it. Wired in `FocusSessionPanel` (takes the whole panel; covers FocusNow + the Menu sheet) and in `FocusLectureHost`'s fix button. `site/privacy.html` (HE + EN sections, one file): a table row and a box for learning sessions, "data from other apps" line qualified, date 19.10. **`npm run site:publish` NOT run.**
- Verified: `run-focus-session` 181/181 (strings + wiring), `run-focus-bypass` B13 (Settings does not open before "Got it", opens after, remembered), test:all 140/140, langparity 37/37, tsc 18 (= base). **Not seen on the phone; no mockup was shown first** — the wording is set by Play's policy, the look reuses the panel's notice style.
- Next: on the phone, fresh install → Menu › Helpers › Learning sessions → Allow → the card must appear before Settings. Then `npm run site:publish` (hers).

**A4 — docs/PLAY_DECLARATIONS.md**
- Done: specialUse FGS form texts (feature, why no other type, impact if deferred), Usage-access justification, the in-app disclosure as shipped, a 30-second demo-video script (7 shots), Data safety = no new rows (nothing leaves the device; verified in code). Checked: expo-location's `location` service gets no FOREGROUND_SERVICE_LOCATION (background location off), so specialUse is the only FGS declaration. `PLAY_STORE_RELEASE.md`: the exact-alarm row no longer calls Meira an alarm clock; FGS row added.
- Pending (Koral, Play Console): record + upload the video (Unlisted), paste the 3 texts, `npm run site:publish`.

**A5 — read-only checks (19.10, nothing changed)**
- Fly `lumi-whatsapp`: `WHATSAPP_APP_SECRET` and `ADMIN_TOKEN` are both SET (names only, values not read).
- Supabase: RLS is ON for every table in public and storage. Every policy is scoped to the owner (`auth.uid()`, or `lumi_identities` → userId). `waitlist` is insert-only. `lumi_judge_log` and `lumi_llm_usage` have no policy, so they are service-role only, as intended. **No RLS gap.**
- Advisor warnings, all hers to decide, none blocking Play: (1) `g_is_member` / `g_shares_match` are SECURITY DEFINER and callable by anon via `/rest/v1/rpc` (g_* tables are not Meira's; they return booleans only); (2) `lumi_match_memories` has a mutable search_path; (3) the `vector` extension is in public; (4) Auth leaked-password protection is off (Meira signs in with Google only, so low impact).

**A6 — Gmail out of the store build** (Koral 19.10: "כן, להוציא")
- Done: `src/utils/gmailAccess.ts` with `GMAIL_ENABLED = false`, which is the one switch. Sign-in asks for Calendar only (`googleScopes()`). `searchGmailForTask`, `gmailHistoryWith`, `scanGmailForEvents` and `getGmailEventSuggestions` return before any token or network call, so an older token that still carries the scope reads no mail either. Each surface now says it is off: Menu › Update calendars ("✉️ Reading Gmail is off in this version…", not "0 in your email"), Plan tomorrow (that line where the email section was), and Calendars (a "Mail: off" label instead of a switch that would do nothing; the Add-account dialog no longer promises Gmail). The meeting brief carries no mail history and never claimed any. Today's email-suggestion card just does not appear (`TodaySchedule.tsx` belongs to another session and was not touched). Privacy page (HE+EN): the Emails rows are removed and "we do not read your email" is added. `PLAY_STORE_RELEASE.md` Data safety: the **Messages ← Emails row is removed**.
- Verified: new `tests/run-gmail-off.ts` 16/16, `run-calendar-update-line` 11/11, test:all 141/141, langparity 37/37, tsc 18, pytest 1326. **Not seen on the phone.**
- Koral: Google Cloud › OAuth consent screen › Data access: remove `gmail.readonly` there too. Then `npm run site:publish`.

## 2026-10-20 ~02:00 — chat understanding: night dates, retries, alarms (deployed)

All on master + Fly (each pushed and deployed; pytest 1441, TS 154/154, tsc 18 baseline).
Verified on the server with her own sentences (understand probe): alarm-only → alarm on the morning task;
"…ושימי לי שעון מעורר מתאים" → one call 09:30 + alarm; "set an alarm" → not the call's minute; "תעירי אותי ב-8" → alarm only.

**Not verified yet:**
- APK with immediate Clock-alarm arming (LumiBrain → armDueAlarms) — build was running (scratchpad apk-build5.log). Install: `adb -s RZCYA0AVWEZ install -r lumi-local.apk`, then ask Meira for an alarm and check `adb shell dumpsys alarm | grep -A3 clockpackage` + logcat `[LumiBrain] alarm`.
- Live eval (38 sentences): must run with an isolated DATA_DIR — evals/env.py now refuses /data. Run on Fly:
  `fly ssh console -a lumi-whatsapp -C "sh -c 'cd /app && python -m evals --live --only accuracy --budget 1.0 --out /tmp/evout'"`
  (if it still sees encrypted stores, set DATA_DIR=/tmp/ev explicitly). Compare saved vs expected; fix every gap.

**Next (her asks, not started):**
1. Whisper priming with names from her day/contacts (STT mis-heard "Dotan" five ways).
2. For a call with a person: offer to send an invite → contact lookup → if on Meira, share; else ask email → Google Calendar invite.
3. Chat modes chips (mockup shown, her pick pending: A/B/C).
4. Her data junk from 20.10 night: "עוד שעון מעורר" task, "Insert", duplicate 13:00 interviews — delete only with her OK.

## 2026-10-20 — live eval round 5 (probes)
- Leaked reasoning: Nemotron with thinking off sometimes writes "…reasoning </think> answer". `react_loop.visible_text` keeps only what follows the last `</think>`.
- "תקבעי לי פגישה" / "remind me" saved a placeholder task → `task_extract.too_vague` gate in `infer_task_details` (ok:false, ask what+when).
- "I'll look it up…" with no tool call ended the turn → `_promises_without_acting` triggers the continued retry.
- Eval guard read "משהו נוסף" (additional) as a save claim → `evals/guards._adjective`.
- Tests: tests/test_visible_text.py, tests/test_too_vague.py. Full JSON of a Fly eval: `cat /tmp/evout/report.json` right after the run (the machine sleeps and /tmp goes).

## 2026-10-20 morning — the alarm sets itself; Meira says why
- Koral: "added 'שיחה עם דותן ב9 וחצי', the ⏰ showed but I had to set it by hand". The chip is drawn from plannedAlarmTime; alarmState was only set by the calendar sync and Clock armed only at app start.
- Fix: `TaskStorage.onTasksWritten` (every task write) → App root (debounced) → `AlarmPlanner.syncWakeAlarms`: the day's first-task owner (today/tomorrow) is set in Clock, and a notification says when and why (`alarmPlan.wakeAlarmWhy`). Also runs on app open/foreground (`armTomorrowAlarms`).
- LOOP found on the phone and fixed: alarmState has no cloud column, so 'armed' was lost on read → re-armed + notified every ~4 s. A local record (`meira.wakeAlarmsSet`, date|HH:MM) is what decides now; syncWakeAlarms writes no task state itself.
- Reasoning kept: `react_loop.split_reasoning` keeps the model's `</think>` reasoning off the reply but logs it; every turn returns `why` (understanding kind + tools ok/failed + reasoning) and logs `turn why:`.
- Tests: tests/run-alarm-without-travel.ts (56), server tests/test_visible_text.py.

## 2026-10-20 ~09:00 — live eval round 6 fixes (deployed)
- "ללכת לבנק מחר" was read as a question → agent saved it TWICE: `persist_agent_tasks` only deduped against the day before the turn; now each saved task joins `existing`. Prompt: a bare verb + day is a save.
- "מה שעות הפתיחה של הדואר" was answered with a bus to the post office → `understand._ABOUT_PLACE_RE` drops the lookup; the agent web-searches.
- "go to the bank tomorrow" saved as "לך לבנק" → `understand._title_in_her_language`: English message + Hebrew title → her own words minus day/hour.
- "Answer:" label leaked → `react_loop.visible_text` strips it.
- Probe on Fly (isolated DATA_DIR): scratchpad `turn_probe.py` — `fly ssh sftp` put to /tmp, re-upload after every deploy (/tmp is wiped).
- Tests: test_same_turn_twins.py, test_place_info_not_a_trip.py, test_visible_text.py.

## 2026-10-20 afternoon — the morning ⏰ (option C) (on master, APK on her phone)
- Pill in Today's header + small ⏰ on the task it wakes her for. Never disappears: after its hour it moves to the next morning (`utils/morningAlarm.nextMorningAlarm`, a week out).
- Tap = on/off for that morning; long press = sheet. With a trip the options are "N min before leaving" with the leave time + bus shown, and her pick is stored as MINUTES before leaving (`MorningChoice.beforeMin`), so a moved bus moves her alarm (Koral: "depends on the bus time"). No trip → counts back from the start; no task → bare hour.
- Choices live in `meira.morningAlarmChoices` (MorningAlarmService). `AlarmPlanner.syncWakeAlarms` sets Clock from them; her tap waits for a running background sync (it used to be dropped).
- Samsung Clock answers ACTION_DISMISS_ALARM by opening its alarm list — no silent removal. So: only on her tap, after the new alarm is set, ONE trip to Clock, and the header says "In Clock: turn off Meira · HH:MM".
- Verified on the phone: off, on, 08:03 → 08:30 → "60 min before leaving" (08:18). Old test alarms (Meira · 08:03/08:30/08:33) may still be ON in her Clock — hers to turn off.
- Tests: tests/run-morning-alarm.ts (33).
