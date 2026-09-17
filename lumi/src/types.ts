// Core domain types for Lumi. Kept deliberately small & flat so the mock store
// can be swapped for a real API later without reshaping the UI.

export type Priority = 'high' | 'medium' | 'low';
export type Status = 'todo' | 'in_progress' | 'done';
export type Category = 'work' | 'meeting' | 'focus' | 'personal' | 'health' | 'learning';
export type Bucket = 'today' | 'week' | 'later';
export type KanbanColumn = 'backlog' | 'today' | 'in_progress' | 'done';

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

export interface ActivityEntry {
  id: string;
  at: string; // ISO time
  text: string;
  source: 'user' | 'ai';
}

export interface Task {
  id: string;
  title: string;
  category: Category;
  priority: Priority;
  status: Status;
  bucket: Bucket;
  column: KanbanColumn;
  /** scheduled start, "HH:MM" 24h. undefined = unscheduled (backlog). */
  start?: string;
  durationMinutes: number;
  /** YYYY-MM-DD for the calendar; defaults to today in seed. */
  date: string;
  due?: string; // human label e.g. "Today 23:59"
  location?: string;
  inPerson?: boolean;
  tags: string[];
  notes: string;
  subtasks: Subtask[];
  activity: ActivityEntry[];
  /** display order within a list/column */
  order: number;
}

export interface AISuggestion {
  id: string;
  title: string;
  detail: string;
  start?: string;
  durationMinutes?: number;
}

export interface InboxItem {
  id: string;
  kind: 'suggestion' | 'reminder' | 'insight';
  text: string;
  at: string;
  unread: boolean;
}

export interface UserProfile {
  name: string;
  role: string;
  workStart: string;
  workEnd: string;
  focusBlockMinutes: number;
  ai: {
    autoSchedule: boolean;
    proactiveSuggestions: boolean;
    voice: boolean;
    summaries: boolean;
  };
}

export type ScreenId =
  | 'dashboard'
  | 'chat'
  | 'tasks'
  | 'calendar'
  | 'focus'
  | 'insights'
  | 'settings';
