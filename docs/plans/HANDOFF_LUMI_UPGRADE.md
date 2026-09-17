# HANDOFF — Lumi Upgrade (continue from Cowork cloud session, 2026-07-20)

> **STATUS 2026-07-20 (later session): ALL PHASES DONE.** Git fixup 320a8ed;
> Phase 1 87a14bd; Phase 2 ea1176a; Phase 3 64bc804; Phase 4 7b3414e;
> Phase 5 d6f3447 — all on feature/lumi-upgrade, tsc + py_compile green
> (43 pre-existing tsc errors in untouched flyio-era files remain).
> Run `python server/migrate_wa_ids.py --apply` once on the server (dry-run
> first) to re-key old wa_ rows. Remaining later-phase item: native Android
> full-screen-intent + native TTS for locked-screen auto-speak (5b).
> Note: LumiOrb had grown extra LOGO call sites (wordmark/tab bar/chat) —
> those keep the clock-coin; TodaySchedule's avatar sites use LumiCharacter.

Read CLAUDE.md first (as always). This file tells you exactly where the
previous session stopped and what to do next. Work on branch
**feature/lumi-upgrade** (already created). Do NOT delete working code.

## APPROVED DECISIONS (do not re-ask)
- Avatar: port the illustrated Lumi character (from `lumi avsha/lumi_app.html`
  prototype — blink/talk-bob/wave/celebrate SVG) to replace LumiOrb, but KEEP
  the app's existing purple (#6C63FF) + gold theme. Add react-native-svg.
- Priority order: 1) memory sync 2) task edit/update understanding
  3) transport+maps 4) evening plan-tomorrow 5) alarm-speak + avatar.
- Maps: in-app react-native-maps route polyline + one-tap "Navigate" deep link
  to Google Maps. EAS builds only; keep a text-legs fallback for Expo Go.
- Alarm speak: phased — (a) now: Expo-only, speak briefing automatically on
  app-open/AppState-active after the wake alarm; (b) later: native Android
  full-screen-intent + native TTS for locked-screen auto-speak.

## GIT STATE — FIX FIRST
- Branch feature/lumi-upgrade, commit 335d865 exists but contains TRUNCATED
  copies of server/user_memory.py and src/services/supabaseRepo.ts (a cloud
  file-transfer bug). The WORKING TREE now has the correct full versions
  (user_memory.py = 149 lines, sha1 58936a4…; supabaseRepo.ts = 454 lines;
  supabase_tasks.py = 193 lines, correctly committed).
- Stale lock files may exist: .git/HEAD.lock(.stale1), .git/index.lock(.stale1)
  — delete them, then commit the working-tree versions of those 3 files as a
  fixup ("Phase 1 fix: restore full contents"). `apply_phase1.bat` in the repo
  root automates this; verify `python -m py_compile server/user_memory.py`
  passes after commit.
- Note: the branch was cut from `flyio-new-files`, which had many uncommitted
  working-tree changes; leave unrelated modified files alone.

## PHASE 1 — MEMORY SYNC (in progress)
Done (in working tree):
1. server/supabase_tasks.py upsert_task: reads existing row; preserves
   createdAt; a default-"pending" WhatsApp re-mention no longer downgrades a
   user-set status (completed stays completed).
2. server/user_memory.py add_task: same non-clobbering status rule.
3. src/services/supabaseRepo.ts syncAllTasks: delete-by-absence now SKIPS
   externally-sourced rows (source in whatsapp/gcal/gmail/calendar) — fixes
   "WhatsApp tasks vanish". Explicit deletes still via deleteTaskRow.

Remaining (do next, in order):
4. Stable IDs: stop deriving task ids from sha1(text|date) ("wa_" hashes in
   user_memory._task_id + supabase_tasks.task_id). Assign a UUID once on first
   persist and keep it across edits/date moves — edits must target the
   existing id (this is the root cause of duplicate-on-edit).
5. Identity: make phone→userId linking robust (supabase_tasks.user_id_for_phone;
   app_settings."whatsAppPhone"); add a server verify endpoint; when uid is
   unresolved, queue+retry instead of silently dropping (server/main.py:222-246).
6. Enable pull bridge for signed-in users too (remove early-return at
   src/services/WhatsAppTaskSync.ts:51) + periodic refresh on focus in
   src/hooks/useTasks.ts:61.
7. Canonical GET /tasks/{phone} shape (server/main.py:124-145 returns different
   id schemes depending on DB availability — unify to one).
8. One-time conservative migration: re-key existing wa_ rows to UUIDs, merge
   only exact text+date duplicates.

## PHASE 2 — EDIT EXISTING TASKS (next after Phase 1)
- No create-vs-update intent detection exists. Client always inserts
  (useTasks.ts:171 → TaskStorage.addTasksForDate). TaskMatcher.ts is DEAD CODE
  (zero callers) — reuse it for reference resolution.
- Add src/services/TaskIntent.ts (classify create/update/complete/delete,
  EN+HE verbs, LLM fallback; extract patch via TaskParser extractors), branch
  in useTasks to updateTaskFields/markTaskComplete, confirm-before-apply,
  disambiguate on ties.
- Server: add find_task + update_task tools in lumi_agent.py _make_tools
  (line ~212, register ~385, prompt ~461); add update_task PATCH-by-id in
  supabase_tasks.py; route in main.py webhook.

## PHASE 3 — TRANSPORT + MAPS
- Add TaskLocation.transportType (per-task override; profile is fallback).
- GoogleService.ts: unify getPlanForMode(mode) (currently hardcoded transit at
  line ~298; getCarDriveTime misuses leg type 'walk') + compareModes() sorted
  fastest. Stop discarding overview_polyline (also server geo.py ~191).
- TaskDetailBottomSheet: transport chips row (copy priority-chips pattern
  ~line 365) → recompute plan + leaveHomeBy on change (TodaySchedule.handleUpdate).
- New src/components/RouteMap.tsx: react-native-maps Polyline + markers +
  "Navigate" button deep-linking Google Maps. gate behind isExpoGo.

## PHASE 4 — EVENING PLAN TOMORROW
- PlanTomorrow.tsx is an ORPHAN (not registered in App.tsx navigator, fetches
  nothing). Register it; add planTomorrowFromGoogle() in GoogleSync.ts
  (generalize syncCalendarToday's hardcoded today at line ~81 to any date;
  bucket gmail suggestions to tomorrow); evening notification (20:00, exists in
  NotificationService ~162) gets a "Plan tomorrow" action routing there.

## PHASE 5 — ALARM SPEAK + AVATAR
- Speak pipeline already works: MorningBriefingService.speakMorningBriefingNow
  (tap-triggered from App.tsx:73-87). Add AppState-active trigger + daily
  briefing recompose; transit wake path should reuse scheduleWakeAlarm data.
- LumiOrb.tsx (gold clock-coin, plain Views, only 2 call sites in
  TodaySchedule.tsx:277,339, props size/pulse) → new LumiCharacter.tsx with
  states idle/talking/wave/celebrate, RN Animated, purple+gold. Keep LumiOrb
  name as shim. Drive 'talking' from SpeechService.speak.

## VERIFY EACH PHASE
tsc/npx expo start --clear must pass; py_compile for server files; commit per
phase on feature/lumi-upgrade. Test Phase 1: (a) WhatsApp task appears in app
and survives app saves; (b) completing in app survives WhatsApp re-mention.
