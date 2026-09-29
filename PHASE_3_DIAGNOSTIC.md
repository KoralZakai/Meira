# Lumi Phase 3 — Diagnostic & Roadmap
**Date:** 2026-08-27  
**Status:** Infrastructure built, breaking in Phase 2.5 (learning groundwork), roadmap for Phase 3

---

## Executive Summary

Lumi has the **foundation** for everything the roadmap asks for. The pieces exist but are:
- **Broken:** WhatsApp agent (saves tasks with no time; no semantic place memory)
- **Unused:** Live GPS (positionDrift.ts has zero consumers)
- **Incomplete:** Learning engine (records durations, not integrated into estimation)
- **Silent:** No multi-transport learning (user types "take the bus" but never confirms if bus was actually taken)

**Phase 3 is NOT about architecture — it's about wiring existing code and fixing the broken parts.**

---

## Part I: What Works Today

### ✅ Core App (verified on-device)
- Task creation via speech + typed input
- Full schedule display (sorted by priority → leaveHomeBy time)
- Location-based alerts (wake, leave, arrival check)
- Transit routing via Google (bus/train with real times)
- Task completion rewards + stats
- Hebrew + English
- Cloud sync via Supabase (two silent bugs fixed)

### ✅ Infrastructure Layers (built but partially integrated)

| Layer | Status | Notes |
|-------|--------|-------|
| **Live GPS** | Built, zero consumers | positionDrift.ts: Haversine distance, 300m threshold, drift verdict + reason |
| **Place Memory** | Partial | user_memory.py exists (behaviors/routines), but no place clustering |
| **Transportation** | Partial | TRANSPORT_WORDS dict in LumiCoachEngine, but no learning from user confirmation |
| **Learning Engine** | Being wired now | Records durations (derivedDurationMinutes), per-category rolling averages (LearningService) |
| **Coach Pattern** | Built | LumiCoachEngine (pure, React-free) routes app + WhatsApp into one brain |
| **WhatsApp Agent** | Broken | LangGraph setup works, but saves tasks with no time |

---

## Part II: The Broken Piece — WhatsApp Agent

### Symptom
User says "gym and party this evening" → only party saved.  
Every WhatsApp task arrives with `scheduledTime: "--:--"` (no time).  
They don't appear on the Today timeline.

### Root Cause (from lumi_agent.py)

The agent's `infer_task_details` tool (line ~345) should set `fixed_time` or `date`. It does.
But the **server's save path** (main.py) creates tasks in two places:
1. **Via Nebius LLM** → returns structured `{fixed_time, date, ...}` → SAVED
2. **Via database_service.add_task()** → called by agent after inference → **OVERWRITES with defaults**

Missing time is likely an **unpatched edge case** in how the LLM output is mapped to the database shape.

**Debug steps:**
```bash
# Read real conversation (requires ADMIN_TOKEN or fly ssh)
fly ssh console -a lumi-whatsapp
python3 -c "import reminders; print(reminders.get_departures('972500000009', limit=10))"
```

### Why This Matters
- WhatsApp is the **intended primary input channel** (CLAUDE.md handoff)
- App-created tasks work fine → **channel integration is the issue, not the core engine**
- Every learned place, time estimate, and transport choice **must flow through WhatsApp** to reach people who only message

---

## Part III: Silent Infrastructure (Ready to Use)

### A. Live GPS + Dynamic Origin (positionDrift.ts)

**Status:** Written, tested, zero consumers.

```typescript
// What it does
distanceMetres(assumed: LatLng, actual: LatLng): number  // Haversine
assessDrift(...): { shouldReplan: boolean, reason, metres }
describeReplan(...): string  // "You've moved 1.2 km — leave at 09:15, not 09:30"
```

**Where it should integrate:**
1. **ScheduleScreen** (live): Show "🚶 You're at Space Gym. Leave by 09:15" if drift detected
2. **App background task** (Expo TaskManager): Poll location every 3 min when a route is active
3. **Coach engine:** Pass real position to re-plan the route

**What's missing:**
- No consumer that polls location
- No background task setup in App.tsx
- No UI that shows "re-planned because you moved"

### B. Place Memory (user_memory.py)

**Status:** Server-side, has shelf for places, never filled.

