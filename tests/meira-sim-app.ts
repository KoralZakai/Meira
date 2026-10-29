/**
 * meira-sim-app — the real app, run in Node, with only its edges replaced.
 *
 * Everything between the edges is the shipped code: GoogleService parses the
 * calendar response, GoogleSync imports it, TaskStorage stores it,
 * NotificationService plans and schedules every alert, AlarmService sets the
 * clock alarm. What is replaced is exactly what a phone provides and a laptop
 * does not:
 *
 *   AsyncStorage / SecureStore   in-memory maps
 *   expo-notifications           an in-memory OS scheduler you can read back
 *   expo-intent-launcher         records the system-alarm intents it is sent
 *   Supabase                     not configured (the app's offline path)
 *   fetch                        Google Calendar answers from the fixture;
 *                                every other host is offline
 *   react-native / other expo-*  inert shells
 *
 * The calendar edge is the raw Google API item — `start.dateTime` carries the
 * fixture's UTC instant verbatim — so the local clock on every task comes out
 * of the app's own conversion (utils/calendarTime), not out of this file.
 *
 * Import this module BEFORE anything under src/: it patches the module loader
 * at load time, and a service loaded earlier would keep the real dependencies.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import {
  FixtureLocation, FixtureMeeting, FixtureUser, RouteSource,
} from './meira-sim-fixture';

// The phone lives in Israel; so does every clock in the fixture. Set before
// any Date is built so the whole run uses the zone database for Jerusalem.
process.env.TZ = 'Asia/Jerusalem';

// ── storage ─────────────────────────────────────────────────────────────────
const asyncStore = new Map<string, string>();
export const memoryAsyncStorage = {
  getItem: async (k: string) => (asyncStore.has(k) ? asyncStore.get(k)! : null),
  setItem: async (k: string, v: string) => { asyncStore.set(k, v); },
  removeItem: async (k: string) => { asyncStore.delete(k); },
  mergeItem: async (k: string, v: string) => {
    const prev = asyncStore.has(k) ? JSON.parse(asyncStore.get(k)!) : {};
    asyncStore.set(k, JSON.stringify({ ...prev, ...JSON.parse(v) }));
  },
  getAllKeys: async () => [...asyncStore.keys()],
  multiGet: async (keys: string[]) => keys.map((k) => [k, asyncStore.get(k) ?? null]),
  multiSet: async (pairs: [string, string][]) => { pairs.forEach(([k, v]) => asyncStore.set(k, v)); },
  multiRemove: async (keys: string[]) => { keys.forEach((k) => asyncStore.delete(k)); },
  clear: async () => { asyncStore.clear(); },
};

const secureStore = new Map<string, string>();
const SecureStore = {
  getItemAsync: async (k: string) => (secureStore.has(k) ? secureStore.get(k)! : null),
  setItemAsync: async (k: string, v: string) => { secureStore.set(k, v); },
  deleteItemAsync: async (k: string) => { secureStore.delete(k); },
  isAvailableAsync: async () => true,
};

// ── the OS notification scheduler ───────────────────────────────────────────
export interface ScheduledNotification {
  identifier: string;
  content: { title?: string; body?: string; data?: Record<string, any> };
  trigger: { type?: string; date?: Date | number; seconds?: number; channelId?: string };
}
const scheduled = new Map<string, ScheduledNotification>();
let notificationSeq = 0;
const Notifications = {
  SchedulableTriggerInputTypes: {
    DATE: 'date', DAILY: 'daily', WEEKLY: 'weekly', TIME_INTERVAL: 'timeInterval', CALENDAR: 'calendar',
  },
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
  AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 0, SECRET: -1 },
  AndroidAudioUsage: { ALARM: 4 },
  AndroidAudioContentType: { SONIFICATION: 4 },
  scheduleNotificationAsync: async (req: { content: any; trigger: any }) => {
    notificationSeq += 1;
    const identifier = `n${notificationSeq}`;
    scheduled.set(identifier, { identifier, content: req.content ?? {}, trigger: req.trigger ?? {} });
    return identifier;
  },
  cancelScheduledNotificationAsync: async (id: string) => { scheduled.delete(id); },
  cancelAllScheduledNotificationsAsync: async () => { scheduled.clear(); },
  getAllScheduledNotificationsAsync: async () => [...scheduled.values()],
  setNotificationHandler: () => {},
  setNotificationChannelAsync: async () => null,
  setNotificationCategoryAsync: async () => null,
  getPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  requestPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  addNotificationResponseReceivedListener: () => ({ remove() {} }),
  addNotificationReceivedListener: () => ({ remove() {} }),
  getLastNotificationResponseAsync: async () => null,
  dismissAllNotificationsAsync: async () => {},
  getExpoPushTokenAsync: async () => ({ data: '' }),
  getDevicePushTokenAsync: async () => ({ data: '' }),
};

/** System clock-alarm intents the app sent (AlarmService → expo-intent-launcher). */
export const systemAlarms: Array<{ action: string; extras: Record<string, any> }> = [];
const IntentLauncher = {
  startActivityAsync: async (action: string, params: any) => {
    systemAlarms.push({ action, extras: params?.extra ?? params?.extras ?? {} });
    return { resultCode: 0 };
  },
};

