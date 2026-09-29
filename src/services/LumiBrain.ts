/**
 * LumiBrain — the app talking to the SAME agent WhatsApp talks to.
 *
 * The Chat tab used to claim it ran "the same engine as WhatsApp". It did not.
 * WhatsApp gets a LangGraph ReAct agent with eighteen tools, conversation
 * history, distilled memory, the personality prompt and a consistency check.
 * The app got LumiCoachEngine: a chain of regex intent detectors and one JSON
 * extraction call. Same model on both sides (Qwen3-235B) — only one of them was
 * ever an agent, which is exactly why one answers well and the other does not.
 *
 * The brain was never WhatsApp-specific; it simply had no door except the Twilio
 * webhook. `POST /agent/chat` is the second door, and this is the client for it.
 *
 * Identity is the Supabase access token, verified server-side BY Supabase — not
 * a phone number in the body, which anyone knowing the number could send. The
 * server maps the verified account to the linked WhatsApp number, so a
 * conversation continues across channels instead of starting again per app.
 *
 * Returns null (never throws) when the brain is unreachable — not signed in, no
 * server configured, offline, or a server error. The caller then falls back to
 * the local engine, so the chat still works on a plane.
 *
 * Dependencies: SupabaseAuthService (session), EXPO_PUBLIC_SERVER_URL,
 * TaskStorage.mergeExternalTasks. Consumed by CoachChatScreen.
 */
import { getSession } from './SupabaseAuthService';
import { mergeExternalTasks } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { planArrivedTasks } from './ArrivedTaskPlanner';
import { Task, TaskCategory, TaskPriority } from '../types/index';

/** The app's transport names → the server's. */
const SERVER_MODE: Record<string, string> = {
  bicycle: 'bike', foot: 'walk', car: 'car', transit: 'bus',
};

/**
 * What she set on the Profile screen, for the brain.
 *
 * The app keeps its profile on the phone and in Supabase; the agent reads its
 * own store on the server, and nothing ever joined the two. So "🚲 bike" and
 * "🔁 Routines: קיקבוקס 20:30-21:30 יגאל אלון 94" were on her screen and
 * invisible to Meira — whose transport default was "car", and who therefore
 * asked "how are you getting there?" and "where is the gym?". Sent with every
 * turn: the conversation itself is the trigger, so the brain always has the
 * profile she is looking at. The server takes only these four fields.
 */
async function profileForBrain(): Promise<Record<string, string> | undefined> {
  try {
    const p: any = await loadProfile();
    if (!p) return undefined;
    const out: Record<string, string> = {};
    const mode = SERVER_MODE[String(p.transportMode ?? '')];
    if (mode) out.transportType = mode;
    for (const k of ['homeAddress', 'routinesNotes', 'hobbies'] as const) {
      if (typeof p[k] === 'string' && p[k].trim()) out[k] = p[k].trim();
    }
    return Object.keys(out).length ? out : undefined;
  } catch (e) {
    console.warn('[LumiBrain] could not read the profile to send', e);
    return undefined;
  }
}

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

/**
 * Long enough for a tool-using agent turn, short enough to fall back on.
 *
 * Was 45 s. On 2026-09-28 a four-item voice day took longer than that on the
 * server, the phone gave up, and the server saved the tasks anyway — so the
 * app said "nothing was saved" about tasks that were. Ninety seconds lets a
 * real day through; the server keeps working past it either way.
 */
const TIMEOUT_MS = 90_000;

export interface BrainReply {
  text: string;
  /** Tasks the turn created, already merged into local storage. */
  tasks: Task[];
  departures: any[];
}

