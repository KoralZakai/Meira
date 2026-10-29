/**
 * DeviceCalendarSync — every calendar on the phone, not only Google's primary.
 *
 * Android keeps one calendar database that every calendar app syncs into:
 * the Outlook app, Samsung Calendar, an Exchange work account, a shared family
 * calendar, a second Google account. Reading it (expo-calendar, READ_CALENDAR
 * only — Meira never writes here) brings all of them into the day in one move,
 * with no extra sign-in and no server involved: the events stay on the phone,
 * exactly like the Google import.
 *
 * Opt-in. Nothing is read until she turns it on (Menu → Calendars), which is
 * also when Android asks for the permission — a permission prompt with no
 * visible reason is one people refuse.
 *
 * TRIGGERS (CLAUDE.md rule 7): this has none of its own. It runs inside
 * CalendarAutoSync.runCalendarSync, so it inherits all four: app open (heartbeat
 * + AppState at the root), app closed (the WorkManager job), and every "sync
 * now" she can press.
 *
 * DUPLICATES: when Google is connected, the Google account's PRIMARY calendar
 * is skipped here — GoogleSync already reads it by API, with the fields the
 * phone database lacks (conference links, attendees). Everything else still
 * passes `withoutDuplicates`, so an Outlook meeting mirrored into Google lands
 * once.
 *
 * Rule 1: `syncDeviceCalendars` returns WHY it read nothing — "off",
 * "permission denied" and "a free month" are three different results.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { readByGoogleApi, GoogleLink, GoogleSkip } from '../utils/googleCalendarSkip';
import * as Calendar from 'expo-calendar/legacy';

import { GoogleService } from './GoogleService';
import { importCalendarTasks, noteCancellationsFor } from './GoogleSync';
import { datesAhead } from '../utils/cancelledEvents';
import { calendarEventToTask } from '../utils/calendarEventTask';
import { deviceEventToCalendarEvent } from '../utils/deviceEvent';
import { getTodayString, isExpoGo } from '../utils/timeUtils';
import type { AppLanguage, Task } from '../types/index';

const SETTINGS_KEY = 'meira.deviceCalendars.v1';
const LAST_RESULT_KEY = 'meira.deviceCalendars.last.v1';
/** Same horizon as the Google import, so anything imported also gets routed. */
const SYNC_DAYS = 30;

interface DeviceCalendarSettings {
  enabled: boolean;
  /** Calendar ids she switched off. Default is everything on. */
  excluded: string[];
}

export interface DeviceCalendarInfo {
  id: string;
  title: string;
  /** "koral@work.com", "Samsung account", "Phone" — what she recognises. */
  account: string;
  /** Android account type: com.google, com.microsoft.office.outlook, LOCAL … */
  accountType: string;
  color?: string;
  included: boolean;
  /** Skipped because GoogleSync already reads it by API. */
  readByGoogle: boolean;
  /** Skipped, but only because the connected Google account's email is unknown. */
  googleUnsure?: boolean;
}

export type DeviceCalendarFailure =
  | 'off'
  | 'expo_go'
  | 'permission_denied'
  | 'no_calendars'
  | 'all_excluded'
  | `read_failed: ${string}`;

export interface DeviceCalendarResult {
  ok: boolean;
  /** Rows added or corrected on this run. */
  added: number;
  /** Events the phone returned in the window (before de-duplication). */
  events: number;
  calendarsRead: number;
  error?: DeviceCalendarFailure;
  at: number;
}

async function loadSettings(): Promise<DeviceCalendarSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return { enabled: Boolean(s?.enabled), excluded: Array.isArray(s?.excluded) ? s.excluded : [] };
  } catch (e) {
    console.warn('[DeviceCalendar] settings unreadable, treating as off', e);
    return { enabled: false, excluded: [] };
  }
}

