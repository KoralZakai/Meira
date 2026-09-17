'use client';

import type { Task } from './types';

// Deadline-aware work planning. Given a task with a deadline and an estimate of
// total effort (estimatedWorkMinutes), propose how to spread the work across the
// days leading up to the deadline, and measure whether the user is on track.
// This is the lightweight web version of the mobile agent's planning; it's
// purely deterministic so it works without an LLM call.

export interface WorkSession {
  date: string; // YYYY-MM-DD
  minutes: number;
  label: string; // e.g. "Mon Jun 16"
}

export interface WorkPlan {
  sessions: WorkSession[];
  daysAvailable: number;
  perDayMinutes: number;
  latestStartDate: string; // last day you can still start and finish in time
  tight: boolean; // true when there's barely enough time
}

const MAX_SESSION_MINUTES = 120; // don't propose marathon blocks
const MIN_SESSION_MINUTES = 30;

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function label(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function dayDiff(fromKey: string, toKey: string): number {
  const a = new Date(`${fromKey}T00:00:00`);
  const b = new Date(`${toKey}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// Build a plan from `today` up to and including the deadline date.
export function buildWorkPlan(
  estimatedWorkMinutes: number,
  deadlineKey: string,
  todayKey: string,
): WorkPlan | null {
  if (!estimatedWorkMinutes || !deadlineKey) return null;
  const span = dayDiff(todayKey, deadlineKey);
  if (span < 0) return null; // deadline already passed

  // Inclusive of today and the deadline day.
  const daysAvailable = span + 1;
  // How many sessions we need at the max block size, capped by available days.
  const sessionsNeeded = Math.max(1, Math.ceil(estimatedWorkMinutes / MAX_SESSION_MINUTES));
  const sessionCount = Math.min(sessionsNeeded, daysAvailable);
  const perDayMinutes = Math.max(MIN_SESSION_MINUTES, Math.ceil(estimatedWorkMinutes / sessionCount));

  // Spread sessions as evenly as possible across the window (front-loaded).
  const sessions: WorkSession[] = [];
  const stride = daysAvailable / sessionCount;
  let remaining = estimatedWorkMinutes;
  for (let i = 0; i < sessionCount; i++) {
    const offset = Math.floor(i * stride);
    const d = new Date(`${todayKey}T00:00:00`);
    d.setDate(d.getDate() + offset);
    const minutes = Math.min(perDayMinutes, remaining);
    remaining -= minutes;
    sessions.push({ date: dateKey(d), minutes, label: label(d) });
  }
  // Any rounding remainder goes onto the last session.
  if (remaining > 0 && sessions.length) sessions[sessions.length - 1].minutes += remaining;

  // Latest day you can still start: deadline minus (sessions-1) strides.
  const latest = new Date(`${deadlineKey}T00:00:00`);
  latest.setDate(latest.getDate() - (sessionCount - 1));

  return {
    sessions,
    daysAvailable,
    perDayMinutes,
    latestStartDate: dateKey(latest),
    tight: sessionsNeeded > daysAvailable, // not enough days for comfortable blocks
  };
}

export interface ProgressStatus {
  doneMinutes: number;
  totalMinutes: number;
  percent: number;
  expectedPercent: number; // where you "should" be given days elapsed
  onTrack: boolean;
  daysLeft: number;
  message: string;
}

// Progress rate: compare work done vs. where you should be by now.
export function progressStatus(task: Task, todayKey: string): ProgressStatus | null {
  const total = task.estimatedWorkMinutes ?? 0;
  if (!total || !task.deadline) return null;

  const done = task.actualDurationMinutes ?? (task.status === 'complete' ? total : 0);
  const percent = Math.min(100, Math.round((done / total) * 100));

  // Measure pace from when the task was first scheduled (its date) to the deadline.
  const startKey = task.date || todayKey;
  const totalSpan = Math.max(1, dayDiff(startKey, task.deadline));
  const elapsed = Math.max(0, dayDiff(startKey, todayKey));
  const expectedPercent = Math.min(100, Math.round((elapsed / totalSpan) * 100));
  const daysLeft = dayDiff(todayKey, task.deadline);

  const onTrack = percent >= expectedPercent - 10; // 10% grace
  let message: string;
  if (task.status === 'complete') message = 'Done ✓';
  else if (daysLeft < 0) message = '⚠️ Past deadline';
  else if (onTrack) message = daysLeft === 0 ? 'Due today — almost there' : `On track · ${daysLeft}d left`;
  else message = `⚠️ Behind pace · ${daysLeft}d left`;

  return { doneMinutes: done, totalMinutes: total, percent, expectedPercent, onTrack, daysLeft, message };
}