/** Map a server task (snake_case) into the app's Task shape. */
function mapTask(r: any): Task | null {
  if (!r || !r.text) return null;
  const fixedTime = r.fixed_time ? String(r.fixed_time).slice(0, 5) : undefined;
  // KEEP WHERE THE SERVER PLACED IT. infer_task_details returns `place`
  // ({lat, lng, displayName}) whenever Google found the address, and this
  // mapper dropped it — so a chat task reached the phone as a bare string the
  // app then had to geocode again on its next sweep, minutes later.
  const coords = r.place && Number.isFinite(Number(r.place.lat)) && Number.isFinite(Number(r.place.lng))
    && !(Number(r.place.lat) === 0 && Number(r.place.lng) === 0)
    ? { lat: Number(r.place.lat), lng: Number(r.place.lng) }
    : null;
  const location = typeof r.location === 'string' && r.location.trim() && coords
    ? {
      address: r.location.trim(),
      displayName: r.place.displayName ? String(r.place.displayName) : undefined,
      lat: coords.lat,
      lng: coords.lng,
      confirmed: false,
    }
    : (r.location ?? undefined);
  const hasPlace = typeof location === 'string'
    ? Boolean(location.trim())
    : Boolean(location && (location.address || location.displayName));
  return {
    id: String(r.id ?? `brain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    text: String(r.text),
    category: (r.category ?? 'general') as TaskCategory,
    priority: (r.priority ?? 'need_to') as TaskPriority,
    isFixed: Boolean(fixedTime),
    fixedTime,
    scheduledTime: fixedTime,
    durationMinutes: r.duration_minutes ?? 30,
    // Same batch label as the WhatsApp pull — one message's tasks stay one group.
    subgroup: r.subgroup ?? undefined,
    date: String(r.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    status: 'pending',
    source: 'whatsapp',   // same origin story: created by the shared brain
    location,
    hasLocation: hasPlace,
    createdAt: Date.now(),
    historicalDurations: [],
  } as Task;
}

/** True when a turn could even be attempted — no session means no identity. */
export async function brainAvailable(): Promise<boolean> {
  if (!SERVER_URL) return false;
  try {
    return Boolean((await getSession())?.access_token);
  } catch {
    return false;
  }
}

/**
 * One turn with the shared brain. Null means "not available — use the local
 * engine"; it never throws, because a chat that dies on a bad network is worse
 * than a chat that answers a little less well.
 */
export async function brainTurn(
  message: string,
  // WHERE SHE IS ASKING FROM.
  //
  // "How do I get there from here" was unanswerable: the body carried only
  // {message}, so the agent's only origin was the stored home address and it
  // routed her flat → destination however far from the flat she happened to
  // be. Nothing in the reply said so, which is the worst kind of wrong answer.
  //
  // Sent per turn, never stored, and only when a fix is already in hand — the
  // caller decides whether to ask the GPS, so a chat about nothing spatial
  // costs no location read.
  // `mode: 'voice_plan'` — the app's mic. The server tells the model not to
  // pin clock times, because the planner places them right after this turn.
  opts: { here?: { lat: number; lng: number; label?: string }; mode?: 'voice_plan' } = {},
): Promise<BrainReply | null> {
  // Every one of these used to be a SILENT `return null`, and the caller turns
  // null into a locally-composed reply that looks exactly like a real answer.
  // So when the brain was unreachable, the app said something friendly, saved
  // nothing, and left no trace anywhere to say which door had closed.
  //
  // Koral, 2026-09-17: "Meira answers correctly! but now i see that nothing
  // have been saved?! why?" — there was no way to tell, including for me.
  //
  // warn, not log: a release build drops console.log entirely, and these are
  // precisely the lines worth having when it happens on her phone.
  if (!SERVER_URL) {
    console.warn('[LumiBrain] no EXPO_PUBLIC_SERVER_URL in this build — the brain is unreachable by construction');
    return null;
  }

  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch (e) {
    console.warn('[LumiBrain] could not read the session', e);
    token = undefined;
  }
  if (!token) {
    console.warn('[LumiBrain] signed out or the session expired — falling back to the device');
    return null;   // signed out: the server cannot know who this is
  }

  const profile = await profileForBrain();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message,
        ...(opts.here ? { here: opts.here } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(profile ? { profile } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[LumiBrain] server said', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const body = await res.json();
    const tasks = (body.tasks ?? [])
      .map(mapTask)
      .filter((t: Task | null): t is Task => t !== null);

    // The brain saved them on its side; merge locally so they appear in the day
    // without waiting for the next sync. mergeExternalTasks is keyed on the
    // shared id, so a later pull cannot duplicate them.
    if (tasks.length) {
      await mergeExternalTasks(tasks).catch(() => {});
      // Route them NOW — the reply is not held for Google, but the route no
      // longer waits for some other screen's sweep. See ArrivedTaskPlanner.
      planArrivedTasks(tasks).catch((e) => console.warn('[LumiBrain] routing new tasks failed', e));
    }
    return { text: String(body.text ?? ''), tasks, departures: body.departures ?? [] };
  } catch (e) {
    // Rule 1: our own timeout and a dead network are different fixes.
    console.warn('[LumiBrain] turn failed',
      controller.signal.aborted ? `— no answer in ${TIMEOUT_MS / 1000}s (the server may still save it)` : '', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