// ── the network ─────────────────────────────────────────────────────────────
/** A raw Google Calendar API item, as the Events.list endpoint returns it. */
export interface GoogleItem {
  id: string;
  summary: string;
  status?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  location?: string;
  hangoutLink?: string;
  description?: string;
  organizer?: { email?: string };
}
let calendar: GoogleItem[] = [];
/** Replace the whole calendar the fake Google serves. */
export function setCalendar(items: GoogleItem[]): void { calendar = items; }

export const networkLog: string[] = [];
(globalThis as any).fetch = async (input: any): Promise<any> => {
  const url = String(typeof input === 'string' ? input : input?.url);
  if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
    const params = new URL(url).searchParams;
    const from = new Date(params.get('timeMin')!).getTime();
    const to = new Date(params.get('timeMax')!).getTime();
    // Google's own rule for Events.list: an event is returned when it OVERLAPS
    // the window, i.e. ends after timeMin and starts before timeMax.
    const items = calendar
      .filter((i) => new Date(i.end.dateTime).getTime() > from && new Date(i.start.dateTime).getTime() < to)
      .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
    return { ok: true, status: 200, json: async () => ({ items }), text: async () => '' };
  }
  networkLog.push(url.split('?')[0]);
  throw new Error('offline (meira-sim harness: only Google Calendar is reachable)');
};

// ── the module loader ───────────────────────────────────────────────────────
// An inert native module. It has to survive `import * as X` interop, which
// copies OWN keys into a fresh object built on the module's prototype — so the
// catch-all lives on the prototype, where property lookups fall through to it.
// `then` is excluded or every awaited stub would look like a pending promise.
const noop: any = new Proxy(function inertFn() { return undefined; }, {
  get: (_t, prop) => (prop === 'then' ? undefined : noop),
  apply: () => undefined,
});
const catchAll: any = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : noop) });
const inert = (): any => Object.create(catchAll, { __esModule: { value: true } });

const ReactNative = {
  Platform: { OS: 'android', Version: 34, select: (o: any) => (o.android ?? o.default) },
  Linking: { openURL: async () => {}, canOpenURL: async () => false, addEventListener: () => ({ remove() {} }) },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Alert: { alert: () => {} },
  NativeModules: {},
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  StyleSheet: { create: (s: any) => s },
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request.endsWith('/EncryptedStorage')) return { __esModule: true, default: memoryAsyncStorage };
  switch (request) {
    case '@react-native-async-storage/async-storage':
      return { __esModule: true, default: memoryAsyncStorage };
    case 'expo-secure-store':
      return { __esModule: true, ...SecureStore };
    case 'expo-notifications':
      return { __esModule: true, ...Notifications };
    case 'expo-intent-launcher':
      return { __esModule: true, ...IntentLauncher };
    case 'expo-constants':
      return { __esModule: true, default: { appOwnership: null, executionEnvironment: 'bare', expoConfig: { extra: {} } } };
    case 'react-native':
      return { __esModule: true, ...ReactNative };
    default:
      break;
  }
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return {
      __esModule: true,
      getUserId: async () => null,
      getSession: async () => null,
      onAuthChange: () => () => {},
    };
  }
  if (/^(expo-|@expo\/|react-native-|@react-native)/.test(request)) return inert();
  return origLoad.call(this, request, ...rest);
};

