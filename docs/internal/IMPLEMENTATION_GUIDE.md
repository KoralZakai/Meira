# Two-Stage Task Parser - Implementation Guide

## Quick Start

The new two-stage task parsing pipeline is now integrated and ready to use:

```typescript
import { parseSpeechToTasksWithEnrichment } from './src/services/TaskParser';
import type { AgentContext } from './src/services/LLMService';

// With enrichment context (recommended for production)
const context: AgentContext = {
  userProfile: yourUserProfile,
  date: '2026-06-07',
  language: 'en',
};

const tasks = await parseSpeechToTasksWithEnrichment(
  "call mom tomorrow and yoga at 8pm",
  context
);

// Without context (backward compatible)
const tasks = await parseSpeechToTasks("call mom tomorrow");
```

## What It Does

### Input Processing
- **Stage 1**: Splits user input into individual task strings
- **Stage 2**: Extracts time/date information from each task
- **Stage 3**: Enriches tasks with categorization, priority, location, contacts, transit

### Output
Array of `ParsedTask` objects with:
- Category (work, gym, meeting, call, etc.)
- Priority (must, have_to, need_to, nice_to_do)
- Time info (fixed time HH:MM or deadline YYYY-MM-DD)
- Location with optional transit plans
- Contact information
- Recurring task details

## Files & Locations

### Core Implementation
- **[TaskParser.ts](src/services/TaskParser.ts)** - Main entry point
  - `parseSpeechToTasksWithEnrichment()` - NEW two-stage parser with enrichment
  - `parseSpeechToTasks()` - Legacy parser (backward compatible)

### Pipeline Components (No Changes Required)
- **[TaskSplitter.ts](src/services/TaskSplitter.ts)** - Stage 1 (task extraction)
- **[timeParser.ts](src/utils/timeParser.ts)** - Stage 2 (time expression parsing)
- **[LLMService.ts](src/services/LLMService.ts)** - Stage 3 (agent enrichment)

### Tests
- **[run-integration-parser.ts](tests/run-integration-parser.ts)** - NEW integration tests
- `npm run test:integration` - Run tests

## Integration Points

### For Immediate Use

1. **AddTaskModal** - STT input processing
   ```typescript
   const parsedTasks = await parseSpeechToTasksWithEnrichment(
     transcript,
     context
   );
   ```

2. **TaskStorage** - Accept enriched tasks
   ```typescript
   for (const parsed of parsedTasks) {
     const task = createTaskFromParsed(parsed);
     await saveTask(task);
   }
   ```

### Data Flow
```
User Speech
  ↓
STT (expo-speech-recognition)
  ↓
parseSpeechToTasksWithEnrichment()
  ├─ extractTaskBoundaries()         [Stage 1]
  ├─ parseTimeExpression()           [Stage 2]
  └─ runLumiAgent()                  [Stage 3]
  ↓
ParsedTask[]
  ↓
TaskStorage.saveTasks()
  ↓
Database
```

## Example Scenarios

### Scenario 1: Simple Task
**Input:** "call mom at 10am"

**Output:**
```json
{
  "text": "call mom at 10am",
  "category": "call",
  "priority": "need_to",
  "fixedTime": "10:00",
  "contactName": "mom",
  "tags": ["call", "mom"]
}
```

### Scenario 2: Complex Multi-Task
**Input:** "interview in Binyamina on 10/6 at 10am, also finish SVM by Friday"

**Output:**
```json
[
  {
    "text": "interview in Binyamina on 10/6 at 10am",
    "category": "interview",
    "priority": "must",
    "deadline": "2026-10-06",
    "fixedTime": "10:00",
    "location": "Binyamina",
    "hasLocation": true
  },
  {
    "text": "finish SVM by Friday",
    "category": "course",
    "priority": "have_to",
    "deadline": "2026-06-12",
    "hasDeadline": true
  }
]
```

### Scenario 3: Recurring Task
**Input:** "exercise every day for the next week"

**Output:**
```json
{
  "text": "exercise every day for the next week",
  "category": "gym",
  "priority": "have_to",
  "isRecurring": true,
  "recurrenceType": "daily",
  "recurrenceDays": 7,
  "recurrenceEndDate": "2026-06-14"
}
```

## Error Handling

The parser gracefully degrades:

```
LLM API Available
  ↓ [Success] → Full enrichment
  ↓ [Timeout/Error] → Fallback to regex-based splitting
     + Pure time parsing (still works)
     + Basic categorization from keywords
```

## Performance Notes

- **Per-task LLM calls**: One call per extracted task for enrichment
- **Typical latency**: 2-5 seconds for 3-4 tasks (with network)
- **Fallback speed**: <100ms (no API calls)
- **Recommendation**: Show loading UI with "Lumi is thinking..." message

## Testing

```bash
# Run integration tests (validates entire pipeline)
npm run test:integration

# Run component tests
npm run test:splitting          # Task splitting + time parsing
npm run test:edd                # Full EDD test suite

# Type checking
npx tsc --noEmit
```

## API Requirements

- **EXPO_PUBLIC_NEBIUS_API_KEY** - Required for LLM enrichment
- Fallback: Works without key using regex-based splitting

## Troubleshooting

### Tasks not being split
- Check: Is API key set?
- If not: System uses fallback regex splitting (still works)
- Splitting uses punctuation + keywords: "and", "also", commas

### Time not detected
- Check: Is time expression explicit? ("at 10am", "by Friday", "tomorrow")
- Parser uses pattern matching, not fuzzy detection
- Can extend patterns in `timeParser.ts`

### Wrong category detected
- Check: Task text contains category keywords
- Categories: gym, call, meeting, work, course, doctor, etc.
- Add keywords to `executeToolCall` in `LLMService.ts`

## Next Steps

1. ✅ Core implementation complete
2. ✅ Tests passing (5/5 integration, 13/13 splitting)
3. 🔄 **Next**: Wire into AddTaskModal
4. 🔄 **Then**: Test with real user speech
5. 🔄 **Finally**: Integrate with TaskStorage + schedule building
