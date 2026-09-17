# Two-Stage Task Parsing Proposal

## Problem
Current system tries to parse tasks in one LLM call, extracts all attributes (time, location, contact, priority) at once. Falls back to regex when LLM fails.

Example failure:
```
Input: "call mom finish SVM homework go to yoga at 8pm meet Zach at 6pm"
Current fallback: treats as 1 task or splits on commas
Better: 4 independent tasks
```

## Solution: Stage 1 (Extraction) + Stage 2 (Enrichment)

### Stage 1: Fast Task Extraction

**New function:** `extractTaskBoundaries(transcript: string): string[]`

```typescript
async function extractTaskBoundaries(transcript: string, language: 'en' | 'he'): Promise<string[]> {
  const client = new OpenAI({...});
  
  const response = await client.chat.completions.create({
    model: 'Qwen/Qwen3-235B-A22B',
    messages: [
      {
        role: 'system',
        content: `You are a task boundary detector. Split the user's input into independent tasks.
        
Rules:
- Each task is ONE action (e.g., "call mom", "go to yoga")
- Include time/location WITH the task if mentioned (e.g., "meet Zach at 6pm")
- Return JSON array of strings
- Do NOT extract attributes - just split naturally

Example input: "call mom finish SVM homework go to yoga at 8pm meet Zach at 6pm"
Example output: [
  "call mom",
  "finish SVM homework", 
  "go to yoga at 8pm",
  "meet Zach at 6pm"
]`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ],
    temperature: 0.1,  // very low - deterministic splitting
    max_tokens: 500,
  });
  
  const parsed = JSON.parse(response.choices[0].message.content);
  return parsed; // array of task strings
}

// Fallback: simple regex if LLM fails
function extractTaskBoundariesFallback(transcript: string): string[] {
  return transcript
    .split(/[.,;]|\b(?:also|then|and|i need|i want|i must)\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 2);
}
```

### Stage 2: Task Enrichment with Tools

**Update function:** `parseSpeechToTasks(transcript: string)`

```typescript
export async function parseSpeechToTasks(transcript: string, language: 'en' | 'he'): Promise<ParsedTask[]> {
  // Stage 1: Extract task boundaries
  let taskTexts: string[] = [];
  try {
    taskTexts = await extractTaskBoundaries(transcript, language);
  } catch (e) {
    console.warn('Task extraction failed, using fallback');
    taskTexts = extractTaskBoundariesFallback(transcript);
  }
  
  // Stage 2: Enrich each task individually using the agent
  const enrichedTasks: ParsedTask[] = [];
  
  for (const taskText of taskTexts) {
    const enriched = await enrichSingleTask(taskText, language);
    enrichedTasks.push(enriched);
  }
  
  return enrichedTasks;
}

async function enrichSingleTask(taskText: string, language: 'en' | 'he'): Promise<ParsedTask> {
  // Use runLumiAgent with tools to extract:
  // - category (categorize_task)
  // - location (get_transit_plan)
  // - contact (search_contacts)
  // - time (extractDeadline)
  // - duration (task text keywords)
  // - priority (keywords)
  
  const context: AgentContext = {
    userProfile: {...},
    date: getTodayString(),
    language,
    existingTasks: [],
  };
  
  // Use agent to analyze just this one task with full tool access
  const result = await runLumiAgent(`analyze this task: ${taskText}`, context);
  
  return {
    text: taskText,
    category: extractCategory(taskText),
    priority: extractPriority(taskText),
    location: extractLocation(taskText),
    contactName: extractContactName(taskText),
    // ... etc
  };
}
```

## Benefits

| Aspect | Current | Proposed |
|--------|---------|----------|
| Task splitting | Regex fallback (weak) | Dedicated LLM stage (smart) |
| Attribute extraction | All at once (error-prone) | Per-task with tools (robust) |
| Error handling | Loses data if LLM fails | Falls back gracefully |
| Tool utilization | Tools called after parsing | Tools called per-task during enrichment |
| Multi-language | Implicit | Explicit per stage |
| User experience | "Sorry, couldn't parse" | "Found 4 tasks, here's what I understood..." |

## Implementation Phases

1. **Phase A** (Easy): Add `extractTaskBoundaries()` + fallback, test independently
2. **Phase B** (Medium): Wire it into `parseSpeechToTasks()` as Stage 1
3. **Phase C** (Hard): Update `enrichSingleTask()` to call `runLumiAgent()` for each task with tools
4. **Phase D** (Polish): Add progress UI showing each task being enriched

## Testing

EDD tests would split across stages:
```json
{
  "id": "multi-task-extraction",
  "stage": "extraction",
  "input": "call mom finish SVM go to yoga at 8pm meet Zach at 6pm",
  "expected_tasks": [
    "call mom",
    "finish SVM",
    "go to yoga at 8pm",
    "meet Zach at 6pm"
  ]
}
```

```json
{
  "id": "call-mom-enrichment",
  "stage": "enrichment",
  "input_task": "call mom",
  "expected": {
    "category": "call",
    "priority": "need_to",
    "durationMinutes_approx": 15,
    "hasContact": true
  }
}
```
