'use client';

import { supabase } from './supabaseClient';
import type { Task } from './types';

// Task CRUD against the shared `tasks` table. RLS scopes everything to the
// signed-in user; we still pass userId explicitly because it's part of the row
// (and the composite primary key with id).

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function fetchTasks(userId: string): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id,text,category,priority,isFixed,fixedTime,durationMinutes,date,status,scheduledTime,createdAt,completedAt,deadline,deadlineTime,estimatedWorkMinutes,actualDurationMinutes,latestStartBy',
    )
    .eq('userId', userId)
    .order('date', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Task[];
}

export interface NewTaskInput {
  text: string;
  date: string;
  priority?: Task['priority'];
  category?: string | null;
  durationMinutes?: number;
  fixedTime?: string | null;
  scheduledTime?: string | null;
  deadline?: string | null;
  deadlineTime?: string | null;
  estimatedWorkMinutes?: number | null;
}

export async function createTask(userId: string, input: NewTaskInput): Promise<Task> {
  const row = {
    id: randomId(),
    userId,
    text: input.text,
    date: input.date,
    priority: input.priority ?? 'need_to',
    category: input.category ?? 'general',
    durationMinutes: input.durationMinutes ?? 30,
    isFixed: Boolean(input.fixedTime),
    fixedTime: input.fixedTime ?? null,
    scheduledTime: input.scheduledTime ?? null,
    deadline: input.deadline ?? null,
    deadlineTime: input.deadlineTime ?? null,
    estimatedWorkMinutes: input.estimatedWorkMinutes ?? null,
    status: 'pending' as const,
    createdAt: Date.now(),
    historicalDurations: [],
  };
  const { data, error } = await supabase
    .from('tasks')
    .insert(row)
    .select(
      'id,text,category,priority,isFixed,fixedTime,durationMinutes,date,status,scheduledTime,createdAt,completedAt,deadline,deadlineTime,estimatedWorkMinutes,actualDurationMinutes,latestStartBy',
    )
    .single();
  if (error) throw error;
  return data as Task;
}

export async function updateTask(
  userId: string,
  id: string,
  patch: Partial<Task>,
): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('userId', userId)
    .eq('id', id);
  if (error) throw error;
}

export async function toggleComplete(
  userId: string,
  task: Task,
): Promise<void> {
  const complete = task.status !== 'complete';
  await updateTask(userId, task.id, {
    status: complete ? 'complete' : 'pending',
    completedAt: complete ? Date.now() : null,
  });
}

export async function deleteTask(userId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('userId', userId)
    .eq('id', id);
  if (error) throw error;
}
