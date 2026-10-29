/**
 * GeofenceService — "you're near the post office: do it now?", also with the app closed.
 *
 * Koral's pick (28.10): option B of the security options table — Android
 * geofences per open errand. The phone keeps the fences and wakes us on entry;
 * no coordinate leaves the device, nothing is logged but counts and reasons.
 *
 * Which tasks and when to knock: utils/geofencePick (pure, tested).
 *
 * Triggers (rule 7):
 *  - fences are re-registered on EVERY calendar-sync path (launch, foreground,
 *    heartbeat, pull-to-refresh, the closed-app WorkManager job) — Android
 *    drops them on reboot and when the permission changes, so "set once" is not enough;
 *  - entering a fence runs GEOFENCE_TASK, defined at module scope so a headless
 *    launch finds it (same reason as CalendarAutoSync's task);
 *  - she turns it on by a tap in Profile › Alerts, after the disclosure — the
 *    permission is never requested from the background.
 *
 * Rule 1: every outcome carries its reason — "no permission" and "nothing to
 * watch" are different answers, and the last one is stored for the screen.
 */
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { getAllTasks, getSettings } from './TaskStorage';
import { sendInstantNotification } from './NotificationService';
import { getTodayString, isExpoGo } from '../utils/timeUtils';
import {
  PlaceReminder, REMINDER_PREFIX, allFences, asPlaceReminder, nudgeText, nudgeVerdict, reminderText,
} from '../utils/geofencePick';

type LocationModule = typeof import('expo-location');
let Location: LocationModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Location = require('expo-location') as LocationModule;
} catch (e) {
  console.warn('[Geofence] expo-location unavailable', e);
}

export const GEOFENCE_TASK = 'meira-nearby-geofence';
const LAST_NUDGE_KEY = 'geofence.lastNudge.v1';   // { [taskId]: epoch ms } — ids only, no places
const STATUS_KEY = 'geofence.status.v1';
/** Her place reminders ("when I get to work…") — one-shot, on this phone only. */
const REMINDERS_KEY = 'geofence.placeReminders.v1';
/** Her choice. Sync never turns it on by itself — only her tap does. */
const ENABLED_KEY = 'geofence.enabled.v1';
/** The registered set (ids + places, hashed) — re-register only when it changed or Android dropped it. */
const SET_KEY = 'geofence.set.v1';

export type GeofenceReason =
  | 'ok' | 'off' | 'none_to_watch' | 'no_module' | 'expo_go'
  | 'no_foreground_permission' | 'no_background_permission' | 'permission_request_failed' | 'register_failed';

export interface GeofenceStatus {
  ok: boolean;
  /** How many places Android is watching now. */
  count: number;
  reason: GeofenceReason;
  detail?: string;
  at: number;
}

/** Stop watching and forget the registered set (expo-task-manager keeps the regions on disk while running). */
async function stopFences(): Promise<void> {
  try {
    if (Location && (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK))) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch (e) {
    console.warn('[Geofence] stop failed', e);
  }
  await AsyncStorage.removeItem(SET_KEY).catch(() => undefined);
}

async function saveStatus(s: GeofenceStatus): Promise<GeofenceStatus> {
  await AsyncStorage.setItem(STATUS_KEY, JSON.stringify(s)).catch((e) => console.warn('[Geofence] status not saved', e));
  return s;
}

/** The last real outcome — what the Profile card prints. null = it never ran. */
export async function geofenceStatus(): Promise<GeofenceStatus | null> {
  try {
    const raw = await AsyncStorage.getItem(STATUS_KEY);
    return raw ? (JSON.parse(raw) as GeofenceStatus) : null;
  } catch (e) {
    console.warn('[Geofence] status unreadable', e);
    return null;
  }
}

/**
 * Register a fence per open errand (or clear them when there is none). Never
 * prompts — a background caller cannot show a dialog. Safe on every sync.
 */
