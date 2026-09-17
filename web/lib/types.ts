// Minimal Task shape the web task-manager works with. A focused subset of the
// mobile model (src/types/index.ts) — same DB columns, same string values.
// (Will be replaced by the shared `packages/shared` types when we move to a
// monorepo.)

export type TaskPriority = 'must' | 'have_to' | 'need_to' | 'nice_to_do';
export type TaskStatus = 'pending' | 'complete' | 'missed' | 'moved' | 'partial';

export interface Task {
  id: string;
  text: string;
  category?: string | null;
  priority?: TaskPriority | null;
  isFixed?: boolean;
  fixedTime?: string | null; // HH:MM
  durationMinutes?: number;
  date: string; // YYYY-MM-DD
  status: TaskStatus;
  scheduledTime?: string | null; // HH:MM
  createdAt: number;
  completedAt?: number | null;
  // Deadline-aware planning fields (shared with the mobile model).
  deadline?: string | null; // YYYY-MM-DD
  deadlineTime?: string | null; // HH:MM
  estimatedWorkMinutes?: number | null;
  actualDurationMinutes?: number | null;
  latestStartBy?: string | null;
}

export const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  must: { label: 'Must do', color: '#EF476F' },
  have_to: { label: 'Have to', color: '#FF9F1C' },
  need_to: { label: 'Need to', color: '#118AB2' },
  nice_to_do: { label: 'Nice to do', color: '#06D6A0' },
};

export const PRIORITY_ORDER: TaskPriority[] = ['must', 'have_to', 'need_to', 'nice_to_do'];

export const CATEGORY_META: Record<string, { icon: string; label: string; color: string }> = {
  interview: { icon: '🎯', label: 'Interview', color: '#9B5DE5' },
  course: { icon: '📚', label: 'Course', color: '#4361EE' },
  conference: { icon: '🎪', label: 'Conference', color: '#F77F00' },
  class: { icon: '✏️', label: 'Class', color: '#FFD166' },
  work: { icon: '💼', label: 'Work', color: '#023E8A' },
  meeting: { icon: '🤝', label: 'Meeting', color: '#118AB2' },
  call: { icon: '📞', label: 'Call', color: '#06D6A0' },
  doctor: { icon: '⚕️', label: 'Doctor', color: '#EF476F' },
  gym: { icon: '💪', label: 'Gym', color: '#FF9F1C' },
  aspiration: { icon: '⭐', label: 'Aspiration', color: '#FFD166' },
  leisure: { icon: '🎮', label: 'Leisure', color: '#FF85A1' },
  general: { icon: '📌', label: 'General', color: '#8A8A9A' },
  zoom: { icon: '💻', label: 'Zoom', color: '#2D8CFF' },
  hobby_class: { icon: '🎨', label: 'Hobby', color: '#06D6A0' },
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_META);

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