// ── routing: Google Directions, answered from a travel model ───────────────
/**
 * One routing question as the app asks it. `mode` is the app's own word:
 * car / bike / walk for a single-vehicle trip, rail / bus / transit for
 * public transport.
 */
export interface RouteQuery {
  origin: string;
  destination: string;
  date: string;
  mode: 'car' | 'bike' | 'walk' | 'rail' | 'bus' | 'transit';
  arriveBy?: string;
  departEpoch?: number;
}
export interface RouteLeg { type: string; minutes: number }
/** Legs for a query, or null for "Google found no route" (ZERO_RESULTS). */
export type RouteResolver = (q: RouteQuery) => RouteLeg[] | null;
export const routeLog: RouteQuery[] = [];

const pad = (n: number) => String(n).padStart(2, '0');
const clockOf = (epochMs: number) => {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A Directions API body for one query, in the fields the app reads. */
function directionsBody(q: RouteQuery, legs: RouteLeg[]): any {
  const total = Math.max(1, legs.reduce((s, l) => s + l.minutes, 0));
  if (q.mode === 'car' || q.mode === 'bike' || q.mode === 'walk') {
    const leg = {
      duration: { value: total * 60, text: `${total} mins` },
      distance: { value: 0, text: '' },
      start_address: q.origin,
      end_address: q.destination,
      steps: [],
      ...(q.mode === 'car' ? { duration_in_traffic: { value: total * 60, text: `${total} mins` } } : {}),
    };
    return { status: 'OK', routes: [{ legs: [leg] }] };
  }
  // Public transport: timed against the arrive-by deadline when there is one
  // (Google's arrival_time), otherwise from the departure epoch.
  const arriveMs = q.arriveBy
    ? new Date(`${q.date}T${q.arriveBy}:00`).getTime()
    : (q.departEpoch ?? Math.floor(Date.now() / 1000)) * 1000 + total * 60_000;
  const startMs = arriveMs - total * 60_000;
  const ride = legs.find((l) => l.type === 'train' || l.type === 'bus');
  const vehicle = ride?.type === 'train' ? 'HEAVY_RAIL' : 'BUS';
  let cursor = startMs;
  const steps: any[] = [];
  let pendingWalk = 0;
  for (const l of legs) {
    if (l.type === 'walk' || l.type === 'wait') {
      // Google folds the wait before boarding into the walking step.
      pendingWalk += l.minutes;
      continue;
    }
    if (pendingWalk) {
      steps.push({ travel_mode: 'WALKING', duration: { value: pendingWalk * 60 } });
      cursor += pendingWalk * 60_000;
      pendingWalk = 0;
    }
    const dep = cursor;
    cursor += l.minutes * 60_000;
    steps.push({
      travel_mode: 'TRANSIT',
      duration: { value: l.minutes * 60 },
      transit_details: {
        departure_time: { text: clockOf(dep), value: Math.floor(dep / 1000) },
        arrival_time: { text: clockOf(cursor), value: Math.floor(cursor / 1000) },
        departure_stop: { name: vehicle === 'HEAVY_RAIL' ? 'Station (origin)' : 'Stop (origin)' },
        arrival_stop: { name: vehicle === 'HEAVY_RAIL' ? 'Station (destination)' : 'Stop (destination)' },
        headsign: 'Destination',
        line: {
          short_name: vehicle === 'HEAVY_RAIL' ? '' : '100',
          name: vehicle === 'HEAVY_RAIL' ? 'Israel Railways' : 'Bus',
          vehicle: { type: vehicle },
        },
      },
    });
  }
  if (pendingWalk) {
    steps.push({ travel_mode: 'WALKING', duration: { value: pendingWalk * 60 } });
  }
  return {
    status: 'OK',
    routes: [{
      legs: [{
        departure_time: { text: clockOf(startMs), value: Math.floor(startMs / 1000) },
        arrival_time: { text: clockOf(arriveMs), value: Math.floor(arriveMs / 1000) },
        duration: { value: total * 60, text: `${total} mins` },
        start_address: q.origin,
        end_address: q.destination,
        steps,
      }],
    }],
  };
}

/**
 * Route every Directions request through `resolve`, via the app's own gateway
 * seam (RoutePlanner.setDirectionsGateway) — the same door App.tsx uses to
 * send routing through the server.
 */
export function installDirections(resolve: RouteResolver): void {
  const RoutePlanner = require('../src/services/RoutePlanner');
  RoutePlanner.setDirectionsGateway(async (req: any) => req.queries.map((qq: any) => {
    const mode: RouteQuery['mode'] = qq.mode === 'transit'
      ? (qq.transit_mode ?? 'transit')
      : qq.mode === 'driving' ? 'car' : qq.mode === 'bicycling' ? 'bike' : 'walk';
    const q: RouteQuery = {
      origin: req.origin, destination: req.destination, date: req.date, mode,
      arriveBy: req.arriveBy, departEpoch: qq.depart_epoch,
    };
    routeLog.push(q);
    const legs = resolve(q);
    if (!legs) return { status: 'ZERO_RESULTS', data: null };
    return { status: 'OK', data: directionsBody(q, legs) };
  }));
}

// ── controls ────────────────────────────────────────────────────────────────

/** A connected Google account whose token never expires during the run. */
export function connectGoogle(): void {
  secureStore.set('google_tokens', JSON.stringify({
    accessToken: 'meira-sim', refreshToken: 'meira-sim', expiresAt: Date.now() + 365 * 86_400_000,
  }));
}

/** A new install: storage, notifications, alarms, calendar and logs all empty. */
export function resetApp(): void {
  asyncStore.clear();
  secureStore.clear();
  scheduled.clear();
  systemAlarms.length = 0;
  routeLog.length = 0;
  networkLog.length = 0;
  calendar = [];
}

// ── fixture adapters ────────────────────────────────────────────────────────

/** The app has no scooter; the fixture's scooter rider is routed as a cyclist. */
export const APP_MODE: Record<string, string> = {
  car: 'car', train: 'train', bus: 'bus', bike: 'bike', walk: 'walk', scooter: 'bike',
};

/**
 * A fresh install for one fixture user: Google connected, and the profile the
 * app reads — home, mode, morning routine, whether there is a car, the
 * earliest wake, the arrival buffer and the habitual departure delay. The wake
 * buffer is 0 because the fixture defines wake as leave − routine with nothing
 * added.
 */
export async function bootUser(user: FixtureUser): Promise<void> {
  resetApp();
  connectGoogle();
  const UserProfileStorage = require('../src/services/UserProfileStorage');
  await collectWarnings(() => UserProfileStorage.saveProfile({
    name: user.name,
    language: 'en',
    homeAddress: user.homeAddress,
    homeLatLng: { lat: user.home[0], lng: user.home[1] },
    transportType: APP_MODE[user.mode] ?? 'bus',
    morningRoutineMinutes: user.routine,
    wakeBufferMinutes: 0,
    hasCar: user.modes.includes('car'),
    earliestWakeTime: user.earliestWake,
    travelBufferMinutes: user.buffer,
    departDelayMinutes: user.avgDelay,
  }));
}

/**
 * Set what the app has learned about her departure delay — the persona's
 * state on that date, as the fixture's own learning recorded it.
 */
export async function setDepartDelay(minutes: number): Promise<void> {
  const UserProfileStorage = require('../src/services/UserProfileStorage');
  const stored = await UserProfileStorage.loadProfile();
  await collectWarnings(() => UserProfileStorage.saveProfile({ ...stored, departDelayMinutes: minutes }));
}

/** A fixture meeting as the Google Calendar API would return it. */
export function googleItem(m: FixtureMeeting, locations: Map<string, FixtureLocation>): GoogleItem {
  return {
    id: `${m.dataset}-${m.id}`,
    summary: m.title,
    status: 'confirmed',
    start: { dateTime: m.startAt },
    end: { dateTime: m.endAt },
    ...(m.locationId ? { location: locations.get(m.locationId)!.address } : {}),
    ...(m.meetingUrl ? { hangoutLink: m.meetingUrl } : {}),
  };
}

/** The task id the app gives an imported fixture meeting. */
export const taskIdOf = (m: Pick<FixtureMeeting, 'dataset' | 'id'>) => `gcal-${m.dataset}-${m.id}`;

/**
 * Answer the app's routing questions from a RouteSource, mapping the strings
 * the app sends (a "lat,lng" home or a street address) back to fixture ids.
 * Every question that could not be mapped is kept, so a harness gap is
 * visible rather than silently becoming "no route".
 */
export function installFixtureRouting(
  user: FixtureUser, locations: Map<string, FixtureLocation>, source: RouteSource,
  meetings: FixtureMeeting[] = [],
): { unmapped: RouteQuery[] } {
  const unmapped: RouteQuery[] = [];
  // Two fixture places can share one street address (Sarona Market and WeWork
  // Sarona are both "Aluf Kalman Magen St 3"). The app only ever sees the
  // string, so the harness breaks the tie with the places on that day's
  // calendar — the one the user is actually going to.
  const placesOn = (date: string) => new Set(
    meetings.filter((m) => m.userId === user.id && m.date === date && m.locationId)
      .map((m) => m.locationId!));
  const idOf = (s: string, date: string): string | null => {
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const [lat, lng] = [Number(m[1]), Number(m[2])];
      if (Math.abs(lat - user.home[0]) < 1e-6 && Math.abs(lng - user.home[1]) < 1e-6) return 'home';
      for (const l of locations.values()) {
        if (Math.abs(l.lat - lat) < 1e-6 && Math.abs(l.lng - lng) < 1e-6) return l.id;
      }
      return null;
    }
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const want = norm(s);
    if (want === norm(user.homeAddress)) return 'home';
    const hits = [...locations.values()].filter((l) => {
      const a = norm(l.address);
      return a === want || want.includes(a) || a.includes(want);
    });
    if (hits.length <= 1) return hits[0]?.id ?? null;
    const today = placesOn(date);
    return (hits.find((l) => today.has(l.id)) ?? hits[0]).id;
  };
  installDirections((q) => {
    const from = idOf(q.origin, q.date);
    const to = idOf(q.destination, q.date);
    if (!from || !to) { unmapped.push(q); return null; }
    return source({ from, to, date: q.date, mode: q.mode, arriveBy: q.arriveBy, departEpoch: q.departEpoch });
  });
  return { unmapped };
}

/** What the OS is currently holding, in fire order. */
export function scheduledNotifications(): ScheduledNotification[] {
  const when = (n: ScheduledNotification) => new Date(n.trigger?.date as any).getTime() || 0;
  return [...scheduled.values()].sort((a, b) => when(a) - when(b));
}

/**
 * Run `fn` with the wall clock stopped at `isoInstant` — `new Date()` and
 * `Date.now()` both answer it, everything else about Date is untouched. The
 * fixture has no "now"; the app does, and a slot in the past is only a bug
 * relative to one.
 */
export async function withClock<T>(isoInstant: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixed = new RealDate(isoInstant).getTime();
  class StoppedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [any]));
    }
    static now() { return fixed; }
  }
  (globalThis as any).Date = StoppedDate;
  try {
    return await fn();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}

/**
 * Warnings the app printed while a function ran — silent-state rule 2 says a
 * swallowed failure must at least warn, so these are part of the result.
 */
export async function collectWarnings<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  const log = console.log;
  console.warn = (...args: any[]) => { warnings.push(args.map(String).join(' ').slice(0, 240)); };
  console.log = () => {};
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
    console.log = log;
  }
}
