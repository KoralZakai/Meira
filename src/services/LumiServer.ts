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
 *   transcribeAudio → POST /app/stt             (recording → Whisper, typed failures)
 *   planDay        → POST /app/schedule/build {mode: plan} (flexible tasks → free time)
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

export interface TaskPrepResult {
  ok: boolean;
  reason?: 'no_task' | 'search_not_configured' | 'plan_failed' | 'nothing_to_prepare'
    | 'no_sources' | 'compose_failed' | 'nothing_cited';
  kind?: 'songs' | 'questions' | 'checklist' | 'reading' | 'route_tips' | 'ideas' | 'other';
  why?: string;
  headline_he?: string;
  headline_en?: string;
  items_he?: string[];
  items_en?: string[];
  sources?: Array<{ n: number; title?: string; link?: string }>;
  cached?: boolean;
}

/**
 * What to prepare for ONE task — songs for karaoke, what to bring to a clinic —
 * from live search, every item cited (server/task_prep.py). Only the task's own
 * words go up; the server writes the search queries about the task, never her.
 */
export async function taskPrep(
  task: { id: string; text: string; category?: string; date?: string; time?: string; location?: string },
  force = false,
): Promise<TaskPrepResult | null> {
  return call<TaskPrepResult>('/app/task/prep', { task, force }, BRIEF_TIMEOUT_MS);
}

export interface ErrandCandidate {
  place_id: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  rating?: number;
  off_route_m: number;
  pass_at: string;
  date?: string;
  trip?: string;
  open_when_passing: boolean | null;
  maps_url?: string;
  /** Google's hours line for that day, e.g. "09:00–18:00". */
  hours_today?: string;
  /** 0 (free) … 4 (very expensive), when Google knows it. */
  price_level?: number | null;
  reviews?: number | null;
  /** What it costs, from the web (Tavily) — each number verified against its source. */
  price?: { price: string; source_title?: string; source_url?: string };
  /** Why there is no price: no_price_published, price_not_in_source, search_failed: … */
  price_reason?: string;
  /** Her latest 👍/👎 on this place, when she gave one. */
  your_verdict?: 'up' | 'down';
  /** Meira's one pick, with the reasons ("open_when_passing", "rating 4.6", "120 m off route"). */
  recommended?: boolean;
  why?: string[];
}

export interface ErrandsResult {
  ok: boolean;
  reason?: 'no_task' | 'no_route' | 'places_not_configured' | 'understand_failed' | 'not_an_errand'
    | 'nothing_on_route' | 'places_refused' | 'places_unreachable' | 'nothing_open_when_passing' | 'bad_request';
  query?: string;
  minutes?: number;
  candidates?: ErrandCandidate[];
  closed?: ErrandCandidate[];
}

export interface ErrandTrip { polyline: string; leave: string; arrive: string; date: string; label?: string }

/**
 * An errand with no place → places ON her planned routes, open when she passes
 * (server/errands_along.py). Only the route lines and their times go up.
 */
