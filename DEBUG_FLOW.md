# 🔍 LUMI HALLUCINATION DEBUGGING WORKFLOW

## The Three-Layer Debug Strategy

You now have **three complementary debug tools** that work together:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: TaskStorageAudit.ts (Storage writes)              │
│  → Logs EVERY save/load operation                           │
│  → Shows WHEN duplicates/phantom tasks are written          │
│  → Identifies CALLER (which function created the task)      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: LLMService instrumentation (LLM reasoning)         │
│  → Logs EVERY tool call and result                          │
│  → Shows WHICH tool created the phantom location            │
│  → Tracks build_schedule input vs output                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: NotificationService instrumentation (Notifications)│
│  → Logs EVERY notification scheduled                        │
│  → Shows WHICH tasks triggered notifications                │
│  → Captures notification IDs for audit                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: DebugService.generateFullReport() (Analysis)      │
│  → Cross-references all three layers                        │
│  → Detects patterns (duplicates, phantoms)                  │
│  → Produces final diagnostic report                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 SETUP (5 minutes)

### **Step 1: Copy the three debug files into your project**

**Files to create:**
- `src/services/DebugService.ts` ← Copy from `LumiDebugService.ts`
- `src/services/TaskStorageAudit.ts` ← Copy as-is
- Instrument `src/services/LLMService.ts` ← Add logging from guide
- Instrument `src/services/NotificationService.ts` ← Add logging from guide

### **Step 2: Import DebugService on app startup**

In your main screen (e.g., `src/screens/HomeScreen.tsx`):

```typescript
import { DebugService } from '../services/DebugService';

export default function HomeScreen() {
  useEffect(() => {
    DebugService.init();
  }, []);
  
  // ... rest of component
}
```

### **Step 3: Replace TaskStorage imports with TaskStorageAudit**

Search for:
```typescript
import { TaskStorage } from './services/TaskStorage';
```

Replace with:
```typescript
import { TaskStorageAudit as TaskStorage } from './services/TaskStorageAudit';
```

Or simpler — in the single file that loads/saves tasks, just use `TaskStorageAudit` directly:

```typescript
import { TaskStorageAudit } from './services/TaskStorageAudit';

// Use TaskStorageAudit instead of TaskStorage
const tasks = await TaskStorageAudit.loadTasks(date);
```

---

## 🎙️ TEST SCENARIO

Send **exactly this voice message** so we get consistent data:

> "I need to study for an exam tomorrow at 2 PM, and also I have a doctor appointment tomorrow morning at 9."

**Expected behavior:**
- 2 tasks created
- Both scheduled for tomorrow
- No phantom locations
- No duplicate IDs
- 0 unwanted notifications (until those times arrive)

---

## 📊 RUN THE DIAGNOSTIC

**After sending the voice message:**

1. **Open the React Native debugger console**
   - Metro output in Terminal
   - Or: Long-press your device → "Toggle Element Inspector"

2. **Paste this into the console:**

```javascript
import { DebugService } from './services/DebugService';
DebugService.generateFullReport();
```

Or if you added a debug button, just tap it.

3. **Screenshot/copy the entire console output**

---

## 🔍 WHAT TO LOOK FOR

### **Red Flags (indicate the bug)**

#### Flag 1: Duplicate Task IDs
```
❌ DUPLICATE ID (2x): "Finish CUDA homework" [task-abc123]
```
**Means:** Task object got saved twice with same ID
**Next check:** Look at TaskStorageAudit logs to see WHICH caller saved it twice

#### Flag 2: Phantom Locations
```
⚠️ PHANTOM LOCATION: "Study for exam" → "Tel Aviv-Yafo, Israel"
```
**Means:** LLM added a location that wasn't mentioned
**Next check:** Look at LLMService logs - which tool call created this?

#### Flag 3: Orphaned Notifications
```
📬 "Study for exam" → 6 notifications
   [1] notif-id-123
   [2] notif-id-456
   [3] notif-id-789
   [4] notif-id-abc
   [5] notif-id-def
   [6] notif-id-ghi
```
**Means:** Notifications scheduled 2x or 3x for same task
**Next check:** Look at NotificationService logs - did it get called multiple times?

#### Flag 4: Tool Call Loop
```
🔄 Iteration 1:
   → categorize_task
   → get_transit_plan ← Why here? No location mentioned!
   → build_schedule
```
**Means:** `get_transit_plan` was called unexpectedly
**Next check:** Look at tool input - what location did it try to plan for?

---

## 📋 DIAGNOSIS FLOWCHART