async function saveSettings(s: DeviceCalendarSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export async function deviceCalendarsEnabled(): Promise<boolean> {
  return (await loadSettings()).enabled;
}

/** The result of the last run, for the Menu row ("3 calendars · 12 events · 10:42"). */
export async function lastDeviceCalendarResult(): Promise<DeviceCalendarResult | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    console.warn('[DeviceCalendar] last result unreadable');
    return null;
  }
}

function accountOf(c: Calendar.Calendar): { account: string; accountType: string } {
  const src: any = c.source || {};
  return {
    account: String(src.name || c.ownerAccount || 'Phone'),
    accountType: String(src.type || (src.isLocalAccount ? 'LOCAL' : '')),
  };
}

/** Is this the primary calendar of the Google account GoogleSync reads by API?
 *  Only THAT account's — see utils/googleCalendarSkip for the 6.10 bug. */
function googleSkip(c: Calendar.Calendar, link: GoogleLink): GoogleSkip {
  return readByGoogleApi({ ...accountOf(c), isPrimary: Boolean(c.isPrimary) }, link);
}

async function googleLink(): Promise<GoogleLink> {
  try {
    // Only the accounts whose calendar is read by API are skipped here; an
    // account she connected for its mail alone is read through the phone.
    const { emails, unknown } = await GoogleService.googleCalendarEmails();
    return { connected: emails.length > 0 || unknown, emails, unknown };
  } catch (e) {
    console.warn('[DeviceCalendar] Google account unknown:', String((e as Error)?.message || e).slice(0, 120));
    return { connected: false };
  }
}

async function eventCalendars(): Promise<Calendar.Calendar[]> {
  const all = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  // A calendar she hid in her calendar app is one she does not want to see.
  return all.filter((c) => c.isVisible !== false);
}

/** Every calendar on the phone, with whether Meira reads it. Needs the permission. */
export async function listDeviceCalendars(): Promise<{ calendars: DeviceCalendarInfo[]; error?: DeviceCalendarFailure }> {
  if (isExpoGo()) return { calendars: [], error: 'expo_go' };
  try {
    const perm = await Calendar.getCalendarPermissionsAsync();
    if (perm.status !== 'granted') return { calendars: [], error: 'permission_denied' };
    const [settings, link, cals] = await Promise.all([loadSettings(), googleLink(), eventCalendars()]);
    return {
      calendars: cals.map((c) => {
        const skip = googleSkip(c, link);
        const readByGoogle = skip !== 'no';
        return {
          id: c.id,
          title: c.title || c.name || 'Calendar',
          ...accountOf(c),
          color: c.color,
          readByGoogle,
          googleUnsure: skip === 'unsure',
          included: !readByGoogle && !settings.excluded.includes(c.id),
        };
      }),
    };
  } catch (e) {
    const why = String((e as Error)?.message || e).slice(0, 160);
    console.warn('[DeviceCalendar] list failed', why);
    return { calendars: [], error: `read_failed: ${why}` };
  }
}

/**
 * Turn it on: ask Android, and only then remember the choice. A denial is
 * returned as such so the row can say "allow calendar access in Settings",
 * not pretend to be on.
 */
export async function enableDeviceCalendars(): Promise<{ ok: boolean; error?: DeviceCalendarFailure }> {
  if (isExpoGo()) return { ok: false, error: 'expo_go' };
  try {
    const perm = await Calendar.requestCalendarPermissionsAsync();
    if (perm.status !== 'granted') {
      console.warn('[DeviceCalendar] permission not granted:', perm.status, 'canAskAgain', perm.canAskAgain);
      return { ok: false, error: 'permission_denied' };
    }
    const s = await loadSettings();
    await saveSettings({ ...s, enabled: true });
    return { ok: true };
  } catch (e) {
    const why = String((e as Error)?.message || e).slice(0, 160);
    console.warn('[DeviceCalendar] enable failed', why);
    return { ok: false, error: `read_failed: ${why}` };
  }
}

