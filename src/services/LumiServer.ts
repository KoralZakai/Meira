/**
 * LumiServer — the thin client's calls to the one brain.
 *
 * The app used to carry its own agent: an API key compiled into the APK, a
 * 12-tool ReAct loop, four task extractors and three schedule builders, all
 * drifting away from the Python server that WhatsApp talks to. This module is
 * what replaces them — two functions over two endpoints, no model on the phone.
 *
 *   buildSchedule  → POST /app/schedule/build   (deterministic, ~1ms, no cost)
 *   extractTasks   → POST /app/tasks/extract    (one cheap model call, server-side)
 *   extractProfile → POST /app/profile/extract  (onboarding answers → profile)
 *   parseCheckIn   → POST /app/checkin/parse    (check-in intent + updates)
 *   emailsToEvents → POST /app/email/events     (Gmail scan → appointments)
 *
 * Both return null rather than throwing, exactly like LumiBrain: not signed in,
 * no server configured, offline or a server error all mean "use what the phone
 * can still do by itself". For the schedule that fallback is the local
 * buildDaySchedule (the same algorithm the server runs, which is why the day
 * does not change shape when the network does); for capture it is the manual
 * add form. A screen that cannot reach the server must still work on a plane.
 *
 * Identity is the Supabase access token, verified server-side BY Supabase —
 * never a phone number in the body.
 *
 * Dependencies: SupabaseAuthService (session), EXPO_PUBLIC_SERVER_URL.
 * Consumed by MyTasks, AddTaskScreen, CheckInScreen, OnboardingScreen, useTasks.
 */
import { getSession } from './SupabaseAuthService';
import { Task } from '../types/index';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

// Researching a meeting is several live web searches plus a model call. The
// extract timeouts are sized for one cheap call and would abort this halfway.
const BRIEF_TIMEOUT_MS = 75_000;

/** A sort is instant; an extraction waits on a model. Different budgets. */
const SCHEDULE_TIMEOUT_MS = 12_000;
const EXTRACT_TIMEOUT_MS = 30_000;

export interface ServerTask {
  text: string;
  category: string;
  priority: string;
  duration_minutes: number;
  fixed_time?: string | null;
  scheduled_time?: string | null;
  date: string;
  location?: any;
  id?: string;
}

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  if (!SERVER_URL) return null;

  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch {
    token = undefined;
  }
  if (!token) return null;   // signed out: the server cannot know who this is

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[LumiServer]', path, 'said', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn('[LumiServer]', path, 'failed', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a server call could even be attempted — no session means no identity. */
export async function serverAvailable(): Promise<boolean> {
  if (!SERVER_URL) return false;
  try {
    return Boolean((await getSession())?.access_token);
  } catch {
    return false;
  }
}

export interface BuiltDay {
  date: string;
  wakeTime: string;
  /** The tasks passed in, each carrying the slot the server assigned. */
  tasks: Array<Task & { scheduledTime?: string }>;
  /** Lumi's one line about the day — SHORT, ready to render. */
  summary: string;
}

/**
 * Lay a day on a timeline, server-side. `tasks` is what the phone is holding
 * (drafts and cache included); omit it and the server uses the saved day.
 * Null means "not available" — call buildDaySchedule locally instead.
 */
export async function buildSchedule(
  date: string,
  tasks?: Task[],
  opts: { wakeTime?: string; importantOnly?: boolean; language?: string } = {},
): Promise<BuiltDay | null> {
  const body = await call<any>('/app/schedule/build', {
    date,
    tasks,
    wake_time: opts.wakeTime,
    important_only: opts.importantOnly ?? false,
    language: opts.language ?? 'he',
  }, SCHEDULE_TIMEOUT_MS);
  if (!body) return null;

  // The server answers in snake_case (it also mirrors scheduledTime when the
  // caller sent camelCase); normalise here so screens keep app-shaped tasks.
  const merged = (body.tasks ?? []).map((t: any) => ({
    ...t,
    scheduledTime: t.scheduledTime ?? t.scheduled_time ?? undefined,
    durationMinutes: t.durationMinutes ?? t.duration_minutes,
    fixedTime: t.fixedTime ?? t.fixed_time ?? undefined,
  }));
  return { date: body.date, wakeTime: body.wake_time, tasks: merged, summary: body.summary ?? '' };
}

/**
 * Raw user input (spoken or typed) → structured tasks, decided server-side.
 * Nothing is saved: the screen shows them and the user confirms. Null means the
 * server was unreachable, not "no tasks" — it never answers with an empty list
 * for a non-empty sentence.
 */
