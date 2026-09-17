/**
 * LumiAgentService — the check-in screen's verdict on a spoken command: an
 * AgentIntent (add task, check in, update a task, update the profile) plus the
 * fields to apply.
 *
 * The classification itself now happens on the server (POST /app/checkin/parse)
 * — this was the last agent still calling a model from the phone. The category,
 * priority and duration on each returned task come from the server's keyword
 * table, which is the same table the WhatsApp channel uses, so one sentence
 * finally gets one label wherever it is said.
 *
 * What stays here is the shape work: normalising the server's JSON into the
 * types the screens render, and `stripFillerWords`, which is pure string work
 * reused by LumiOnboardingAgent.
 *
 * Dependencies: constants/strings (filler words), LumiServer (the call),
 * types/models. Consumed by the voice command flow in the main screens.
 */
import { LUMI_FILLER_WORDS } from '../constants/strings';
import { AgentIntent, TaskCategory, TaskPriority } from '../types/models';
import { parseCheckIn } from './LumiServer';

type AgentMode = 'capture' | 'review';

/** A field-level change the agent wants applied to an existing task. */
export interface AgentTaskUpdate {
  targetText: string;
  newText?: string;
  newLocation?: string;
  newDeadline?: string;
}

/** A new task the agent extracted from the user's command. */
export interface AgentTask {
  text: string;
  priority: TaskPriority;
  category: TaskCategory;
  subgroup: string | null;
  hasLocation: boolean;
  location: string | null;
  hasDeadline: boolean;
  deadline: string | null;
  how: string | null;
  why: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

/** Full agent verdict: intent + new tasks + updates + reply text. */
export interface LumiAgentResponse {
  intent: AgentIntent;
  tasks: AgentTask[];
  taskUpdates: AgentTaskUpdate[];
  matchedTaskTexts: string[];
  conflicts: unknown[];
  suggestions: unknown[];
  permissionsNeeded: string[];
  lumiMessage: string;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Remove EN/HE filler words before parsing; reused by LumiOnboardingAgent. */
export function stripFillerWords(input: string): string {
  let working = input;

  for (const token of LUMI_FILLER_WORDS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const rgx = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'gi');
    working = working.replace(rgx, ' ');
  }

  return normalizeSpaces(working);
}

function normalizePriority(value: unknown): TaskPriority {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'must' || raw === 'have_to' || raw === 'need_to' || raw === 'nice_to_do') {
    return raw as TaskPriority;
  }
  if (raw === 'want') return 'need_to';
  if (raw === 'nice') return 'nice_to_do';
  return 'need_to';
}

// Canonical categories must match TaskCategory in src/types/index.ts.
const ALLOWED_CATEGORIES: TaskCategory[] = [
  'interview', 'course', 'conference', 'class', 'work', 'meeting', 'call',
  'doctor', 'gym', 'aspiration', 'leisure', 'general', 'zoom', 'hobby_class',
];

// Map legacy/loose labels an older model may still emit onto canonical categories.
const LEGACY_CATEGORY_MAP: Record<string, TaskCategory> = {
  health: 'gym',
  fitness: 'gym',
  home: 'general',
  social: 'call',
  errand: 'general',
  learning: 'course',
  study: 'course',
  other: 'general',
};

function normalizeCategory(value: unknown): TaskCategory {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (ALLOWED_CATEGORIES.includes(raw as TaskCategory)) {
    return raw as TaskCategory;
  }
  if (raw in LEGACY_CATEGORY_MAP) {
    return LEGACY_CATEGORY_MAP[raw];
  }
  return 'general';
}

function normalizeIntent(value: unknown): AgentIntent {
  const raw = typeof value === 'string' ? value : '';
  const allowed: AgentIntent[] = ['add_tasks', 'check_in', 'task_update', 'conflict', 'optimize', 'wake_up', 'profile_update', 'empty_list', 'classify_group'];
  if (allowed.includes(raw as AgentIntent)) {
    return raw as AgentIntent;
  }
  return 'add_tasks';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => normalizeSpaces(entry)).filter(Boolean);
}

