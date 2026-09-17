// Scripted AI "agent". It is NOT a real model — it pattern-matches the user's
// prompt to a canned reply + a list of declarative actions that the store knows
// how to apply (with animation/delays driven by the chat screen).
//
// To plug in a real model later: implement the same AIEngine interface (return
// { reply, actions }) by calling your API, and swap `scriptedEngine` for it in
// the store. The UI never needs to change.
import type { Priority, Task } from '../types';

export type AIAction =
  | { type: 'add_task'; task: Partial<Task> & { title: string } }
  | { type: 'schedule_task'; taskId: string; start: string }
  | { type: 'complete_task'; taskId: string }
  | { type: 'set_priority'; taskId: string; priority: Priority }
  | { type: 'add_subtask'; taskId: string; text: string }
  | { type: 'move_column'; taskId: string; column: Task['column'] }
  | { type: 'note'; text: string };

export interface AIResult {
  reply: string;
  actions: AIAction[];
}

export interface AIEngine {
  respond(prompt: string, ctx: { tasks: Task[] }): Promise<AIResult>;
}

interface ScriptStep {
  match: RegExp;
  reply: string;
  build?: (ctx: { tasks: Task[] }) => AIAction[];
}

const findHW2 = (tasks: Task[]) => tasks.find((t) => t.id === 't_hw2');

const SCRIPT: ScriptStep[] = [
  {
    match: /plan|organi[sz]e|optimi[sz]e|my day|schedule my/i,
    reply:
      'Done — I reordered your day around the 23:59 HW2 deadline and protected a focus block this afternoon. 🟢',
    build: () => [
      { type: 'note', text: 'Optimizing schedule…' },
      {
        type: 'add_task',
        task: {
          title: 'Deep focus — HW2 buffer',
          category: 'focus',
          priority: 'high',
          start: '16:15',
          durationMinutes: 90,
          bucket: 'today',
          column: 'today',
          tags: ['ai', 'focus'],
        },
      },
      { type: 'move_column', taskId: 't_hw2', column: 'in_progress' },
    ],
  },
  {
    match: /focus|deep work|block|concentrat/i,
    reply: 'Reserved a 90-minute focus block at 16:15 and muted notifications for it. 🎯',
    build: () => [
      {
        type: 'add_task',
        task: {
          title: 'Focus block',
          category: 'focus',
          priority: 'medium',
          start: '16:15',
          durationMinutes: 90,
          bucket: 'today',
          column: 'today',
          tags: ['ai', 'focus'],
        },
      },
    ],
  },
  {
    match: /hw2|homework|assignment|submit|deadline/i,
    reply:
      'HW2 is your only high-priority item and it’s due 23:59. I broke it into steps and moved it In Progress.',
    build: (ctx) => {
      const hw = findHW2(ctx.tasks);
      const actions: AIAction[] = [{ type: 'move_column', taskId: 't_hw2', column: 'in_progress' }];
      if (hw && hw.subtasks.length < 5)
        actions.push({ type: 'add_subtask', taskId: 't_hw2', text: 'Double-check submission format' });
      return actions;
    },
  },
  {
    match: /add|create|new task|remind me to|need to/i,
    reply: 'Added it to today and slotted it into your first free gap. ✅',
    build: () => [
      {
        type: 'add_task',
        task: {
          title: 'New task from chat',
          category: 'work',
          priority: 'medium',
          start: '17:45',
          durationMinutes: 30,
          bucket: 'today',
          column: 'today',
          tags: ['ai'],
        },
      },
    ],
  },
  {
    match: /gym|workout|exercise|train/i,
    reply: 'Booked a strength session and kept it clear of your evening workshop. 💪',
    build: () => [
      {
        type: 'add_task',
        task: {
          title: 'Strength session',
          category: 'health',
          priority: 'low',
          start: '18:15',
          durationMinutes: 45,
          bucket: 'today',
          column: 'today',
          tags: ['ai', 'gym'],
        },
      },
    ],
  },
  {
    match: /done|complete|finished|triage/i,
    reply: 'Nice — marked it complete and updated your progress. 🎉',
    build: (ctx) => {
      const firstOpen = ctx.tasks.find((t) => t.status !== 'done');
      return firstOpen ? [{ type: 'complete_task', taskId: firstOpen.id }] : [];
    },
  },
];

const FALLBACK: AIResult = {
  reply:
    'I can plan your day, protect focus time, break down HW2, or add tasks — try “optimize my day”.',
  actions: [],
};

export const scriptedEngine: AIEngine = {
  async respond(prompt, ctx) {
    const step = SCRIPT.find((s) => s.match.test(prompt));
    if (!step) return FALLBACK;
    return { reply: step.reply, actions: step.build ? step.build(ctx) : [] };
  },
};

// Suggested prompts shown as chips in the chat composer.
export const SUGGESTED_PROMPTS = [
  'Optimize my day',
  'Protect a focus block this afternoon',
  'Break down HW2',
  'Add: prep slides for workshop',
];