export async function extractTasks(text: string, date?: string): Promise<ServerTask[] | null> {
  const body = await call<any>('/app/tasks/extract', { text, date }, EXTRACT_TIMEOUT_MS);
  if (!body) return null;
  return (body.tasks ?? []) as ServerTask[];
}

/**
 * One onboarding answer → the profile fields it carried, decided server-side
 * and written into the profile the WhatsApp brain reads, so onboarding done in
 * the app is onboarding the whole product knows about.
 *
 * Null means the server was unreachable — the caller falls back to its own
 * on-device extraction rather than losing what the user just said.
 */
export async function extractProfile(
  text: string,
  profile: Record<string, unknown>,
): Promise<Record<string, any> | null> {
  return call<Record<string, any>>('/app/profile/extract', { text, profile }, EXTRACT_TIMEOUT_MS);
}

/**
 * The check-in screen's agent verdict: what the user meant (add tasks, check
 * in, update a task, update the profile) and the fields to apply. Null means
 * the server had no verdict — the screen falls through to its own parse rather
 * than acting on a guess.
 */
export async function parseCheckIn(
  text: string,
  mode: 'capture' | 'review',
  pendingTasks: string[] = [],
): Promise<Record<string, any> | null> {
  return call<Record<string, any>>('/app/checkin/parse',
    { text, mode, pending_tasks: pendingTasks }, EXTRACT_TIMEOUT_MS);
}

/**
 * Gmail subjects and snippets → real upcoming appointments. The mailbox stays
 * on the phone: this sends only what the Gmail scan already found, using the
 * user's own Google token, so no mailbox access moves to the server.
 */
export async function emailsToEvents(
  emails: Array<{ subject: string; sender: string; snippet: string }>,
  date?: string,
): Promise<any[] | null> {
  const body = await call<any>('/app/email/events', { emails, date }, EXTRACT_TIMEOUT_MS);
  return body ? (body.events ?? []) : null;
}

/** One calendar event, as the brief endpoint wants it. */
export interface BriefEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: string[];
  /**
   * Recent email between the user and the people in this meeting — subject
   * lines and Gmail's own snippets, read on the phone with the user's own
   * token. At most four. The mailbox never leaves the device; this is the
   * minimum that can answer "what did we already say to each other".
   */
  history?: Array<{ date: string; subject: string; from: string; snippet: string }>;
}

/** A researched pre-meeting brief. Every bullet ends with its source, "[1]". */
export interface MeetingBriefResult {
  ok: boolean;
  reason?: 'nothing_to_research' | 'search_not_configured' | 'no_sources'
    | 'compose_failed' | 'no_event';
  cached?: boolean;
  headline_he?: string;
  headline_en?: string;
  company_he?: string[];
  company_en?: string[];
  person_he?: string[];
  person_en?: string[];
  questions_he?: string[];
  questions_en?: string[];
  caution_he?: string;
  caution_en?: string;
  confidence?: 'high' | 'medium' | 'low';
  sources?: Array<{ n: number; title?: string; link?: string }>;
  subjects?: { company: string; person: string; person_role: string; role_title: string };
}

/**
 * Research the company and the person behind ONE calendar event.
 *
 * The calendar stays on the phone exactly like Gmail does: we read it with the
 * user's own Google token and send a single event, so no Google credential
 * moves to the server. Research needs live web search and a model call, so it
 * gets the long timeout — and the server caches by event id, which is why
 * opening the card twice is nearly free.
 */
export async function meetingBrief(
  event: BriefEvent,
  force = false,
): Promise<MeetingBriefResult | null> {
  return call<MeetingBriefResult>('/app/meeting/brief', { event, force }, BRIEF_TIMEOUT_MS);
}

/**
 * An address → coordinates, resolved by the SERVER's Maps key.
 *
 * The app used to call Google's Geocoding API itself with the key compiled
 * into the APK. That key is restricted — correctly — to four APIs that do not
 * include Geocoding, so every call returned REQUEST_DENIED and the Israel
 * region hint and home-bias box never applied. Widening the shipped key would
 * have fixed it by making the public key more powerful; this fixes it by not
 * needing one.
 *
 * `bounds` is "lat,lng|lat,lng" — a bias, not a filter. Returns null on any
 * failure so the caller can fall back to the device geocoder.
 */
export async function geocodeAddress(
  address: string,
  bounds?: string,
): Promise<{ lat: number; lng: number; formatted?: string } | null> {
  const body = await call<any>('/app/geocode', { address, bounds }, EXTRACT_TIMEOUT_MS);
  if (!body?.ok || typeof body.lat !== 'number' || typeof body.lng !== 'number') return null;
  return { lat: body.lat, lng: body.lng, formatted: body.formatted };
}
