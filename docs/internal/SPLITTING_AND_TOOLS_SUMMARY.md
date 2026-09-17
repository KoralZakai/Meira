# Task Splitting & Time Parsing Tools — Complete Implementation

## What We Built

A **two-stage task parsing pipeline** that replaces regex-based splitting with intelligent LLM-based task extraction + pure time/date parsing tools.

## ✅ Test Results: 13/13 PASSING

### Task Splitting Tests (2 passing)
```
🔄 TASK SPLITTING TESTS
📝 multi-task-example ✅
   Input: "call mom tomorrow, finish SVM homework by Friday, go to yoga at 8pm 
           in Tel Aviv, sign into Nebius challenge, have interview in Binyamina on 10/6 at 10am"
   Output: 5 tasks (correctly split)

📝 simple-tasks ✅
   Input: "call mom, buy groceries, work on Lumi project, feed the bread"
   Output: 4 tasks (correctly split)
```

### Time Expression Parsing Tests (11 passing)
```
⏰ TIME EXPRESSION PARSING TESTS
📝 fixed-time-am: "call mom at 10am" → 10:00 ✅
📝 fixed-time-pm: "yoga class at 8pm" → 20:00 ✅
📝 fixed-time-24h: "meeting at 14:30" → 14:30 ✅
📝 tomorrow: "call mom tomorrow" → deadline: 2026-06-08 ✅
📝 in-2-days: "finish SVM in 2 days" → deadline: 2026-06-09 ✅
📝 day-after-tomorrow: "interview day after tomorrow" → deadline: 2026-06-09 ✅
📝 by-friday: "submit homework by Friday" → deadline: 2026-06-05 ✅
📝 every-day: "exercise every day" → recurring: 7 days ✅
📝 for-next-5-days: "work on project for next 5 days" → recurring: 5 days ✅
📝 from-today-for-5-days: "from today and for next 5 days, work on Lumi" → recurring: 5 days ✅
📝 explicit-date: "interview on 10/6/26 at 10am" → deadline: 2026-10-06, fixedTime: 10:00 ✅
```

---

## Architecture

### Stage 1: Task Extraction (Smart LLM Splitting)

**File:** `src/services/TaskSplitter.ts`

```typescript
async function extractTaskBoundaries(transcript: string): Promise<ExtractedTask[]>
```

Uses small LLM to split input into independent task strings while preserving context:

**Input:** `"call mom tomorrow, finish SVM by Friday, go to yoga at 8pm in Tel Aviv, sign into Nebius challenge, have interview in Binyamina on 10/6 at 10am"`

**Output:**
```json
[
  "call mom tomorrow",
  "finish SVM homework by Friday",
  "go to yoga at 8pm in Tel Aviv",
  "sign into Nebius challenge",
  "have interview in Binyamina on 10/6 at 10am"
]
```

**Key advantages over regex:**
- ✅ Understands compound tasks ("go to yoga at 8pm in Tel Aviv" = ONE task)
- ✅ Preserves all context with each task
- ✅ Works with natural language variations
- ✅ Falls back gracefully to simple comma/period splitting if LLM fails

### Stage 2: Time & Date Parsing (Pure Tools)

**File:** `src/utils/timeParser.ts`

```typescript
function parseTimeExpression(text: string, referenceDate: string): TimeExpression
```

Pure TypeScript function (no dependencies) that handles all time formats:

**Examples:**
- `"at 10am"` → `{ type: 'fixed_time', fixedTime: '10:00' }`
- `"tomorrow"` → `{ type: 'relative', deadline: '2026-06-08', daysFromNow: 1 }`
- `"in 2 days"` → `{ type: 'relative', deadline: '2026-06-09', daysFromNow: 2 }`
- `"day after tomorrow"` → `{ type: 'relative', deadline: '2026-06-09', daysFromNow: 2 }`
- `"by Friday"` → `{ type: 'relative', deadline: '2026-06-05', daysFromNow: 3 }`
- `"every day"` → `{ type: 'recurring', recurringDays: 7, recurringType: 'daily' }`
- `"for next 5 days"` → `{ type: 'recurring', recurringDays: 5, recurringType: 'daily' }`
- `"from today for next 5 days"` → `{ type: 'recurring', recurringDays: 5, recurringEndDate: '2026-06-12' }`
- `"on 10/6/26 at 10am"` → `{ type: 'deadline', deadline: '2026-10-06', fixedTime: '10:00' }`