export async function syncGeofences(): Promise<GeofenceStatus> {
  const now = Date.now();
  if (isExpoGo()) return { ok: false, count: 0, reason: 'expo_go', at: now };
  if (!Location) return saveStatus({ ok: false, count: 0, reason: 'no_module', at: now });
  if ((await AsyncStorage.getItem(ENABLED_KEY).catch(() => null)) !== '1') {
    return { ok: false, count: 0, reason: 'off', at: now };
  }
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    const bg = fg.granted ? await Location.getBackgroundPermissionsAsync() : null;
    if (!fg.granted || !bg?.granted) {
      // Permission taken away in Settings: drop the fences and their stored places too.
      await stopFences();
      return saveStatus({ ok: false, count: 0, reason: fg.granted ? 'no_background_permission' : 'no_foreground_permission', at: now });
    }

    const fences = allFences(await placeReminders(), await getAllTasks(), getTodayString());
    const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    if (!fences.length) {
      if (running) await Location.stopGeofencingAsync(GEOFENCE_TASK);
      await AsyncStorage.removeItem(SET_KEY).catch(() => undefined);
      return saveStatus({ ok: true, count: 0, reason: 'none_to_watch', at: now });
    }
    // Same set and Android still holds it → nothing to do (re-registering can re-fire an entry).
    // A reboot or a permission change drops the fences, which `running` catches.
    const sig = fences.map((f) => `${f.identifier}@${f.latitude.toFixed(5)},${f.longitude.toFixed(5)}${f.notifyOnExit ? 'x' : 'e'}`).join('|');
    const sigHash = String(sig.split('').reduce((h, c) => ((h * 31) + c.charCodeAt(0)) | 0, 7));
    if (running && (await AsyncStorage.getItem(SET_KEY).catch(() => null)) === sigHash) {
      return saveStatus({ ok: true, count: fences.length, reason: 'ok', at: now });
    }
    // Starting again replaces the whole set — done/deleted errands fall out.
    await Location.startGeofencingAsync(GEOFENCE_TASK, fences);
    await AsyncStorage.setItem(SET_KEY, sigHash).catch((e) => console.warn('[Geofence] set not saved', e));
    return saveStatus({ ok: true, count: fences.length, reason: 'ok', at: now });
  } catch (e) {
    const detail = String((e as Error)?.message || e).slice(0, 160);
    console.warn('[Geofence] register failed', detail);
    return saveStatus({ ok: false, count: 0, reason: 'register_failed', detail, at: now });
  }
}

/**
 * Her tap, after the disclosure: ask for location, then "Allow all the time"
 * (Android sends her to Settings for that one), then register.
 */
export async function enableNearbyNudges(): Promise<GeofenceStatus> {
  const now = Date.now();
  if (isExpoGo()) return { ok: false, count: 0, reason: 'expo_go', at: now };
  if (!Location) return saveStatus({ ok: false, count: 0, reason: 'no_module', at: now });
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) return saveStatus({ ok: false, count: 0, reason: 'no_foreground_permission', at: now });
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (!bg.granted) return saveStatus({ ok: false, count: 0, reason: 'no_background_permission', at: now });
    await AsyncStorage.setItem(ENABLED_KEY, '1');
  } catch (e) {
    console.warn('[Geofence] permission request failed', e);
    return saveStatus({ ok: false, count: 0, reason: 'permission_request_failed', detail: String(e).slice(0, 160), at: now });
  }
  return syncGeofences();
}

/** Her "turn it off": stop watching. The permission itself is hers to revoke in Settings. */
export async function disableNearbyNudges(): Promise<GeofenceStatus> {
  const now = Date.now();
  await AsyncStorage.setItem(ENABLED_KEY, '0').catch((e) => console.warn('[Geofence] off not saved', e));
  await stopFences();
  return saveStatus({ ok: false, count: 0, reason: 'off', at: now });
}

export async function placeReminders(): Promise<PlaceReminder[]> {
  try {
    const raw = await AsyncStorage.getItem(REMINDERS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => asPlaceReminder(r, r?.createdAt)) : [];
  } catch (e) {
    console.warn('[Geofence] place reminders unreadable', e);
    return [];
  }
}