```
Start: Phantom notifications detected
│
├─ Run DebugService.generateFullReport()
│
├─ Check: Are there duplicate task IDs?
│  ├─ YES → Duplicate ID bug
│  │        Look at TaskStorageAudit logs
│  │        Find which caller saved twice
│  │        (Likely: LLMService creating + saveTask called twice)
│  │
│  └─ NO → Continue
│
├─ Check: Are there phantom locations?
│  ├─ YES → Phantom location bug
│  │        Look at LLMService logs
│  │        Find which tool created the location
│  │        (Likely: get_transit_plan called on wrong task)
│  │
│  └─ NO → Continue
│
├─ Check: Too many notification IDs?
│  ├─ YES → Notification scheduling bug
│  │        Look at NotificationService logs
│  │        Count how many times it was called per task
│  │        (Likely: scheduleTransitNotifications called twice)
│  │
│  └─ NO → Continue
│
└─ Check: Tool call loop iterations
   ├─ HIGH (10+) → LLM looping, possibly confused
   │              Check what tools keep being called
   │
   └─ NORMAL (3-5) → Storage or notification issue
                     (see above)
```

---

## 💡 MOST LIKELY CULPRITS

Based on your pattern (phantom locations like "Tel Aviv", "Haifa"):

### **Hypothesis 1: Task Merge/Correction Bug**
- You said: "Kickbox, bring bikes and finish cuda is for TODAY"
- System created a **new corrected version**
- But **didn't delete the old one**
- Now there are TWO task objects
- Notifications fire for both
- **Check:** `TaskStorageAudit.deleteTask()` logs

### **Hypothesis 2: `get_transit_plan` Hallucination**
- LLM's `build_schedule` tool somehow receives wrong tasks
- It calls `get_transit_plan` on tasks that never had locations
- Those tasks get location data injected
- **Check:** LLMService logs — look for unexpected `get_transit_plan` calls

### **Hypothesis 3: Backend Sync Issue**
- WhatsApp backend created tasks without your input
- Phone synced them back to client
- Client now has duplicates
- **Check:** Are phantom notifications coming from WhatsApp messages or device alerts?

### **Hypothesis 4: Notification Re-Scheduling**
- `scheduleTransitNotifications()` got called multiple times per task
- Each call adds 3 more notification IDs
- After 3rd call: 9 notifications for 1 task
- **Check:** NotificationService logs — count function calls

---

## 🎯 EXACT NEXT STEPS

**Do these in order:**

1. **Copy the three debug files into your project** ✓
2. **Add DebugService.init() to app startup** ✓
3. **Replace TaskStorage with TaskStorageAudit** ✓
4. **Send the test voice message** ✓
5. **Run `DebugService.generateFullReport()`** ✓
6. **Share with me:**
   - Full console output (screenshot or copy-paste)
   - Your voice input text
   - Whether phantom notifications came via WhatsApp or device

---

## 📞 WHAT I'LL ASK NEXT

Once you share the diagnostic output, I'll ask:

1. **"Show me the TaskStorageAudit logs — specifically the SAVE operations"**
   - This reveals WHERE the phantom task was written
   - And WHICH function called saveTasks()

2. **"Show me the LLMService logs for the iteration with build_schedule"**
   - This reveals WHICH tools were called
   - And what phantom location was used

3. **"Show me the NotificationService logs"**
   - This reveals HOW MANY times scheduleTransitNotifications was called
   - For which tasks

4. **"Is your backend deployed, or is this frontend-only?"**
   - If backend: is it creating extra tasks?
   - If frontend-only: bug is definitely in client-side LLM flow

---

## 🔧 AFTER DIAGNOSIS

Once we identify the root cause, the fix will be one of:

### **If Duplicate Task ID:**
```typescript
// In LLMService.ts — add before saveTask
const existing = await TaskStorage.loadTaskById(task.id);
if (!existing) {  // Only save if NEW
  await TaskStorage.updateTask(task);
}
```

### **If Phantom Location:**
```typescript
// In executeToolCall — add before calling get_transit_plan
if (!userMentionedThisLocation(toolInput.destination_address)) {
  return { error: 'Location not mentioned in voice input' };
}
```

### **If Double Notification:**
```typescript
// In NotificationService — add at start of scheduleTransitNotifications
if (task.notificationIds && task.notificationIds.length > 0) {
  // Already scheduled, skip
  console.log('Notifications already scheduled, skipping');
  return;
}
```

---

## ✅ SUCCESS CRITERIA

After the fix, run the test scenario again. You should see:

✅ 2 tasks created (no duplicates)
✅ Both on tomorrow's date
✅ No phantom locations
✅ Notification IDs = 3 per transit task (wake, leave, re-check)
✅ No extra WhatsApp messages

---

## 📞 SHARE WITH ME

Create a Gist or just copy-paste:

```
LUMI DEBUGGING OUTPUT
Date: 2026-06-28
Test: Study for exam + doctor appointment

CONSOLE OUTPUT:
[copy entire console output here]

QUESTIONS:
1. Are phantom notifications from WhatsApp or device?
2. Backend deployed or frontend-only?
3. Have you seen this pattern before?
```

---

**You've got this! 🚀**

The debug suite will show us exactly where the hallucination happens.