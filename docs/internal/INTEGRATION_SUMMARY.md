# Two-Stage Task Parser Integration - Summary

**Date:** 2026-06-07  
**Status:** ✅ Complete & Tested

---

## What Was Implemented

### Integration Goal
Wire the new two-stage task parsing pipeline into the main TaskParser, enabling:
1. **Stage 1**: LLM-based intelligent task boundary detection (`extractTaskBoundaries`)
2. **Stage 2**: Pure time/date expression parsing (`parseTimeExpression`)
3. **Stage 3**: LLM agent enrichment with all tools (`runLumiAgent`)

### Key Changes

#### 1. **TaskParser.ts** - New Two-Stage Parser Entry Point

**New Function:** `parseSpeechToTasksWithEnrichment(transcript, context)`

```typescript
export async function parseSpeechToTasksWithEnrichment(
  transcript: string,
  context: AgentContext
): Promise<ParsedTask[]>
```

**Pipeline:**
```
User Input
    ↓
[Stage 1] extractTaskBoundaries()
    ↓
Task Strings[] (e.g., "call mom tomorrow", "yoga at 8pm")
    ↓
[Stage 2] parseTimeExpression() for each task
    ↓
Time Expressions[] (type: fixed_time | deadline | recurring | relative | none)
    ↓
[Stage 3] runLumiAgent() for each task
    ↓
Agent Enrichment: category, priority, location, contacts, transit, etc.
    ↓
ParsedTask[] (fully enriched)
```

**Processing Flow:**
1. Extract task boundaries using LLM (with fallback to simple regex)
2. For each extracted task string:
   - Parse time expressions (fixed time, deadline, recurring, relative dates)
   - Enrich with LLM agent tools (categorization, priority, transit plans, contact lookup)
   - Combine results into ParsedTask with all enriched fields
3. Return array of fully enriched ParsedTask objects

#### 2. **Backward Compatibility**

Original `parseSpeechToTasks()` function retained for cases where enrichment context is unavailable:
- Used by existing code that doesn't have UserProfile/date/language context
- Falls back to legacy LLM-based parsing when enrichment context not provided
- No breaking changes to existing API

#### 3. **Test Suite**

**New Test File:** `tests/run-integration-parser.ts`

**Test Cases (5/5 passing):**
- ✅ Single task with fixed time (detects "10:00" from "call mom at 10am")
- ✅ Multiple tasks (splits "call mom, buy groceries, work on project" into 3 tasks)
- ✅ Task with deadline (detects "Friday" deadline from relative date)
- ✅ Task with location (detects "8pm" from "yoga at 8pm in Tel Aviv")
- ✅ Recurring task (detects "every day for 7 days" from input)

**Command:** `npm run test:integration`

---

## Architecture

### Data Flow Example

**Input:** "call mom tomorrow and finish SVM homework by Friday and go to yoga at 8pm in Tel Aviv"

**Stage 1 - Extract Boundaries:**
```
Result: [
  "call mom tomorrow",
  "finish SVM homework by Friday",
  "go to yoga at 8pm in Tel Aviv"
]
```

**Stage 2 - Parse Time Expressions:**
```
Task 1 - "call mom tomorrow"
  → { type: 'relative', deadline: '2026-06-08', daysFromNow: 1 }

Task 2 - "finish SVM homework by Friday"
  → { type: 'relative', deadline: '2026-06-12', daysFromNow: 5 }
  
Task 3 - "go to yoga at 8pm in Tel Aviv"
  → { type: 'fixed_time', fixedTime: '20:00' }
```

**Stage 3 - LLM Enrichment (for each task):**
```
Task 1 enriched:
  - category: 'call'
  - priority: 'need_to'
  - contact lookup: "mom"
  
Task 2 enriched:
  - category: 'work' or 'course'
  - priority: 'have_to'
  
Task 3 enriched:
  - category: 'gym'
  - priority: 'have_to'
  - location: "yoga studio in Tel Aviv"
  - transit plan: walking/bus to destination
```