export async function errandsAlong(text: string, trips: ErrandTrip[]): Promise<ErrandsResult | null> {
  return call<ErrandsResult>('/app/errands/along', { task: { text }, trips }, BRIEF_TIMEOUT_MS);
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

// Upload plus Whisper. Groq answers in about a second; the rest is a phone
// uploading a few hundred KB over whatever signal it has.
// Whisper plus a Hebrew re-check, on a machine that may be waking up: 30 s
// timed out on her phone (28.9) while the server was merely slow.
const STT_TIMEOUT_MS = 45_000;

/**
 * Why there is no transcript. Every value names a different fix, which is the
 * point: the old recogniser answered all of these with an empty string.
 */
export type SttFailure =
  | 'no_server'           // this build has no EXPO_PUBLIC_SERVER_URL
  | 'signed_out'          // no session, so the server cannot know who is asking
  | 'offline'             // the request never reached the server
  | 'slow'                // it did, and no answer came in time
  | 'no_speech'           // the recording reached Whisper and held no words
  | 'stt_not_configured'  // the server has no STT key
  | 'provider_failed'     // Groq refused or failed; one retry is reasonable
  | 'rate_limited'
  | 'too_large'
  | 'server_error';

export type SttResult =
  | { ok: true; text: string }
  | { ok: false; error: SttFailure; detail?: string };

/**
 * A recording → text, through the SAME Whisper the WhatsApp voice notes use.
 *
 * The app used Android's recogniser, locked to the UI language and cut off at
 * the first pause. This sends the whole file with no language pinned, so a
 * sentence that switches between Hebrew and English survives intact.
 *
 * `hint` is a short vocabulary list (her places, her upcoming task names) that
 * biases how Whisper spells words it has never heard — "Ceva", not "Siva".
 *
 * Never throws, never returns an empty success.
 */
export async function transcribeAudio(uri: string, hint = ''): Promise<SttResult> {
  if (!SERVER_URL) return { ok: false, error: 'no_server' };

  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch (e) {
    console.warn('[LumiServer] /app/stt could not read the session', e);
  }
  if (!token) return { ok: false, error: 'signed_out' };

  // A NEW form per attempt. The file part is a stream the first send reads to
  // the end; the retry re-sent that same, spent stream and died with "Stream
  // Closed" (28.9, twice) — so the retry could never succeed.
  const makeForm = () => {
    const form = new FormData();
    // React Native uploads a local file from {uri, name, type}; the name's
    // extension is what tells Whisper the container format.
    form.append('file', { uri, name: 'voice.m4a', type: 'audio/mp4' } as any);
    if (hint.trim()) form.append('hint', hint.trim().slice(0, 400));
    return form;
  };

  const send = () => postForm(
    `${SERVER_URL}/app/stt`, makeForm(), { Authorization: `Bearer ${token}` }, STT_TIMEOUT_MS,
  );
  try {
    let answer: { status: number; body: any };
    try {
      answer = await send();
    } catch (e) {
      if (!(e instanceof UploadNetworkError)) throw e;
      // The server sleeps when idle, and the first request after a nap can
      // be dropped while it wakes — on her phone, 2026-09-28, the first
      // recording failed after 6.6 s and the next one, a minute later,
      // transcribed fine. That request woke it; one more try is enough.
      console.warn('[LumiServer] /app/stt first try failed, retrying once', String(e));
      await new Promise((r) => setTimeout(r, 1500));
      answer = await send();
    }
    const { status, body } = answer;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (status >= 200 && status < 300 && text) return { ok: true, text };

    const known: SttFailure[] = [
      'no_speech', 'stt_not_configured', 'provider_failed', 'rate_limited', 'too_large',
    ];
    const error: SttFailure = known.includes(body?.error)
      ? body.error
      : status === 401 ? 'signed_out' : 'server_error';
    console.warn('[LumiServer] /app/stt said', status, error, body?.detail ?? '');
    return { ok: false, error, detail: body?.detail ?? `HTTP ${status}` };
  } catch (e) {
    // Rule 1: 'offline' means the network, and only the network. Anything
    // else thrown here is our own bug and must not read as "no connection".
    const network = e instanceof UploadNetworkError;
    // A timeout is not "no connection" — the phone was online and the server
    // was slow. Different fix, different words (rule 3).
    const slow = network && /timeout|no answer in/i.test(String((e as Error).message));
    console.warn('[LumiServer] /app/stt failed', network ? (slow ? '(slow)' : '(network)') : '(NOT network)', e);
    return { ok: false, error: slow ? 'slow' : network ? 'offline' : 'server_error', detail: String(e).slice(0, 120) };
  }
}

/** The request never got an answer: no signal, or no answer in time. */
class UploadNetworkError extends Error {}

/**
 * POST a multipart form through React Native's own networking.
 *
 * Koral, 2026-09-28: "I tried to record twice — it said no connection."
 * The phone was on Wi-Fi. Expo 56 installs `expo/fetch` as the global
 * `fetch`, and expo/fetch cannot send a React Native file part: `{ uri, name,
 * type }` throws "Unsupported FormDataPart implementation" before one byte
 * leaves the phone. The catch filed that under 'offline', so EVERY recording
 * failed and said "No connection" (rule 1: one empty result, two meanings).
 *
 * XMLHttpRequest is still React Native's, and it streams a `uri` part from
 * disk natively — the multipart boundary is set by the platform, so no
 * Content-Type header is passed here.
 */
function postForm(
  url: string,
  form: FormData,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = timeoutMs;
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null; // a non-JSON answer is classified by its status alone
      }
      resolve({ status: xhr.status, body });
    };
    // React Native leaves the native reason in responseText; keep it (rule 2).
    xhr.onerror = () => reject(new UploadNetworkError(`network error: ${String(xhr.responseText || '').slice(0, 160)}`));
    xhr.ontimeout = () => reject(new UploadNetworkError(`no answer in ${timeoutMs} ms`));
    xhr.send(form as any);
  });
}