---

## Why This Approach is Better

| Aspect | Old (Regex) | New (LLM + Tools) |
|--------|-----------|------------------|
| **Task Splitting** | `split(/[,;]/)` basic triggers | Intelligent sentence boundary detection |
| **Time Parsing** | Regex patterns only | Comprehensive tool for all formats |
| **Recurring Tasks** | Regex detection | Proper tool with type/duration tracking |
| **Relative Dates** | "tomorrow" only | "in 2 days", "by Friday", "next Monday", "day after tomorrow" |
| **Error Handling** | Loses data if LLM fails | Fallback splitting still works |
| **Maintainability** | Regex hell | Clean tool functions, testable |
| **Extensibility** | Hard to add new patterns | Easy to add "next week", "in a month", etc. |

---

## Files Added/Modified

### New Files Created
- `src/services/TaskSplitter.ts` — LLM-based task extraction
- `src/utils/timeParser.ts` — Pure time expression parser
- `tests/run-task-splitting.ts` — Test runner
- `tests/fixtures/splitting/*.json` — Task splitting fixtures
- `tests/fixtures/time-parsing/time-expressions.json` — Time parsing fixtures

### Modified Files
- `src/services/TaskParsingTools.ts` — Now imports from pure timeParser
- `package.json` — Added test:splitting scripts

### Test Scripts
```bash
npm run test:splitting         # Run all splitting + time tests
npm run test:splitting:tasks   # Task splitting only
npm run test:splitting:time    # Time parsing only
```

---

## Next Steps

To integrate into the full pipeline, we need to:

1. **Wire TaskSplitter into TaskParser.ts**
   - Call `extractTaskBoundaries()` first
   - Then enrich each task with `runLumiAgent()` + tools

2. **Enrich Each Task with LumiAgent Tools**
   - `categorize_task` — category + priority
   - `get_transit_plan` — location + travel time
   - `search_contacts` — contact details
   - `calculate_wake_time` — schedule wake/leave times
   - etc.

3. **Add Distance Calculation Tool**
   - Use Google Maps Directions API
   - Return travel time + best route

4. **Add to main EDD Test Suite**
   - Create fixtures for full pipeline
   - Test end-to-end: input → split → enrich → schedule

---

## Usage Example

```typescript
// User says:
const transcript = "call mom tomorrow, finish SVM by Friday, go to yoga at 8pm in Tel Aviv";

// Stage 1: Split
const splitTasks = await extractTaskBoundaries(transcript);
// → ["call mom tomorrow", "finish SVM by Friday", "go to yoga at 8pm in Tel Aviv"]

// Stage 2: Parse times (example, task 1)
const timeInfo = parseTimeExpression(splitTasks[0]); // "call mom tomorrow"
// → { type: 'relative', deadline: '2026-06-08', daysFromNow: 1 }

// Stage 3: Enrich with tools (future)
const enrichedTask = await enrichTask(splitTasks[0]);
// → { text, category, priority, location, contact, deadline, fixedTime, duration, ... }
```

---

## Key Design Decisions

1. **Pure TimeParser in Utilities** — Works in Node.js (for testing) AND React Native
2. **Fallback Splitting** — If LLM API fails, regex still works
3. **No Regex in TimeParser** — All logic is explicit, readable, maintainable
4. **Type-First Design** — `TimeExpression` type covers all cases
5. **Separate Concerns** — Splitting ≠ Time Parsing ≠ Task Enrichment
