/**
 * MorningRoutineService — pure functions that learn the user's real morning
 * routine + per-destination travel times from history, and compute wake-alert
 * plans (wake / get-ready / leave).
 *
 * Dependencies: models/UserProfile (LearnedTravelProfile), constants/strings.
 * No I/O — callers persist the returned profile. Consumed by
 * NearbyTaskReminderService, WakeCalculator, notification scheduling.
 */
import { WAKE_REMINDER_STRINGS } from '../constants/strings';
import { LearnedTravelProfile, UserProfile } from '../models/UserProfile';
import { Task } from '../types/models';
import { locationTextOf } from '../utils/dayPlanning';

const BASE_PREP_MINUTES = 30;
const MIN_TASK_DURATION_MINUTES = 5;
const MAX_TASK_DURATION_MINUTES = 180;
const WAKE_ALERT_WINDOW_MS = 10 * 60 * 1000;
const WAKE_ALERT_COOLDOWN_MS = 90 * 60 * 1000;
const DEFAULT_PREP_BUFFER_MINUTES = 5;
const ARRIVAL_GRACE_MINUTES = 5;

const TRANSPORT_MINUTES: Record<UserProfile['transportMode'], number> = {
  car: 20,
  foot: 35,
  bicycle: 25,
  transit: 45,
};

const SPEED_METERS_PER_MINUTE: Record<UserProfile['transportMode'], number> = {
  foot: 80,
  bicycle: 250,
  car: 500,
  transit: 220,
};

export type WakeAlertPlan = {
  taskId: string;
  title: string;
  body: string;
  reminderAt: number;
  leaveAt: number;
  arrivalAt: number;
};

function clampMinutes(value: number): number {
  return Math.max(MIN_TASK_DURATION_MINUTES, Math.min(MAX_TASK_DURATION_MINUTES, Math.round(value)));
}