export interface PlannedDay {
  placed: Array<{ id: string; text: string; start: string; end: string; why: string; shortened_from?: number }>;
  unplaced: Array<{ id: string; text: string; why: string; need: number; largest: number }>;
  windows: Array<{ start: string; end: string }>;
  summary: string;
}

/**
 * Put the day's flexible tasks into time that is really free (day_planner).
 *
 * Unlike buildSchedule's sort, this knows about journeys: busy time runs from
 * the leave time to the trip home, with a buffer either side, and nothing is
 * placed past bedtime. What does not fit comes back in `unplaced` WITH its
 * reason — it is never silently dropped. The phone sends what it holds (its
 * view includes calendar imports and routes), so the answer is about the day
 * on her screen. Null = the planner could not be reached.
 */
export async function planDay(
  date: string,
  tasks: Task[],
  opts: { wakeTime?: string; sleepTime?: string; language?: string } = {},
): Promise<PlannedDay | null> {
  const body = await call<any>('/app/schedule/build', {
    date,
    tasks,
    mode: 'plan',
    wake_time: opts.wakeTime,
    sleep_time: opts.sleepTime,
    language: opts.language ?? 'he',
  }, SCHEDULE_TIMEOUT_MS);
  if (!body || !Array.isArray(body.placed)) return null;
  return {
    placed: body.placed,
    unplaced: Array.isArray(body.unplaced) ? body.unplaced : [],
    windows: Array.isArray(body.windows) ? body.windows : [],
    summary: String(body.summary ?? ''),
  };
}

// ── AI assistants (MCP) ─────────────────────────────────────────────────────

/** A server answer or the reason there is none — never a bare null (rule 1). */
export type Reasoned<T> = { ok: true; data: T } | { ok: false; reason: string };

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Reasoned<T>> {
  if (!SERVER_URL) return { ok: false, reason: 'This build has no server address' };
  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch (e) {
    console.warn('[LumiServer] session unreadable', e);
  }
  if (!token) return { ok: false, reason: 'Sign in first — the server needs to know it is you' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      console.warn('[LumiServer]', method, path, 'said', res.status, text);
      return { ok: false, reason: res.status === 404 ? 'The server does not have this yet (deploy pending)' : `Server said ${res.status}: ${text}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    console.warn('[LumiServer]', method, path, 'failed', e);
    return { ok: false, reason: `Could not reach the server: ${String((e as Error)?.message || e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

export interface McpToken { token: string; label: string; created: number; url: string }
export interface McpTokenInfo { id: string; label: string; created: number; last_used: number | null }

/** A personal token an AI assistant (Claude, ChatGPT, Cursor) uses to reach Meira. Shown once. */
export function createMcpToken(label: string): Promise<Reasoned<McpToken>> {
  return request<McpToken>('POST', '/app/mcp/token', { label });
}

export function listMcpTokens(): Promise<Reasoned<{ tokens: McpTokenInfo[] }>> {
  return request('GET', '/app/mcp/tokens');
}

/** Revoke one token by id, or every token when id is omitted. */
export function revokeMcpTokens(id?: string): Promise<Reasoned<{ revoked: number }>> {
  return request('DELETE', `/app/mcp/token${id ? `?id=${encodeURIComponent(id)}` : ''}`);
}

// ── 👍/👎 on suggestions (server/feedback_store.py) ───────────────────────────

export interface FeedbackInput {
  surface: 'errand' | 'prep' | 'brief';
  verdict: 'up' | 'down';
  /** What was judged, in words: the place name, the task text. */
  subject: string;
  place_id?: string;
  /** The kind of thing: 'songs', 'laundromat'. */
  about?: string;
  reason?: string;
}

/** Saved → {effect} in words ("won't be recommended again"); else the reason. */
export function sendFeedback(f: FeedbackInput): Promise<Reasoned<{ ok: boolean; effect: string }>> {
  return request('POST', '/app/feedback', f);
}