```python
_DEFAULTS = {
    "routines": ["wakes at 07:30", "arrives home by 19:00"],
    "contacts": [{"name": "אימוש", "number": "..."}, ...],
    # MISSING: "places": [{"name": "Space Gym", "address": "יגאל אלון 94", "lat": 32.xxx, "lng": 34.xxx}, ...]
}
```

**Where it should integrate:**
1. **Every completed task with location** → cluster nearby completions (Space Gym + Kickbox might be same place)
2. **User says "gym" → resolve to known address** without asking
3. **Hermes judge block** → "Based on {places}, here's a faster route"

**What's missing:**
- No clustering logic (DBSCAN or grid-based)
- No semantic matching ("training" = "gym")
- No feedback loop ("that's not right" → re-cluster)

### C. Transportation Learning (LumiCoachEngine + user_profile.py)

**Status:** Transport words detected, no confirmation recorded.

```typescript
// LumiCoachEngine line 84–90
const TRANSPORT_WORDS: Record<string, 'car' | 'transit' | 'foot' | 'bicycle'> = {
  train: 'transit', bus: 'transit', car: 'car', walk: 'foot', bike: 'bicycle',
};
detectTransport(text): ... // returns mode or null
```

**Current flow:**
```
User: "go by bus"
  → detectTransport() returns 'transit'
  → route planned (Google Directions with mode=transit)
  → task saved
  → [END]
```

**Missing:**
- No record of **what transport was actually taken**
- `task.actualTransportMode` field does not exist
- Can't learn "Koral takes the bus 70% of the time to work" for next time

**Should be:**
```
User: "Interview at Space Gym, by bus"
  → Route planned, saved
  → Later: completion nudge includes "How did you get there? [Bus] [Car] [Walk] [Other]"
  → Answer recorded → rolling average per location/time-of-day
```

### D. Task Overlap Detection (LumiCoachEngine exists, used for clashes)

**Status:** Detects clashes, offers choices. Not tested for overlaps with recurring patterns.

```typescript
// LumiCoachEngine: checkConflicts() already works
// Finds: back-to-back in two places (impossible travel time)
// Offers: reschedule one or pick which one is more urgent
```

**What works:** Same-day clash detection.  
**What's missing:** 
- Multi-day patterns ("every Tuesday at 10, every Thursday at 10" → if user adds a Wed task at 10, should it warn?)
- Recurring events from Google Calendar synced into clash detection

---

## Part IV: Learning Engine — Phase 2.5 Groundwork (Current Changes)

### What's Being Wired Now

1. **Record real durations** (TaskStorage.ts)
   ```typescript
   derivedDurationMinutes(task, completedAt): number | undefined
   recordCompletionLearning(task)
   ```

2. **Per-category rolling averages** (LearningService)
   ```typescript
   recordTaskCompletion(task, actualMinutes)
   // Updates: UserStats.categoryDurationAverages[category] = 
   //   weighted(0.7 * old, 0.3 * new)
   ```

3. **Learned lead times in alerts** (NotificationService.ts)
   ```typescript
   learnedLeads(): Record<TaskCategory, number>
   // planFixedTimeAlerts() now uses these instead of category defaults
   ```

4. **Real departure recording** (NotificationService.ts)
   ```typescript
   recordDeparture(taskId)
   // "I left" button now records task.lastDepartureDetectedAt for lateness model
   ```

### Missing Links

| Input | Status | Why Needed |
|-------|--------|-----------|
| **Duration** | ✅ Recording | Estimate next gym session accurately |
| **Lead time** | ⏳ Partially | Alerts fire at right time, but source is category default, not learned |
| **Departure** | ✅ Recording | Compare planned vs. actual "leave by" for lateness model |
| **Transport mode** | ❌ Not recorded | Can't learn user prefers bus to work, car to gym |
| **Place** | ❌ Not clustered | "Gym" could be 3 different addresses, no semantic grouping |
| **Calendar context** | ❌ Not integrated | Google Calendar events don't feed into conflict/overlap detection |

### Lateness Model (Not Yet Built)

**Current state:** Alerts use `fixedTime` + learned duration.  
**Not yet:** Compare `lastDepartureDetectedAt` vs. `leaveHomeBy` to model "Koral leaves 8 min after alerts on average."

