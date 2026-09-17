/**
 * TaskParser — transcript → ParsedTask[]: server extraction, time-expression
 * handling, and recurring-task expansion.
 *
 * The extraction itself no longer happens on the phone. It used to: this file
 * held a prompt, called Nebius with the API key that ships inside the APK, and
 * then re-derived dates and categories in TypeScript that had drifted from the
 * server's version of the same rules. Now `parseSpeechToTasks` posts the raw
 * sentence to /app/tasks/extract and the server decides — one brain, one set of
 * rules, and no key on the device.
 *
 * What stays here is what the phone can still do with no network: the
 * deterministic `fallbackParse`, the time-range parser, tag extraction and
 * recurring expansion. That fallback is the reason capture keeps working on a
 * plane, so it is NOT dead code and must not be deleted with the rest.
 *
 * Dependencies: compromise (NLP), LumiServer (extraction), utils/timeParser,
 * constants/strings (filler words). Consumed by the add-task voice flow.
 */
import nlp from 'compromise';
import { TaskCategory, TaskPriority } from '../types/models';
import { LUMI_FILLER_WORDS } from '../constants/strings';
import { extractTasks } from './LumiServer';
import { parseTimeExpression, type TimeExpression } from '../utils/timeParser';
import { extractHebrewPlace } from '../utils/hebrewPlace';

const STARTER_TRIGGERS = [
  'i need to',
  'i need',
  'i want to',
  'i must',
  'i have to',
  'i have',
];

const SEPARATOR_TRIGGERS = [
  'and',
  'also',
  'and also',
  'as well as',
  'plus',
  'and then',
];

const EN_TRIGGER_SPLITS = [
  ...STARTER_TRIGGERS,
  ...SEPARATOR_TRIGGERS,
];

const HE_TRIGGER_SPLITS = ['אני צריך ל', 'אני צריכה ל', 'אני רוצה ל'];

const FILLER_WORDS = new Set(LUMI_FILLER_WORDS.map((word) => word.toLowerCase()));

function stemWord(value: string): string {
  const normalized = value.trim().toLowerCase();
  try {
    const doc = nlp(normalized);
    if (!doc || typeof doc.terms !== 'function') {
      return normalized;
    }
    const terms = doc.terms().json({ offset: false }) as Array<{ text: string; normal?: string }>;
    if (terms.length === 0) {
      return normalized;
    }
    return (terms[0].normal ?? terms[0].text ?? normalized).toLowerCase();
  } catch (error) {
    console.warn('[STEMWORD] nlp parsing failed:', error);
    return normalized;
  }
}

function normalizeDetailInput(text: string): string {
  return text
    .replace(/\b(a|p)\.?\s*m\.?\b/gi, (_, meridiem: string) => `${meridiem.toLowerCase()}m`)
    .replace(/\btonight\b/gi, 'today evening')
    .replace(/\bthis evening\b/gi, 'today evening')
    .replace(/\bthis morning\b/gi, 'today morning');
}

function inferMeridiemFromContext(text: string, hour: number, meridiem?: string): 'am' | 'pm' | undefined {
  const normalized = text.toLowerCase();

  if (meridiem === 'am' || meridiem === 'pm') {
    if (meridiem === 'am' && /\b(evening|night|tonight|gym|kickbox|kikbox|kickboxing|class|workout|training)\b/.test(normalized) && hour >= 5 && hour <= 11) {
      return 'pm';
    }
    return meridiem;
  }

  if (/\b(evening|night|tonight)\b/.test(normalized) && hour >= 1 && hour <= 11) {
    return 'pm';
  }

  if (/\b(gym|kickbox|kikbox|kickboxing|class|workout|training|yoga|pilates)\b/.test(normalized) && hour >= 5 && hour <= 10) {
    return 'pm';
  }

  if (/\b(morning)\b/.test(normalized) && hour >= 1 && hour <= 11) {
    return 'am';
  }

  return undefined;
}

function buildDeadlineIso(hour: number, minute: number, dayOffset: number): string {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (dayOffset > 0) {
    next.setDate(next.getDate() + dayOffset);
  }
  return next.toISOString();
}