async function saveReminders(list: PlaceReminder[]): Promise<void> {
  await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(list));
}

/**
 * Keep the place reminders the chat returned and watch their places at once.
 * Returns the fence status, so the chat can say when they cannot fire yet
 * (location alerts off / no "all the time" permission) — rule 3.
 */
export async function addPlaceReminders(raw: unknown[]): Promise<GeofenceStatus> {
  const fresh = raw.map((r) => asPlaceReminder(r)).filter((r): r is PlaceReminder => !!r);
  if (fresh.length) {
    const kept = (await placeReminders()).filter((r) => !fresh.some((f) => f.id === r.id));
    await saveReminders([...kept, ...fresh].slice(-40));
  }
  return syncGeofences();
}

export async function removePlaceReminder(id: string): Promise<void> {
  await saveReminders((await placeReminders()).filter((r) => r.id !== id));
  await syncGeofences();
}

/** Arrived at / left a reminder's place: say it once, then it is done. */
async function onReminder(id: string, exited: boolean): Promise<void> {
  const list = await placeReminders();
  const r = list.find((x) => x.id === id);
  if (!r || (r.trigger === 'leave') !== exited) return;
  const settings = await getSettings().catch(() => null);
  const { title, body } = reminderText(r, settings?.language === 'he');
  await sendInstantNotification(title, body, { type: 'place-reminder' });
  await saveReminders(list.filter((x) => x.id !== id));
  await syncGeofences().catch((e) => console.warn('[Geofence] resync after reminder failed', e));
}

async function onEnter(taskId: string): Promise<void> {
  const raw = await AsyncStorage.getItem(LAST_NUDGE_KEY).catch(() => null);
  let last: Record<string, number> = {};
  try {
    last = raw ? JSON.parse(raw) : {};
  } catch (e) {
    // A corrupt map must not silence every entry forever — start the cooldowns over.
    console.warn('[Geofence] cooldown map unreadable, reset', e);
  }
  const task = (await getAllTasks()).find((t) => t.id === taskId);
  const now = new Date();
  // Re-checked at the moment of entry: it may have been done, moved or deleted since the fence was set.
  const verdict = nudgeVerdict(task, last[taskId], now, getTodayString());
  if (verdict !== 'ok') {
    console.warn(`[Geofence] entry not announced: ${verdict}`);
    return;
  }
  const settings = await getSettings().catch(() => null);
  const { title, body } = nudgeText(task!, settings?.language === 'he');
  await sendInstantNotification(title, body, { taskId, type: 'nearby-task', screen: 'TaskDetail' });
  last[taskId] = now.getTime();
  // Keep the map small: only the last week's knocks.
  for (const [id, ts] of Object.entries(last)) if (now.getTime() - ts > 7 * 86400_000) delete last[id];
  await AsyncStorage.setItem(LAST_NUDGE_KEY, JSON.stringify(last)).catch((e) => console.warn('[Geofence] cooldown not saved', e));
}

if (!isExpoGo()) {
  try {
    if (!TaskManager.isTaskDefined(GEOFENCE_TASK)) {
      TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }: any) => {
        if (error) {
          console.warn('[Geofence] event error', error?.message ?? error);
          return;
        }
        const enter = Location?.GeofencingEventType?.Enter;
        const exit = Location?.GeofencingEventType?.Exit;
        const id = data?.region?.identifier ? String(data.region.identifier) : '';
        if (!id || (data?.eventType !== enter && data?.eventType !== exit)) return;
        if (id.startsWith(REMINDER_PREFIX)) {
          await onReminder(id.slice(REMINDER_PREFIX.length), data.eventType === exit)
            .catch((e) => console.warn('[Geofence] place reminder failed', e));
          return;
        }
        if (data.eventType !== enter) return;
        await onEnter(id).catch((e) => console.warn('[Geofence] entry failed', e));
      });
    }
  } catch (e) {
    console.warn('[Geofence] could not define task', e);
  }
}