/** Turn it off. Already-imported events stay; they are her day now. */
export async function disableDeviceCalendars(): Promise<void> {
  const s = await loadSettings();
  await saveSettings({ ...s, enabled: false });
}

export async function setDeviceCalendarIncluded(calendarId: string, included: boolean): Promise<void> {
  const s = await loadSettings();
  const excluded = new Set(s.excluded);
  if (included) excluded.delete(calendarId);
  else excluded.add(calendarId);
  await saveSettings({ ...s, excluded: [...excluded] });
}

/**
 * Read the month ahead from every included phone calendar and land it.
 * Never throws; the reason is in the result.
 */
export async function syncDeviceCalendars(lang: AppLanguage, days = SYNC_DAYS): Promise<DeviceCalendarResult> {
  const finish = async (r: Omit<DeviceCalendarResult, 'at'>): Promise<DeviceCalendarResult> => {
    const out = { ...r, at: Date.now() };
    await AsyncStorage.setItem(LAST_RESULT_KEY, JSON.stringify(out)).catch(() => {});
    if (out.error && out.error !== 'off') console.warn('[DeviceCalendar] sync:', out.error);
    return out;
  };
  const settings = await loadSettings();
  if (!settings.enabled) return { ok: false, added: 0, events: 0, calendarsRead: 0, error: 'off', at: Date.now() };
  if (isExpoGo()) return finish({ ok: false, added: 0, events: 0, calendarsRead: 0, error: 'expo_go' });

  try {
    const perm = await Calendar.getCalendarPermissionsAsync();
    // Granted once and revoked later in Android Settings: say so, don't go quiet.
    if (perm.status !== 'granted') {
      return finish({ ok: false, added: 0, events: 0, calendarsRead: 0, error: 'permission_denied' });
    }
    const link = await googleLink();
    const cals = await eventCalendars();
    if (!cals.length) return finish({ ok: false, added: 0, events: 0, calendarsRead: 0, error: 'no_calendars' });
    const chosen = cals.filter((c) => googleSkip(c, link) === 'no' && !settings.excluded.includes(c.id));
    if (!chosen.length) return finish({ ok: false, added: 0, events: 0, calendarsRead: 0, error: 'all_excluded' });
    const byId = new Map(chosen.map((c) => [c.id, c]));

    const today = getTodayString();
    const [y, m, d] = today.split('-').map(Number);
    const from = new Date(y, m - 1, d, 0, 0, 0, 0);
    const to = new Date(y, m - 1, d + days, 23, 59, 59, 999);
    const raw = await Calendar.getEventsAsync(chosen.map((c) => c.id), from, to);

    const tasks: Task[] = [];
    for (const ev of raw) {
      const mapped = deviceEventToCalendarEvent(ev as any);
      if (!mapped) continue;
      const cal = byId.get(String((ev as any).calendarId));
      tasks.push(calendarEventToTask(mapped.event, mapped.date, 'device', {
        recurring: Boolean((ev as any).recurrenceRule),
        calendarName: cal ? `${cal.title}` : undefined,
      }));
    }
    // The read SUCCEEDED for every chosen calendar: what it no longer lists was cancelled (strictly —
    // two syncs, and a card that asks). Before the early return: a month with nothing left is news.
    await noteCancellationsFor('dcal-', datesAhead(today, days), new Set(tasks.map((t) => t.id)),
      chosen.map((c) => c.id).sort().join('|'), tasks);
    const added = tasks.length ? await importCalendarTasks(tasks, lang, 'device') : 0;
    console.warn(`[DeviceCalendar] read ${chosen.length} calendar(s), ${raw.length} event(s) → ${added} added/corrected`);
    return finish({ ok: true, added, events: raw.length, calendarsRead: chosen.length });
  } catch (e) {
    const why = String((e as Error)?.message || e).slice(0, 160);
    return finish({ ok: false, added: 0, events: 0, calendarsRead: 0, error: `read_failed: ${why}` });
  }
}