**This is needed for:**
- If appointment is at 10:30 and she typically leaves 8 min late, plan for 10:38 actual departure
- "You usually leave 8 min late — this bus gets you there by 10:36, cut it close"

---

## Part V: Hermes Agent Architecture (For WhatsApp)

### Current WhatsApp Stack

```
User message (WhatsApp)
  ↓
main.whatsapp_webhook (FastAPI)
  ↓
handle_whatsapp_message(phone, content, language)
  ↓
_extract_profile(phone, content)  [forced tool_choice → save_profile]
  ↓
create_react_agent(llm, tools)  [LangGraph]
  ├─ get_my_tasks
  ├─ infer_task_details
  ├─ get_transit_plan
  ├─ save_memory
  └─ [others]
  ↓
agent.ainvoke(messages, config)  [ReAct loop, max 10 iterations]
  ↓
_location_from_departure(plan: dict) → TaskLocation
  ├─ map legs to TransitLeg shape
  ├─ create transitPlan JSON
  └─ save as task.location
  ↓
add_task(phone, task)  [BREAKS HERE: no fixed_time saved]
  ↓
schedule_departures(departures)  [reminders.py]
```

### The Problem (Hypothesis)

`infer_task_details` returns `{fixed_time: "11:00", ...}`.  
`add_task` → database insert: `task.scheduled_time = fixed_time` ✅.  
BUT then `main.py` calls `update_task(task)` which **overwrites** if no `date` or wrong shape.

**What should happen:**
1. LLM returns structured task
2. Direct insert: `INSERT INTO tasks (fixed_time, ...) VALUES (...)`
3. No secondary update that erases it

### Hermes Mimic Needed

**Hermes trait:** Every tool call is logged, so the model never leaks raw JSON into text.  
**Lumi should adopt:** Every conversation turn includes diagnostic bookkeeping:

```python
# In lumi_agent.py, after every turn:
{
  "turn": 1,
  "input": "go to the gym tomorrow at 11",
  "tools_called": ["infer_task_details", "get_transit_plan", "schedule_task"],
  "tasks_saved": [{"id": "gym-1", "fixed_time": "11:00", "date": "2026-08-28"}],
  "reply": "Got it! Space Gym at 11:00 tomorrow 🏋️",
  "diagnostics": {
    "degenerate": false,
    "retry_count": 0,
    "latency_ms": 2340
  }
}
```

This log is **never** sent to the user, but it:
- Catches the save failure immediately
- Feeds replay testing
- Powers `/diag/sync`-like probes for WhatsApp

---

## Part VI: The Roadmap (Phase 3)

### Sprint 1: Fix WhatsApp Agent (1–2 days)
**Goal:** Every task arrives with a time.

1. Add diagnostic logging to lumi_agent.py (every save, what was saved)
2. Trace a real conversation: `fly ssh`, read `departures` table, rewind to user input
3. Reproduce the bug locally with a test case
4. Fix the root cause (likely in add_task or _location_from_departure)
5. Test: "gym and party" → two tasks, both timed

### Sprint 2: Live GPS → Real Origin (3–5 days)
**Goal:** "You're at Space Gym — leave by 09:15" when user is mid-journey.

1. Add background task polling (Expo TaskManager) in App.tsx
2. Feed real position into LumiCoachEngine.assessDrift()
3. On drift > 300m: call optimize_day with new origin
4. Display re-plan reason: "🚶 You moved 1.2 km. New leave time: 09:15"
5. Test: Simulate location changes, verify alerts update

### Sprint 3: Place Clustering (4–6 days)
**Goal:** "gym" resolves to known address; "training" recognized as gym variant.

1. Add `places` to user_memory.py with clustering
2. On task completion: (lat, lng, category) → cluster by DBSCAN (eps=100m)
3. On task input: semantic match user's word choice ("training", "workout") to category
4. User can confirm: "is this Space Gym?" or edit address in detail modal
5. Test: Multiple tasks at same address → merged into one place

### Sprint 4: Transportation Learning (2–4 days)
**Goal:** Lumi learns "Koral takes the bus to work (90%), drives to gym (100%)."

1. Add `actualTransportMode` field to Task
2. On completion nudge: include transport picker (+ actual time estimate)
3. Record: `user_memory.places[place].transportModes = {bus: 5, car: 1, walk: 2}`
4. On next task at that place: suggest most-used mode first
5. Test: Multiple completions per place → learn preference