function normalizeTask(entry: unknown): AgentTask | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const data = entry as Record<string, unknown>;
  const text = typeof data.text === 'string' ? normalizeSpaces(data.text) : '';
  if (!text) {
    return null;
  }

  const subgroup = typeof data.subgroup === 'string' ? normalizeSpaces(data.subgroup) : null;
  const location = typeof data.location === 'string' ? normalizeSpaces(data.location) : null;
  const deadline = typeof data.deadline === 'string' ? normalizeSpaces(data.deadline) : null;

  const how = typeof data.how === 'string' ? normalizeSpaces(data.how) : null;
  const why = typeof data.why === 'string' ? normalizeSpaces(data.why) : null;
  const contactName = typeof data.contact_name === 'string'
    ? normalizeSpaces(data.contact_name)
    : typeof data.contactName === 'string'
      ? normalizeSpaces(data.contactName)
      : null;
  const rawPhone = typeof data.contact_phone === 'string'
    ? data.contact_phone
    : typeof data.contactPhone === 'string'
      ? data.contactPhone
      : null;
  const contactPhone = rawPhone ? rawPhone.replace(/[^\d+\-\s()]/g, '').trim() || null : null;

  return {
    text,
    priority: normalizePriority(data.priority),
    category: normalizeCategory(data.category),
    subgroup,
    hasLocation: Boolean(data.hasLocation ?? location),
    location,
    hasDeadline: Boolean(data.hasDeadline ?? deadline),
    deadline,
    how,
    why,
    contactName,
    contactPhone,
  };
}

function normalizeTaskUpdate(entry: unknown): AgentTaskUpdate | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const data = entry as Record<string, unknown>;
  const targetText = typeof data.target_text === 'string'
    ? normalizeSpaces(data.target_text)
    : typeof data.targetText === 'string'
      ? normalizeSpaces(data.targetText)
      : '';

  if (!targetText) {
    return null;
  }

  const newText = typeof data.new_text === 'string'
    ? normalizeSpaces(data.new_text)
    : typeof data.newText === 'string'
      ? normalizeSpaces(data.newText)
      : undefined;

  const newLocation = typeof data.new_location === 'string'
    ? normalizeSpaces(data.new_location)
    : typeof data.newLocation === 'string'
      ? normalizeSpaces(data.newLocation)
      : undefined;

  const newDeadline = typeof data.new_deadline === 'string'
    ? normalizeSpaces(data.new_deadline)
    : typeof data.newDeadline === 'string'
      ? normalizeSpaces(data.newDeadline)
      : undefined;

  return {
    targetText,
    ...(newText ? { newText } : {}),
    ...(newLocation ? { newLocation } : {}),
    ...(newDeadline ? { newDeadline } : {}),
  };
}

/** Classifies a voice/text command into an AgentIntent and extracts tasks/updates, server-side. */
export class LumiAgentService {
  async parseTranscript(input: string, mode: AgentMode, pendingTaskTexts: string[] = []): Promise<LumiAgentResponse | null> {
    const parsed = await parseCheckIn(stripFillerWords(input), mode, pendingTaskTexts);
    if (!parsed) {
      console.log('[LUMI_AGENT] no server verdict — the screen parses locally');
      return null;
    }

    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(normalizeTask).filter((entry): entry is AgentTask => Boolean(entry))
      : [];
    const taskUpdates = Array.isArray(parsed.task_updates)
      ? parsed.task_updates
        .map(normalizeTaskUpdate)
        .filter((entry): entry is AgentTaskUpdate => Boolean(entry))
      : [];

    const result: LumiAgentResponse = {
      intent: normalizeIntent(parsed.intent),
      tasks,
      taskUpdates,
      matchedTaskTexts: toStringArray(parsed.matched_task_texts),
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      permissionsNeeded: toStringArray(parsed.permissions_needed),
      lumiMessage: typeof parsed.lumi_message === 'string' ? normalizeSpaces(parsed.lumi_message) : '',
    };

    console.log('[LUMI_AGENT] parsed response:', result);
    return result;
  }
}

/** Shared singleton — screens import this, not the class. */
export const lumiAgentService = new LumiAgentService();