**Final Output - ParsedTask[]:**
```typescript
[
  {
    text: "call mom tomorrow",
    category: 'call',
    priority: 'need_to',
    deadline: '2026-06-08',
    hasDeadline: true,
    fixedTime: undefined,
    location: undefined,
    contactName: 'mom',
    isRecurring: false,
    tags: ['call', 'mom']
  },
  {
    text: "finish SVM homework by Friday",
    category: 'course',
    priority: 'have_to',
    deadline: '2026-06-12',
    hasDeadline: true,
    fixedTime: undefined,
    location: undefined,
    isRecurring: false,
    tags: ['svm', 'homework', 'finish']
  },
  {
    text: "go to yoga at 8pm in Tel Aviv",
    category: 'gym',
    priority: 'have_to',
    deadline: undefined,
    hasDeadline: false,
    fixedTime: '20:00',
    location: 'yoga studio in Tel Aviv',
    isRecurring: false,
    tags: ['yoga', 'go']
  }
]
```

---

## Usage

### For New Code (with enrichment context)

```typescript
import { parseSpeechToTasksWithEnrichment, type AgentContext } from './services/TaskParser';
import { LLMService } from './services/LLMService';

const context: AgentContext = {
  userProfile: userProfile,
  date: getTodayString(),
  language: 'en',
};

const parsedTasks = await parseSpeechToTasksWithEnrichment(
  userTranscript,
  context
);
```

### For Existing Code (no enrichment context)

```typescript
import { parseSpeechToTasks } from './services/TaskParser';

const parsedTasks = await parseSpeechToTasks(userTranscript);
```

---

## Files Modified

| File | Changes |
|------|---------|
| `src/services/TaskParser.ts` | Added `parseSpeechToTasksWithEnrichment()`, kept `parseSpeechToTasks()` for compatibility |
| `src/services/TaskSplitter.ts` | No changes (used by new parser) |
| `src/utils/timeParser.ts` | No changes (used by new parser) |
| `tests/run-integration-parser.ts` | **NEW** - Integration test suite |
| `package.json` | Added `test:integration` script |

---

## Test Results

### Integration Tests (npm run test:integration)
```
✅ single-task-with-time         PASS
✅ multiple-tasks                PASS
✅ task-with-deadline            PASS
✅ task-with-location            PASS
✅ recurring-task                PASS

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Results: 5 passed, 0 failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Existing Tests Still Passing
- ✅ Time parsing tests (15/15 from run-task-splitting.ts)
- ✅ Task splitting tests (2/2 from run-task-splitting.ts)
- ✅ EDD tests (21/21 from run-edd.ts)

---

## API Contract

### parseSpeechToTasksWithEnrichment()

**Parameters:**
- `transcript: string` - Raw user input
- `context: AgentContext` - User profile, date, language

**Returns:** `Promise<ParsedTask[]>`

**ParsedTask interface:**
```typescript
interface ParsedTask {
  text: string;
  category?: TaskCategory;
  priority?: TaskPriority;
  deadline?: string;                    // YYYY-MM-DD
  hasDeadline?: boolean;
  location?: string;
  hasLocation?: boolean;
  contactName?: string;
  contactPhone?: string;
  how?: string;
  why?: string;
  subgroup?: string;
  tags: string[];
  fixedTime?: string;                   // HH:MM
  isRecurring?: boolean;
  recurrenceType?: 'daily' | 'weekly' | 'monthly';
  recurrenceDays?: number;
  recurrenceEndDate?: string;           // YYYY-MM-DD
}
```

---

## Next Steps

### Integration Points
1. **AddTaskModal.tsx** - Use `parseSpeechToTasksWithEnrichment()` for STT input
2. **TaskStorage.ts** - Accept ParsedTask[] from parser and create Task objects
3. **LumiAgent.ts** - Use enriched tasks for schedule building

### Future Enhancements
1. **Batch Processing** - Handle multiple enrichment calls in parallel for performance
2. **Error Recovery** - Add per-task error handling to prevent one failed enrichment from blocking others
3. **Caching** - Cache time expressions and category detections to avoid redundant LLM calls
4. **Learning Integration** - Feed historical task durations into agent for better estimates

---

## Notes

- **API Key Required**: The enrichment path requires `EXPO_PUBLIC_NEBIUS_API_KEY` for LLM calls
- **Fallback Logic**: If LLM unavailable, reverts to regex-based splitting with local time parsing
- **Test Data**: Integration tests use mock profile data (no external API required for testing)
- **Type Safety**: All ParsedTask objects properly typed with TaskCategory and TaskPriority enums

---

## Verification

To verify the implementation:

```bash
# Run integration tests
npm run test:integration

# Type check
npx tsc --noEmit

# Check existing tests still pass
npm run test:splitting
```

All tests passing ✅
