/**
 * nearbyDue — which pending tasks is she near enough to do now? Pure (no GPS,
 * no notifications) so a mocked position can be tested — 29.10: "a task close
 * to the interview place — does Meira remind?" (tests/run-nearby-reminder.ts).
 * NearbyTaskReminderService reads the position and sends the nudge.
 */
import type { Task } from '../types/models';

export const NEARBY_RADIUS_METERS = 350;
export const MIN_REMINDER_INTERVAL_MS = 90 * 60 * 1000;

export function distanceMeters(left: { lat: number; lng: number }, right: { lat: number; lng: number }): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(left.lat)) * Math.cos(toRadians(right.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** The pending tasks within NEARBY_RADIUS_METERS, not nudged in the last 90 minutes. */
export function nearbyDue(
  tasks: Task[],
  here: { lat: number; lng: number },
  now: number,
): Array<{ task: Task; meters: number }> {
  const out: Array<{ task: Task; meters: number }> = [];
  for (const task of tasks) {
    if (task.status !== 'pending' || !task.locationLat || !task.locationLng) continue;
    if (task.lastNearbyReminderAt && now - task.lastNearbyReminderAt < MIN_REMINDER_INTERVAL_MS) continue;
    const meters = distanceMeters(here, { lat: task.locationLat, lng: task.locationLng });
    if (meters <= NEARBY_RADIUS_METERS) out.push({ task, meters });
  }
  return out;
}

/** The nudge's words, in the task's language. */
export function nearbyMessage(task: Task): { title: string; body: string } {
  const he = /[\u0590-\u05FF]/.test(`${task.text} ${task.location ?? ''}`);
  const where = typeof task.location === 'string' ? task.location : (task.location as any)?.displayName || (task.location as any)?.address;
  return he
    ? { title: '📍 משימה קרובה', body: `את ליד ${where || 'המקום של משימה'} — אפשר לסגור עכשיו: ${task.text}` }
    : { title: '📍 Nearby task', body: `You're close to ${where || 'a task location'} — you can do it now: ${task.text}` };
}