function extractDeadline(text: string): string | null {
  const normalizedText = normalizeDetailInput(text);
  const twelveHourMatch = normalizedText.match(/\b(?:(today|tomorrow)\s+)?(?:at|on|by|before)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const twentyFourHourMatch = normalizedText.match(/\b(?:(today|tomorrow)\s+)?(?:at|on|by|before)\s*(\d{1,2})(?::(\d{2}))\b/i);
  const looseMatch = normalizedText.match(/\b(?:(today|tomorrow)\s+)?(?:at|on|by|before)?\s*(\d{1,2})(?::(\d{2}))?\b/);
  const match = twelveHourMatch ?? twentyFourHourMatch ?? looseMatch;
  if (!match) {
    return null;
  }

  const [, dayLabel, rawHour, rawMinute, rawMeridiem] = match;
  let hour = Number(rawHour);
  const minute = rawMinute ? Number(rawMinute) : 0;
  const meridiem = inferMeridiemFromContext(normalizedText, hour, rawMeridiem?.toLowerCase());

  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) {
    return null;
  }

  if (meridiem?.toLowerCase() === 'pm' && hour < 12) {
    hour += 12;
  }
  if (meridiem?.toLowerCase() === 'am' && hour === 12) {
    hour = 0;
  }

  return buildDeadlineIso(hour, minute, dayLabel?.toLowerCase() === 'tomorrow' ? 1 : 0);
}

function extractLocation(text: string): string | null {
  const normalizedText = normalizeDetailInput(text);
  // Hebrew first: its "at/in" is a letter glued to the next word, which the
  // English pattern below cannot see at all. "אימון ב8 ביגאל אלון 94" used to
  // return null here, so a task typed in one clear line arrived with no place.
  const hebrew = extractHebrewPlace(normalizedText);
  if (hebrew) return hebrew;
  const match = normalizedText.match(/\b(?:in|at|to|arrive to|go to|head to)\s+([^,.;]+?)(?=\s+\b(?:with|call|text|message|number|phone|via|because|for)\b|$)/i);
  if (!match) {
    return null;
  }
  const location = match[1]
    .trim()
    .replace(/^(the)\s+/i, '')
    .replace(/\s+(today|tomorrow)$/i, '')
    .trim();
  if (!location || /^\d/.test(location)) {
    return null;
  }
  return location;
}