function normalizeTimeLabel(dateMs: number): string {
  return new Date(dateMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function distanceMeters(
  left: { lat: number; lng: number },
  right: { lat: number; lng: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;

  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(left.lat)) * Math.cos(toRadians(right.lat))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Stable key ('destination|mode') for the learned travel-time map. */
export function normalizeTravelKey(task: Task): string {
  // location is a string on typed tasks and a TaskLocation on routed ones.
  const place = locationTextOf(task).trim();
  if (place) {
    return `location:${place.toLowerCase()}`;
  }
  if (task.subgroup?.trim()) {
    return `subgroup:${task.subgroup.trim().toLowerCase()}`;
  }
  return `task:${task.text.trim().toLowerCase()}`;
}

function getTravelLabel(task: Task): string {
  return locationTextOf(task).trim() || task.subgroup?.trim() || task.text.trim();
}

function parseDueDate(value?: string): Date | null {
  if (!value) {
    return null;
  }

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const hhmm = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!hhmm) {
    return null;
  }

  const now = new Date();
  const hour = Number(hhmm[1]);
  const minute = Number(hhmm[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < now.getTime() - 60 * 1000) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate;
}

/** Routine minutes from the profile's learned samples, else the configured default. */
export function calculateMorningRoutineMinutes(profile: UserProfile): number {
  const habitsTotal = profile.morningHabits
    .map((habit) => Math.max(0, Math.round(habit.estimatedMinutes)))
    .reduce((sum, value) => sum + value, 0);

  return Math.max(
    BASE_PREP_MINUTES,
    profile.totalMorningRoutineMinutes,
    BASE_PREP_MINUTES + habitsTotal,
  );
}

function estimatePreparationMinutes(task: Task, profile: UserProfile, arrivalAt: number): number {
  const arrivalHour = new Date(arrivalAt).getHours();
  if (!task.hasLocation && !task.location) {
    return calculateMorningRoutineMinutes(profile);
  }
  if (arrivalHour < 11) {
    return Math.max(DEFAULT_PREP_BUFFER_MINUTES, Math.min(15, Math.round(calculateMorningRoutineMinutes(profile) * 0.25)));
  }
  return DEFAULT_PREP_BUFFER_MINUTES;
}

function inferHabitKey(taskText: string, habits: UserProfile['morningHabits']): string | null {
  const normalizedText = taskText.toLowerCase();
  for (const habit of habits) {
    const key = habit.habit.trim().toLowerCase();
    if (!key) {
      continue;
    }
    if (normalizedText.includes(key)) {
      return key;
    }
  }
  return null;
}

/** Fold completed morning tasks into the routine estimate; returns an updated profile (pure). */
export function learnMorningRoutineFromTasks(profile: UserProfile, tasks: Task[]): UserProfile {
  const buckets = new Map<string, number[]>();

  for (const task of tasks) {
    if (task.status !== 'complete' || !task.completedAt) {
      continue;
    }

    const completedAt = new Date(task.completedAt);
    const hour = completedAt.getHours();
    if (hour >= 12) {
      continue;
    }

    const durationMs = task.completedAt - task.createdAt;
    const durationMinutes = Math.round(durationMs / 60000);
    if (durationMinutes < MIN_TASK_DURATION_MINUTES || durationMinutes > MAX_TASK_DURATION_MINUTES) {
      continue;
    }

    const key = inferHabitKey(task.text, profile.morningHabits);
    if (!key) {
      continue;
    }

    const values = buckets.get(key) ?? [];
    values.push(durationMinutes);
    buckets.set(key, values);
  }

  if (!buckets.size) {
    return profile;
  }

  let changed = false;
  const nextHabits = profile.morningHabits.map((habit) => {
    const key = habit.habit.trim().toLowerCase();
    const samples = buckets.get(key);
    if (!samples || !samples.length) {
      return habit;
    }

    const sampleAverage = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const blended = clampMinutes((habit.estimatedMinutes * 0.7) + (sampleAverage * 0.3));

    if (blended !== habit.estimatedMinutes) {
      changed = true;
      return {
        ...habit,
        estimatedMinutes: blended,
      };
    }

    return habit;
  });

  if (!changed) {
    return profile;
  }

  return {
    ...profile,
    morningHabits: nextHabits,
    totalMorningRoutineMinutes: calculateMorningRoutineMinutes({
      ...profile,
      morningHabits: nextHabits,
    }),
    lastUpdated: new Date().toISOString(),
  };
}

/** Best travel estimate for a task: learned per-destination time, else category default. */
export function estimateTravelMinutes(task: Task, profile: UserProfile): number {
  const transportBase = TRANSPORT_MINUTES[profile.transportMode] ?? 25;
  const learned = profile.learnedTravelProfiles?.find((entry) => entry.key === normalizeTravelKey(task));
  if (learned?.averageMinutes) {
    return clampMinutes(learned.averageMinutes + (learned.lateCount > learned.onTimeCount ? 5 : 0));
  }

  if (profile.homeLatLng && task.locationLat && task.locationLng) {
    const meters = distanceMeters(profile.homeLatLng, {
      lat: task.locationLat,
      lng: task.locationLng,
    });
    const speed = SPEED_METERS_PER_MINUTE[profile.transportMode] ?? 220;
    const rawMinutes = meters / speed;
    const buffer = profile.transportMode === 'bicycle' ? 5 : profile.transportMode === 'foot' ? 3 : 7;
    return clampMinutes(rawMinutes + buffer);
  }

  if (task.hasLocation || task.location) {
    return transportBase;
  }
  return Math.max(10, Math.round(transportBase * 0.5));
}

/** Record an actual door-to-door travel duration for this destination+mode (pure; caller persists). */
export function learnTravelProfileFromTask(
  profile: UserProfile,
  task: Task,
  actualTravelMinutes: number,
  arrivedOnTime: boolean,
): UserProfile {
  const key = normalizeTravelKey(task);
  const label = getTravelLabel(task);
  const current = profile.learnedTravelProfiles ?? [];
  const existing = current.find((entry) => entry.key === key);

  let nextProfiles: LearnedTravelProfile[];

  if (existing) {
    const nextSamples = existing.samples + 1;
    const nextAverage = ((existing.averageMinutes * existing.samples) + actualTravelMinutes) / nextSamples;
    nextProfiles = current.map((entry) => entry.key === key
      ? {
        ...entry,
        label,
        averageMinutes: clampMinutes(nextAverage),
        samples: nextSamples,
        onTimeCount: entry.onTimeCount + (arrivedOnTime ? 1 : 0),
        lateCount: entry.lateCount + (arrivedOnTime ? 0 : 1),
      }
      : entry);
  } else {
    nextProfiles = [
      ...current,
      {
        key,
        label,
        averageMinutes: clampMinutes(actualTravelMinutes),
        samples: 1,
        onTimeCount: arrivedOnTime ? 1 : 0,
        lateCount: arrivedOnTime ? 0 : 1,
      },
    ];
  }

  return {
    ...profile,
    learnedTravelProfiles: nextProfiles,
    effortPoints: (profile.effortPoints ?? 0) + (arrivedOnTime ? 5 : 0),
    lastUpdated: new Date().toISOString(),
  };
}

/** Compute the wake / get-ready / leave plan for the next located fixed task from 'now'. */
export function getWakeAlertPlanNow(
  profile: UserProfile,
  tasks: Task[],
  nowMs: number = Date.now(),
): WakeAlertPlan | null {
  const candidates = tasks
    .filter((task) => task.status === 'pending' && task.dueDate)
    .map((task) => {
      const due = parseDueDate(task.dueDate);
      if (!due) {
        return null;
      }

      const arrivalAt = due.getTime();
      if (arrivalAt <= nowMs) {
        return null;
      }

      const travelMinutes = estimateTravelMinutes(task, profile);
      const prepMinutes = estimatePreparationMinutes(task, profile, arrivalAt);
      const leaveAt = arrivalAt - (travelMinutes * 60000);
      const reminderAt = leaveAt - (prepMinutes * 60000);

      return {
        task,
        arrivalAt,
        leaveAt,
        reminderAt,
        travelMinutes,
        prepMinutes,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => a.arrivalAt - b.arrivalAt);

  const next = candidates[0];
  if (!next) {
    return null;
  }

  if (next.task.lastWakeReminderAt && nowMs - next.task.lastWakeReminderAt < WAKE_ALERT_COOLDOWN_MS) {
    return null;
  }

  if (nowMs < next.reminderAt || nowMs > next.arrivalAt) {
    return null;
  }

  const isLeaveNowWindow = nowMs >= next.leaveAt;
  const inPrepWindow = nowMs <= next.reminderAt + WAKE_ALERT_WINDOW_MS;

  if (!isLeaveNowWindow && !inPrepWindow) {
    return null;
  }

  const arrivalLabel = normalizeTimeLabel(next.arrivalAt);
  const leaveLabel = normalizeTimeLabel(next.leaveAt);

  return {
    taskId: next.task.id,
    title: WAKE_REMINDER_STRINGS.title,
    body: isLeaveNowWindow
      ? WAKE_REMINDER_STRINGS.leaveNowBody(next.task.text, arrivalLabel)
      : WAKE_REMINDER_STRINGS.prepBody(next.task.text, arrivalLabel, leaveLabel, next.prepMinutes),
    reminderAt: next.reminderAt,
    leaveAt: next.leaveAt,
    arrivalAt: next.arrivalAt,
  };
}

/** Did an arrival timestamp beat the task's due date? Feeds gamification + travel learning. */
export function arrivedOnTime(arrivalAtMs: number, dueDate?: string): boolean {
  const due = parseDueDate(dueDate);
  if (!due) {
    return true;
  }
  return arrivalAtMs <= due.getTime() + (ARRIVAL_GRACE_MINUTES * 60000);
}
