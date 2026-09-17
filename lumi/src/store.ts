// Single Zustand store = the app's local "backend". All mutations live here so
// swapping mock data for an API is a contained change. AI actions are applied
// through `applyAction`, keeping the chat UI dumb.
import { create } from 'zustand';
import type {
  AISuggestion,
  Bucket,
  InboxItem,
  KanbanColumn,
  Priority,
  Status,
  Task,
  UserProfile,
} from './types';
import {
  TODAY,
  seedInbox,
  seedProfile,
  seedSuggestions,
  seedTasks,
} from './data';
import type { AIAction } from './ai/engine';

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  at: string;
  pending?: boolean;
}

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const now = () =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface LumiState {
  profile: UserProfile;
  onboarded: boolean;
  tasks: Task[];
  suggestions: AISuggestion[];
  inbox: InboxItem[];
  chat: ChatMessage[];
  selectedTaskId: string | null;
  /** id of a task that just changed, so the UI can flash a highlight */
  lastTouchedId: string | null;

  // selection / navigation
  selectTask: (id: string | null) => void;
  completeOnboarding: (patch?: Partial<UserProfile>) => void;

  // task CRUD
  addTask: (partial: Partial<Task> & { title: string }) => string;
  updateTask: (id: string, patch: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  toggleStatus: (id: string) => void;
  toggleSubtask: (taskId: string, subId: string) => void;
  addSubtask: (taskId: string, text: string) => void;
  reorderTasks: (ids: string[]) => void;
  moveColumn: (taskId: string, column: KanbanColumn) => void;
  setStart: (taskId: string, start: string | undefined, date?: string) => void;

  // profile / ai
  updateProfile: (patch: Partial<UserProfile>) => void;
  toggleAIFlag: (key: keyof UserProfile['ai']) => void;
  dismissSuggestion: (id: string) => void;
  acceptSuggestion: (id: string) => void;
  markInboxRead: (id: string) => void;

  // chat / agent
  pushChat: (m: Omit<ChatMessage, 'id' | 'at'>) => string;
  updateChat: (id: string, patch: Partial<ChatMessage>) => void;
  applyAction: (a: AIAction) => void;
}

const statusForColumn = (c: KanbanColumn): Status =>
  c === 'done' ? 'done' : c === 'in_progress' ? 'in_progress' : 'todo';

export const useLumi = create<LumiState>((set, get) => ({
  profile: seedProfile,
  onboarded: false,
  tasks: seedTasks,
  suggestions: seedSuggestions,
  inbox: seedInbox,
  chat: [
    {
      id: uid('m'),
      role: 'ai',
      text: 'Morning, Koral. HW2 is due tonight — want me to optimize your day around it?',
      at: '09:00',
    },
  ],
  selectedTaskId: null,
  lastTouchedId: null,

  selectTask: (id) => set({ selectedTaskId: id }),
  completeOnboarding: (patch) =>
    set((s) => ({ onboarded: true, profile: { ...s.profile, ...patch } })),

  addTask: (partial) => {
    const id = partial.id ?? uid('t');
    const bucket: Bucket = partial.bucket ?? 'today';
    const column: KanbanColumn = partial.column ?? 'today';
    const task: Task = {
      id,
      title: partial.title,
      category: partial.category ?? 'work',
      priority: partial.priority ?? 'medium',
      status: partial.status ?? statusForColumn(column),
      bucket,
      column,
      start: partial.start,
      durationMinutes: partial.durationMinutes ?? 30,
      date: partial.date ?? TODAY,
      due: partial.due,
      location: partial.location,
      inPerson: partial.inPerson,
      tags: partial.tags ?? [],
      notes: partial.notes ?? '',
      subtasks: partial.subtasks ?? [],
      activity: partial.activity ?? [
        { id: uid('a'), at: now(), text: 'Created', source: 'user' },
      ],
      order: get().tasks.length,
    };
    set((s) => ({ tasks: [...s.tasks, task], lastTouchedId: id }));
    return id;
  },

  updateTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      lastTouchedId: id,
    })),

  deleteTask: (id) =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      selectedTaskId: s.selectedTaskId === id ? null : s.selectedTaskId,
    })),

  toggleStatus: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== id) return t;
        const done = t.status === 'done';
        return {
          ...t,
          status: done ? 'todo' : 'done',
          column: done ? 'today' : 'done',
          activity: [
            { id: uid('a'), at: now(), text: done ? 'Reopened' : 'Marked done', source: 'user' },
            ...t.activity,
          ],
        };
      }),
      lastTouchedId: id,
    })),

  toggleSubtask: (taskId, subId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              subtasks: t.subtasks.map((su) =>
                su.id === subId ? { ...su, done: !su.done } : su,
              ),
            }
          : t,
      ),
    })),

  addSubtask: (taskId, text) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, subtasks: [...t.subtasks, { id: uid('s'), text, done: false }] }
          : t,
      ),
      lastTouchedId: taskId,
    })),

  reorderTasks: (ids) =>
    set((s) => {
      const pos = new Map(ids.map((id, i) => [id, i]));
      return {
        tasks: s.tasks
          .map((t) => (pos.has(t.id) ? { ...t, order: pos.get(t.id)! } : t))
          .sort((a, b) => a.order - b.order),
      };
    }),

  moveColumn: (taskId, column) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, column, status: statusForColumn(column) }
          : t,
      ),
      lastTouchedId: taskId,
    })),

  setStart: (taskId, start, date) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, start, ...(date ? { date } : {}) } : t,
      ),
      lastTouchedId: taskId,
    })),

  updateProfile: (patch) => set((s) => ({ profile: { ...s.profile, ...patch } })),
  toggleAIFlag: (key) =>
    set((s) => ({ profile: { ...s.profile, ai: { ...s.profile.ai, [key]: !s.profile.ai[key] } } })),

  dismissSuggestion: (id) =>
    set((s) => ({ suggestions: s.suggestions.filter((x) => x.id !== id) })),

  acceptSuggestion: (id) => {
    const sug = get().suggestions.find((x) => x.id === id);
    if (sug && sug.start) {
      get().addTask({
        title: sug.title,
        category: 'focus',
        priority: 'medium',
        start: sug.start,
        durationMinutes: sug.durationMinutes ?? 60,
        bucket: 'today',
        column: 'today',
        tags: ['ai'],
      });
    }
    set((s) => ({ suggestions: s.suggestions.filter((x) => x.id !== id) }));
  },

  markInboxRead: (id) =>
    set((s) => ({ inbox: s.inbox.map((i) => (i.id === id ? { ...i, unread: false } : i)) })),

  pushChat: (m) => {
    const id = uid('m');
    set((s) => ({ chat: [...s.chat, { ...m, id, at: now() }] }));
    return id;
  },

  updateChat: (id, patch) =>
    set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),

  applyAction: (a) => {
    const s = get();
    switch (a.type) {
      case 'add_task':
        s.addTask(a.task);
        break;
      case 'schedule_task':
        s.setStart(a.taskId, a.start);
        break;
      case 'complete_task':
        s.updateTask(a.taskId, { status: 'done', column: 'done' });
        break;
      case 'set_priority':
        s.updateTask(a.taskId, { priority: a.priority as Priority });
        break;
      case 'add_subtask':
        s.addSubtask(a.taskId, a.text);
        break;
      case 'move_column':
        s.moveColumn(a.taskId, a.column);
        break;
      case 'note':
        // transient — no state change; chat surfaces it
        break;
    }
  },
}));