### Sprint 5: Multi-Day Overlap Detection (2–3 days)
**Goal:** Warn on impossible patterns or recurring conflicts.

1. Extend checkConflicts() to scan full week, not just today
2. Detect: same time slot every X days + new conflicting task
3. Offer: snooze the new one, or reschedule the recurring
4. Integrate: Google Calendar recurring events
5. Test: Weekly meeting + new task same time → warning

### Sprint 6: Lateness Model (3–5 days)
**Goal:** "You usually leave 7 min late — this bus gets you there by 10:36."

1. Aggregate `lastDepartureDetectedAt - leaveHomeBy` per user
2. Learn: rolling average of actual lateness
3. On planning: shift assumed-departure by lateness
4. Alert: if new plan + lateness = late, warn explicitly
5. Test: 10 completions with known lateness → accurate forecast

### Sprint 7: Hermes-Like Diagnostics (2–3 days)
**Goal:** Every agent turn is logged; failures are caught immediately.

1. Wire logging to lumi_agent.py
2. Add `/diag/agent/{phone}` endpoint (shows last 5 turns, what was saved)
3. Add retry logic: if save fails, agent catches and re-asks for clarification
4. Test: Inject failures, verify diagnostics + retry

---

## Part VII: Architecture Sketch (Phase 3+)

```
┌─────────────────────────────────────────┐
│  User Input (App, WhatsApp, Calendar)  │
└──────────────┬──────────────────────────┘
               ↓
       ┌───────────────────┐
       │  LumiCoachEngine  │ (pure, both channels)
       │  ├─ extract task  │
       │  ├─ infer details │
       │  ├─ plan route    │
       │  └─ detect clash  │
       └───────┬───────────┘
               ↓
       ┌───────────────────┐
       │  LearningEngine   │ (per category)
       │  ├─ durations     │
       │  ├─ lead times    │
       │  ├─ lateness      │
       │  └─ transport     │
       └───────┬───────────┘
               ↓
       ┌───────────────────┐
       │  PlaceMemory      │ (clustered)
       │  ├─ location      │
       │  ├─ address       │
       │  ├─ transport     │
       │  └─ semantic      │
       └───────┬───────────┘
               ↓
    ┌──────────────────────────┐
    │  TaskStorage (Supabase)  │
    │  + live GPS tracking     │
    └──────────────────────────┘
               ↓
    ┌──────────────────────────┐
    │  Notification Engine     │
    │  (learned lead times)    │
    └──────────────────────────┘
```

---

## Part VIII: What's Blocking Right Now

| Issue | Impact | Fix |
|-------|--------|-----|
| WhatsApp saves no time | Tasks don't appear on timeline | Debug lumi_agent.py save path |
| positionDrift unused | Can't re-plan mid-journey | Add background task in App |
| No place clustering | "Gym" could be 3 addresses | Implement DBSCAN in user_memory |
| No transport learning | Can't suggest bus vs. car | Add actualTransportMode field |
| Lateness model missing | Alerts fire at wrong time for chronically late users | Aggregate departure data |
| No Hermes logging | Failures are silent | Wire diagnostics to lumi_agent |

---

## Part IX: Commands to Verify Current State

```bash
# 1. Check sync is working
curl -s "https://lumi-whatsapp.fly.dev/diag/sync?phone=972500000009" | python3 -m json.tool

# 2. Run app tests (should be green)
npm run test:all

# 3. Check TypeScript (36 errors is baseline)
npx tsc --noEmit 2>&1 | wc -l

# 4. Run alert integrity (regression guard)
npx tsx tests/run-alert-integrity.ts

# 5. Check position drift logic
npx tsx tests/run-position-drift.ts

# 6. Check learning engine
grep -r "recordTaskCompletion\|learnedLeads" src/

# 7. Verify memory.py is callable
cd server && python3 -c "import user_memory; print(user_memory.get_memory('test_phone'))"
```

---

## Summary: What to Do Next

**Immediate (today):** Commit the Phase 2.5 changes (learning groundwork).  
**This week:** Fix WhatsApp agent (highest impact, smallest scope).  
**Next:** Wire live GPS + place memory (enable real learning).  
**Vision:** Lumi remembers you — where you go, when you leave, how long things take.
