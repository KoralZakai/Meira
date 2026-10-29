/**
 * geofencePick — which open tasks get a geofence, and when entering one may knock.
 *
 * Koral's pick (28.10, option B of the security table): "you're near the post
 * office — do 'send the parcel' now?", also with the app closed. Android
 * watches the fences (GeofenceService); this file is the pure part:
 *
 * - Only an errand can be done "now because you're here": an OPEN task with a
 *   real place and NO fixed hour. A 16:00 appointment is not a reason to stop
 *   at 10:00 because she walks past it; online tasks have no place to be near.
 * - Android caps an app at 100 fences; we keep the soonest MAX_FENCES.
 * - A knock is never at night, and the same task knocks at most once per
 *   COOLDOWN — walking past the pharmacy twice a day is not two reminders.
 *
 * Nothing here sends a coordinate anywhere: the fences live on the phone.
 */
import { hasRealCoords } from './placeCoords';
import { isRemoteTask } from './meetingLink';
import type { Task } from '../types/index';

export const MAX_FENCES = 90;
export const FENCE_RADIUS_M = 200;
export const LOOKAHEAD_DAYS = 7;
export const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** No knock between 22:00 and 07:00. */
export const QUIET_FROM = 22 * 60;
export const QUIET_TO = 7 * 60;

export interface Fence {
  identifier: string;   // task id, or `pr:<id>` for a place reminder
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
}

/** "When I get to work, remind me X" / "when I leave home…" (server place_reminder). One-shot. */
export interface PlaceReminder {
  id: string;
  text: string;
  trigger: 'arrive' | 'leave';
  label: string;
  lat: number;
  lng: number;
  createdAt: number;
}

export const REMINDER_PREFIX = 'pr:';
/** Leaving home is a wide circle: the front door is not where GPS puts her. */
export const REMINDER_RADIUS_M = 150;

/** Her own reminders come first — she asked for each one; errands are Meira's offer. */
export function reminderFences(reminders: PlaceReminder[]): Fence[] {
  return reminders
    .filter((r) => hasRealCoords(r.lat, r.lng) && r.text)
    .map((r) => ({
      identifier: `${REMINDER_PREFIX}${r.id}`, latitude: r.lat, longitude: r.lng, radius: REMINDER_RADIUS_M,
      notifyOnEnter: r.trigger === 'arrive', notifyOnExit: r.trigger === 'leave',
    }));
}

/** The whole set Android watches: reminders, then errands, within the cap. */
export function allFences(reminders: PlaceReminder[], tasks: Task[], today: string, max = MAX_FENCES): Fence[] {
  const mine = reminderFences(reminders).slice(0, max);
  return [...mine, ...pickFences(tasks, today, max - mine.length)];
}

/** 'הגעת הביתה' / 'הגעת לעבודה' / 'יצאת מהבית' — 'ל' + 'הבית' is not Hebrew (server place_reminder.he_when). */
export function heWhen(trigger: 'arrive' | 'leave', label: string, future: boolean): string {
  const bare = label.startsWith('ה') && label.length > 2 ? label.slice(1) : label;
  if (trigger === 'arrive') {
    const verb = future ? 'כשתגיעי' : 'הגעת';
    return bare === 'בית' ? `${verb} הביתה` : `${verb} ל${bare}`;
  }
  return `${future ? 'כשתצאי' : 'יצאת'} מ${label}`;
}

export function reminderText(r: PlaceReminder, he: boolean): { title: string; body: string } {
  return he
    ? { title: `${r.trigger === 'arrive' ? '📍' : '🚪'} ${heWhen(r.trigger, r.label, false)}`, body: `תזכורת: ${r.text}` }
    : { title: r.trigger === 'arrive' ? `📍 You're at ${r.label}` : `🚪 You left ${r.label}`, body: `Reminder: ${r.text}` };
}

export function asPlaceReminder(x: any, now = Date.now()): PlaceReminder | null {
  if (!x || typeof x.id !== 'string' || typeof x.text !== 'string') return null;
  if (x.trigger !== 'arrive' && x.trigger !== 'leave') return null;
  const lat = Number(x.lat); const lng = Number(x.lng);
  if (!hasRealCoords(lat, lng)) return null;
  return {
    id: x.id.slice(0, 40), text: x.text.slice(0, 200), trigger: x.trigger,
    label: String(x.label || '').slice(0, 60), lat, lng, createdAt: now,
  };
}

/** The task's own place, when it has a real one. */
export function placeOf(task: Task): { lat: number; lng: number; name: string } | null {
  const loc: any = task.location && typeof task.location === 'object' ? task.location : null;
  if (loc && hasRealCoords(loc.lat, loc.lng)) {
    return { lat: loc.lat, lng: loc.lng, name: String(loc.displayName || loc.address || '').trim() };
  }
  if (hasRealCoords(task.locationLat, task.locationLng)) {
    return {
      lat: task.locationLat as number, lng: task.locationLng as number,
      name: typeof task.location === 'string' ? task.location.trim() : '',
    };
  }
  return null;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** An errand she could do on the spot. */
export function isFenceable(task: Task, today: string): boolean {
  if (task.status !== 'pending') return false;
  if (task.isFixed || task.fixedTime) return false;
  if (isRemoteTask(task as any)) return false;
  if (!placeOf(task)) return false;
  // Overdue errands still count; far-future ones do not take a fence from this week's.
  return !task.date || task.date <= addDays(today, LOOKAHEAD_DAYS);
}

export function pickFences(tasks: Task[], today: string, max = MAX_FENCES): Fence[] {
  return tasks
    .filter((t) => isFenceable(t, today))
    .sort((a, b) => (a.date || today).localeCompare(b.date || today) || a.id.localeCompare(b.id))
    .slice(0, max)
    .map((t) => {
      const p = placeOf(t)!;
      return {
        identifier: t.id, latitude: p.lat, longitude: p.lng,
        radius: FENCE_RADIUS_M, notifyOnEnter: true, notifyOnExit: false,
      };
    });
}

export type NudgeVerdict = 'ok' | 'gone' | 'not_errand' | 'night' | 'cooldown';

/** May entering this task's fence knock now? Re-checked at the moment of entry, never trusted from registration. */
export function nudgeVerdict(task: Task | undefined, lastNudgeAt: number | undefined, now: Date, today: string): NudgeVerdict {
  if (!task) return 'gone';
  if (!isFenceable(task, today)) return 'not_errand';
  const m = now.getHours() * 60 + now.getMinutes();
  if (m >= QUIET_FROM || m < QUIET_TO) return 'night';
  if (lastNudgeAt && now.getTime() - lastNudgeAt < NUDGE_COOLDOWN_MS) return 'cooldown';
  return 'ok';
}

export function nudgeText(task: Task, he: boolean): { title: string; body: string } {
  const name = placeOf(task)?.name;
  return he
    ? { title: name ? `📍 את ליד ${name}` : '📍 את ליד מקום של משימה', body: `אולי עכשיו: ${task.text}?` }
    : { title: name ? `📍 You're near ${name}` : "📍 You're near a task's place", body: `Do it now: ${task.text}?` };
}