function extractContactName(text: string): string | null {
  const contactPatterns = [
    /\b(?:call|text|message|email|meet)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|mom|dad|family|doctor|coach|trainer|boss|client|friend)\b/i,
    /\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|mom|dad|family|doctor|coach|trainer|boss|client|friend)\b/i,
  ];

  for (const pattern of contactPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function extractContactPhone(text: string): string | null {
  const match = text.match(/(?:\+?\d[\d\s()\-]{6,}\d)/);
  if (!match) {
    return null;
  }
  const cleaned = match[0].replace(/[^\d+\-\s()]/g, '').trim();
  return cleaned || null;
}

function extractHow(text: string): string | null {
  const match = text.match(/\b(?:via|by|on)\s+(WhatsApp|Zoom|phone|email|telegram|bus|car|bike|bicycle|foot|walk)\b/i);
  return match?.[1] ? match[1].trim() : null;
}

function extractWhy(text: string): string | null {
  const match = text.match(/\b(?:because|for)\s+([^,.;]+)$/i);
  return match?.[1] ? match[1].trim() : null;
}

function inferPriority(text: string): TaskPriority {
  const value = text.toLowerCase();
  if (/\b(must|have to|need to)\b/.test(value)) {
    return 'must';
  }
  if (/\b(remind me|maybe|if possible)\b/.test(value)) {
    return 'nice_to_do';
  }
  return 'need_to';
}

/** Keyword tags from raw task text (used for matching + display). */
export function extractTaskTags(input: string): string[] {
  try {
    const doc = nlp(input);
    if (!doc) return [];

    let verbs: string[] = [];
    let nouns: string[] = [];

    if (typeof doc.verbs === 'function') {
      try {
        verbs = doc.verbs().toInfinitive().out('array') as string[];
      } catch (e) {
        console.warn('[EXTRACT_TAGS] verbs extraction failed:', e);
      }
    }

    if (typeof doc.nouns === 'function') {
      try {
        nouns = doc.nouns().toSingular().out('array') as string[];
      } catch (e) {
        console.warn('[EXTRACT_TAGS] nouns extraction failed:', e);
      }
    }

    const tags = [...verbs, ...nouns]
      .map((word) => stemWord(word))
      .map((word) => word.replace(/[^\p{L}\p{N}-]+/gu, ''))
      .filter(Boolean);

    return Array.from(new Set(tags));
  } catch (error) {
    console.warn('[EXTRACT_TAGS] nlp parsing failed:', error);
    return [];
  }
}

/** Intermediate parse result before a Task is created: text, category, timing, location, recurrence. */
export interface ParsedTask {
  text: string;
  category?: TaskCategory;
  priority?: TaskPriority;
  deadline?: string;
  hasDeadline?: boolean;
  location?: string;
  hasLocation?: boolean;
  contactName?: string;
  contactPhone?: string;
  how?: string;
  why?: string;
  subgroup?: string;
  tags: string[];
  fixedTime?: string;  // HH:MM for fixed time tasks
  endTime?: string;    // HH:MM end of a "from X to Y" range
  durationMinutes?: number; // length of a parsed time range
  // NEW: Recurring task fields
  isRecurring?: boolean;
  recurrenceType?: 'daily' | 'weekly' | 'monthly';
  recurrenceDays?: number;
  recurrenceEndDate?: string;
}

// ─── TASK EXTRACTION (server-side) ───

/**
 * Extract tasks from what the user said. The sentence goes to the server; the
 * server's answer is already categorised, dated and timed by deterministic
 * code, so nothing here re-decides any of it.
 *
 * When the server cannot be reached — offline, signed out, no server configured
 * — `fallbackParse` runs on the phone. It is weaker, and it is the difference
 * between capturing a task on a plane and losing it.
 */
export async function parseSpeechToTasks(transcript: string): Promise<ParsedTask[]> {
  const extracted = await extractTasks(transcript);
  if (!extracted) {
    console.log('[PARSER] server unreachable — parsing on the phone');
    return fallbackParse(transcript);
  }
  if (!extracted.length) return fallbackParse(transcript);

  const today = new Date().toISOString().slice(0, 10);
  return extracted.map((task: any) => {
    const category = (task.category || 'general') as TaskCategory;
    // The server returns a single fixed_time; a spoken RANGE ("from 15:00 to
    // 23:00") still has to be read off the text, which is local string work.
    const timeExpr = parseTimeExpression(task.text || '');
    const fixedTime = timeExpr.fixedTime || task.fixed_time || undefined;
    return {
      text: task.text || '',
      category,
      priority: (task.priority || 'need_to') as TaskPriority,
      // `deadline` is how the caller picks the day, so it is set only when the
      // server actually resolved one — otherwise the task belongs to today.
      deadline: task.date && task.date !== today ? task.date : undefined,
      hasDeadline: Boolean(task.fixed_time),
      location: task.location || undefined,
      hasLocation: Boolean(task.location),
      contactName: undefined,
      contactPhone: undefined,
      how: undefined,
      why: undefined,
      subgroup: category === 'general' ? 'General' : undefined,
      tags: extractTaskTags(task.text || ''),
      fixedTime,
      endTime: timeExpr.endTime || undefined,
      durationMinutes: timeExpr.durationMinutes || task.duration_minutes || undefined,
      isRecurring: Boolean(task.is_recurring),
      recurrenceType: task.recurrence_type || undefined,
      recurrenceDays: task.recurrence_days ?? undefined,
      recurrenceEndDate: undefined,
    } as ParsedTask;
  });
}

// Fallback to intelligent client-side parsing when the server is unreachable
function fallbackParse(transcript: string): ParsedTask[] {
  console.log('[FALLBACK_PARSER] Using improved client-side parser');

  // Detect recurring patterns
  const recurringMatch = transcript.match(
    /(?:every\s+day|everday|daily|each\s+day|for\s+(?:the\s+)?next\s+(\d+)\s+days?|for\s+(\d+)\s+days?|(\d+)\s+days?\s+in\s+a\s+row)/i
  );

  let recurrenceDays = 0;
  let isRecurring = false;

  if (recurringMatch) {
    isRecurring = true;
    const match1 = transcript.match(/for\s+(?:the\s+)?next\s+(\d+)\s+days?/i);
    const match2 = transcript.match(/for\s+(\d+)\s+days?(?!\s+in\s+a\s+row)/i);
    const match3 = transcript.match(/(\d+)\s+days?\s+in\s+a\s+row/i);
    if (match1) recurrenceDays = parseInt(match1[1], 10);
    else if (match2) recurrenceDays = parseInt(match2[1], 10);
    else if (match3) recurrenceDays = parseInt(match3[1], 10);
    else if (/daily|every\s+day|everday|each\s+day/.test(transcript)) {
      recurrenceDays = 7; // Default to weekly if not specified
    }
  }

  // First try the shared parser, which also understands ranges like
  // "from 15:00 to 23:00" → start + end + duration.
  const te = parseTimeExpression(transcript);
  let fixedTime: string | undefined = te.fixedTime;
  const endTime = te.endTime;
  const durationMinutes = te.durationMinutes;

  // Detect time expressions (at, by, on) - handles "1:00 pm", "1:00 p.m.", "1 am", etc.
  const timeMatch = transcript.match(/(?:at|by|on)\s+(\d{1,2})\s*(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?/i);

  if (!fixedTime && timeMatch) {
    console.log('[FALLBACK_PARSER] time regex matched:', { groups: timeMatch.slice(0, 4) });
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiemLetter = timeMatch[3] ? timeMatch[3].toLowerCase() : undefined;

    console.log('[FALLBACK_PARSER] parsed time:', { hour, minute, meridiem: meridiemLetter });

    // Handle meridiem (first letter is 'a' or 'p')
    if (meridiemLetter === 'p' && hour < 12) hour += 12;
    if (meridiemLetter === 'a' && hour === 12) hour = 0;

    // If no meridiem specified and hour is 1-9, assume PM for afternoon tasks
    if (!meridiemLetter && hour >= 1 && hour <= 9) {
      hour += 12;
    }

    fixedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    console.log('[FALLBACK_PARSER] final fixedTime:', fixedTime);
  } else {
    console.log('[FALLBACK_PARSER] time regex did not match:', { transcript });
  }

  // Detect date patterns
  let deadline = undefined;
  if (/tomorrow/.test(transcript)) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    deadline = tomorrow.toISOString().split('T')[0];
  } else if (/in\s+(\d+)\s+days?/.test(transcript)) {
    const match = transcript.match(/in\s+(\d+)\s+days?/i);
    if (match) {
      const days = parseInt(match[1], 10);
      const future = new Date();
      future.setDate(future.getDate() + days);
      deadline = future.toISOString().split('T')[0];
    }
  }

  // Detect category from keywords
  const lower = transcript.toLowerCase();
  let category: TaskCategory = 'general';
  // Hebrew was missing entirely, so every Hebrew task fell through to
  // 'general' — including "אימון", which is how a gym session lost its
  // category (and with it, its learned duration and its lead time).
  if (/gym|workout|exercise|fitness|run|cycling/.test(lower) || /אימון|חדר כושר|כושר|ריצה|יוגה|שחייה|פילאטיס/.test(lower)) category = 'gym';
  else if (/call|phone|text|message|ring/.test(lower) || /להתקשר|שיחה|טלפון/.test(lower)) category = 'call';
  else if (/meeting|meet|appointment|zoom/.test(lower)) category = 'meeting';
  else if (/work|office|project|deploy|coding/.test(lower)) category = 'work';
  else if (/study|learn|course|homework/.test(lower)) category = 'course';
  else if (/doctor|medical|health|pharmacy/.test(lower)) category = 'doctor';

  // Detect priority
  let priority: TaskPriority = 'need_to';
  if (/must|have\s+to|need\s+to|urgent|asap|immediately/.test(lower)) priority = 'must';
  else if (/should|important/.test(lower)) priority = 'have_to';
  else if (/could|might|maybe|if\s+possible/.test(lower)) priority = 'nice_to_do';

  console.log('[FALLBACK_PARSER] Detected:', {
    isRecurring,
    recurrenceDays,
    fixedTime,
    deadline,
    category,
    priority,
  });

  return [
    {
      text: transcript,
      category,
      priority,
      deadline,
      hasDeadline: !!deadline,
      location: extractLocation(transcript) || undefined,
      hasLocation: !!extractLocation(transcript),
      contactName: extractContactName(transcript) || undefined,
      tags: extractTaskTags(transcript),
      subgroup: category === 'general' ? 'General' : undefined,
      fixedTime,
      endTime,
      durationMinutes,
      isRecurring,
      recurrenceType: isRecurring ? 'daily' : undefined,
      recurrenceDays: isRecurring ? recurrenceDays : undefined,
    },
  ];
}

// ─── EXPAND RECURRING TASKS ───

/** Expand 'every Sunday'-style tasks into concrete dated instances. */
export function expandRecurringTasks(parsedTasks: ParsedTask[]): ParsedTask[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expanded: ParsedTask[] = [];

  for (const task of parsedTasks) {
    if (!task.isRecurring || !task.recurrenceDays) {
      expanded.push(task);
      continue;
    }

    // Create instance for each day
    for (let day = 0; day < task.recurrenceDays; day++) {
      const taskDate = new Date(today);
      taskDate.setDate(taskDate.getDate() + day);
      const dateStr = taskDate.toISOString().split('T')[0];

      expanded.push({
        ...task,
        text: task.text,
        deadline: dateStr,
        hasDeadline: true,
        isRecurring: false,
        recurrenceDays: undefined,
      });
    }
  }

  return expanded;
}

/** parseSpeechToTasks + recurring expansion in one call. */
export async function parseSpeechToTasksWithExpansion(transcript: string): Promise<ParsedTask[]> {
  const parsed = await parseSpeechToTasks(transcript);
  return expandRecurringTasks(parsed);
}

/** Heuristic category/priority/duration guess for one task text (no LLM). */
export function inferTaskDetails(text: string): {
  category: TaskCategory;
  subgroup: string;
  icon: string;
  priority: 'must' | 'have_to' | 'need_to' | 'nice_to_do';
  durationMinutes: number;
} {
  const t = text.toLowerCase();
  const rules: Array<{ kws: string[]; cat: TaskCategory; icon: string; pri: 'must' | 'have_to' | 'need_to' | 'nice_to_do'; dur: number }> = [
    { kws: ['interview', 'ראיון'], cat: 'interview', icon: '🎯', pri: 'must', dur: 90 },
    { kws: ['doctor', 'רופא', 'תור', 'clinic', 'medical'], cat: 'doctor', icon: '⚕️', pri: 'must', dur: 60 },
    { kws: ['gym', 'workout', 'אימון', 'fitness', 'run', 'ריצה'], cat: 'gym', icon: '💪', pri: 'need_to', dur: 60 },
    { kws: ['zoom', 'זום', 'teams', 'video call'], cat: 'zoom', icon: '💻', pri: 'have_to', dur: 45 },
    { kws: ['meeting', 'פגישה', 'appointment'], cat: 'meeting', icon: '🤝', pri: 'have_to', dur: 45 },
    { kws: ['call', 'שיחה', 'phone', 'להתקשר'], cat: 'call', icon: '📞', pri: 'need_to', dur: 15 },
    { kws: ['course', 'קורס', 'study', 'ללמוד', 'lecture'], cat: 'course', icon: '📚', pri: 'need_to', dur: 60 },
    { kws: ['class', 'שיעור', 'lesson'], cat: 'class', icon: '✏️', pri: 'have_to', dur: 90 },
    { kws: ['conference', 'כנס', 'summit'], cat: 'conference', icon: '🎪', pri: 'have_to', dur: 120 },
    { kws: ['work', 'עבודה', 'office', 'משרד', 'project'], cat: 'work', icon: '💼', pri: 'have_to', dur: 120 },
    { kws: ['חוג', 'hobby', 'workshop'], cat: 'hobby_class', icon: '🎨', pri: 'nice_to_do', dur: 60 },
    { kws: ['leisure', 'movie', 'סרט', 'relax'], cat: 'leisure', icon: '🎮', pri: 'nice_to_do', dur: 60 },
  ];

  for (const r of rules) {
    if (r.kws.some(kw => t.includes(kw))) {
      return { category: r.cat, subgroup: r.cat, icon: r.icon, priority: r.pri, durationMinutes: r.dur };
    }
  }
  return { category: 'general', subgroup: 'General', icon: '📌', priority: 'need_to', durationMinutes: 30 };
}
