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
import type { ProfileChange } from './LumiServer';
import { LookupAnswer, asLookupAnswer } from '../utils/answerCard';
import { ChainAnswer, asChainAnswer } from '../utils/chainAnswer';
import { getSession } from './SupabaseAuthService';
import { mergeExternalTasks, updateTaskFields } from './TaskStorage';
import { armDueAlarms } from './AlarmPlanner';
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
 * profile she is looking at. The server takes only these five fields.
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
    // Only a level she chose — the server's default is the same "gentle".
    if (typeof p.nudgeLevel === 'string' && p.nudgeLevel) out.nudgeLevel = p.nudgeLevel;
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
  /** What the turn saved about her — shown as cards with Undo (components/LearnedCard). */
  profileChanges?: ProfileChange[];
  /** "answer": she asked and Meira answered — nothing was planned (agent_turn). */
  type?: string;
  /** A place/route answer the chat draws as a card (components/AnswerCard). */
  answer?: LookupAnswer;
  /** A bike/car-elsewhere plan the chat draws as a map (components/ChainCard). */
  chain?: ChainAnswer;
  /** Short answers to the question in the reply, drawn as buttons (server fit_check: "keep it" / "book 15:30"). */
  replies?: string[];
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
    // "ושימי לי שעון מעורר" in the chat: the REAL phone alarm is armed off
    // alarmAt (utils/alarmPlan) — the reply carried it and this dropped it.
    ...(r.alarmAt ? { alarmAt: String(r.alarmAt).slice(0, 5), alarmState: 'planned' as const } : {}),
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
  // `replyTo`: the Meira message she is answering (long-press / ↩). Sent
  // apart from `message`, so its dates are never read as hers (27.10).
  opts: { here?: { lat: number; lng: number; label?: string }; mode?: 'voice_plan'; replyTo?: string } = {},
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
        ...(opts.replyTo ? { reply_to: opts.replyTo.slice(0, 1200) } : {}),
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
      // An alarm on a task she ALREADY has ("another alarm at 9" for the 09:30
      // call, 20.10): the merge skips ids it knows, so the alarm is set here.
      // The cloud row has no alarm column — this is the only road it takes.
      for (const t of tasks) {
        if (t.alarmAt) {
          await updateTaskFields(t.id, { alarmAt: t.alarmAt, alarmState: 'planned' }, { awaitCloud: false })
            .catch((e) => console.warn('[LumiBrain] alarm not set on', t.id, e));
          // A REAL Clock alarm now — not at the next sync (Koral, 20.10: "the
          // alarm is written but nothing is set on the phone").
          const res = await armDueAlarms([{ ...t, alarmState: 'planned' }])
            .catch((e) => { console.warn('[LumiBrain] alarm not armed', t.id, e); return null; });
          console.warn('[LumiBrain] alarm', t.alarmAt, 'for', t.id,
            res?.armed.length ? 'armed in Clock' : 'waiting (out of reach or Clock refused)');
        }
      }
      // Route them NOW — the reply is not held for Google, but the route no
      // longer waits for some other screen's sweep. See ArrivedTaskPlanner.
      planArrivedTasks(tasks).catch((e) => console.warn('[LumiBrain] routing new tasks failed', e));
    }
    // A task she already has, moved by the server ("doesn't fit → book 15:30"): the merge
    // above skips known ids, so the new hour is written here — or the day shows the old one.
    for (const m of Array.isArray(body.moved) ? body.moved : []) {
      const at = typeof m?.fixed_time === 'string' && /^\d{1,2}:\d{2}$/.test(m.fixed_time) ? m.fixed_time : null;
      if (m?.id && at) {
        await updateTaskFields(String(m.id), { fixedTime: at, scheduledTime: at }, { awaitCloud: false })
          .catch((e) => console.warn('[LumiBrain] moved task not updated', e));
      }
    }
    // "When I get to work, remind me…" (server place_reminder): kept and watched on THIS phone.
    // When Android cannot watch places yet, the reply says so instead of a promise (rule 3).
    let placeNote = '';
    if (Array.isArray(body.place_reminders) && body.place_reminders.length) {
      const he = /[\u0590-\u05FF]/.test(String(body.text ?? ''));
      try {
        const { addPlaceReminders } = await import('./GeofenceService');
        const st = await addPlaceReminders(body.place_reminders);
        if (!st.ok) {
          placeNote = he
            ? '\n⚠️ כדי שזה יעבוד צריך להפעיל "התראות לפי מיקום" (☰ › התראות) ולאשר מיקום "כל הזמן".'
            : '\n⚠️ For this to work, turn on "Nearby errands" (☰ › Alerts) and allow location "all the time".';
        }
      } catch (e) {
        console.warn('[LumiBrain] place reminder not kept', e);
        placeNote = he ? '\n⚠️ לא הצלחתי לשמור את התזכורת בטלפון — נסי שוב.' : "\n⚠️ Couldn't keep the reminder on this phone — try again.";
      }
    }
    // "…return the pc to Moshe" (29.10): WHICH Moshe is on this phone, never the server —
    // the address book does not leave it. Asked once; her answer goes back as a reply.
    let contactNote = '';
    let contactReplies: string[] = [];
    if (typeof body.contact_query === 'string' && body.contact_query.trim()) {
      const he = /[\u0590-\u05FF]/.test(String(body.text ?? ''));
      const who = body.contact_query.trim().slice(0, 40);
      try {
        const { ContactService } = await import('./ContactService');
        const match = await ContactService.getBestContactMatch(who);
        if (match) {
          // Name only: the reply text travels (👍/👎 feedback), so the number stays in the address book.
          contactNote = he
            ? `\n👤 ${who} — זה ${match.name} מאנשי הקשר?`
            : `\n👤 ${who} — is that ${match.name} from your contacts?`;
          contactReplies = [he ? `כן — ${match.name}` : `Yes — ${match.name}`, he ? `לא, ${who} אחר` : `No, another ${who}`];
        } else {
          contactNote = he ? `\n👤 לא מצאתי את ${who} באנשי הקשר — מה השם המלא?` : `\n👤 I couldn't find ${who} in your contacts — what's the full name?`;
        }
      } catch (e) {
        console.warn('[LumiBrain] contact lookup failed', e);
        contactNote = he ? `\n👤 לא הצלחתי לבדוק באנשי הקשר מי ${who}.` : `\n👤 I couldn't check your contacts for ${who}.`;
      }
    }
    const profileChanges: ProfileChange[] = Array.isArray(body.profile_changes) ? body.profile_changes : [];
    const answer = asLookupAnswer(body.answer);
    const chain = asChainAnswer(body.chain);
    const replies = [...(Array.isArray(body.replies)
      ? body.replies.filter((r: unknown) => typeof r === 'string' && r.trim()).slice(0, 3).map((r: string) => r.slice(0, 40))
      : []), ...contactReplies].slice(0, 3);
    return {
      text: String(body.text ?? '') + placeNote + contactNote, tasks, departures: body.departures ?? [],
      ...(profileChanges.length ? { profileChanges } : {}),
      ...(typeof body.type === 'string' ? { type: body.type } : {}),
      ...(answer ? { answer } : {}),
      ...(chain ? { chain } : {}),
      ...(replies.length ? { replies } : {}),
    };
  } catch (e) {
    // Rule 1: our own timeout and a dead network are different fixes.
    console.warn('[LumiBrain] turn failed',
      controller.signal.aborted ? `— no answer in ${TIMEOUT_MS / 1000}s (the server may still save it)` : '', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type Reaction = 'up' | 'down' | 'none';

/**
 * 👍 / 👎 on one Meira reply (27.10). -> true once the server kept it. False is
 * said on screen by the caller — a reaction that silently went nowhere is the
 * silent-state bug (rule 3).
 */
export async function sendReaction(
  reaction: Reaction, reply: string, question: string, messageId: string,
): Promise<boolean> {
  if (!SERVER_URL) return false;
  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch (e) {
    console.warn('[LumiBrain] reaction: no session', e);
  }
  if (!token) return false;
  try {
    const res = await fetch(`${SERVER_URL}/agent/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reaction, reply: reply.slice(0, 1200), question: question.slice(0, 1200), message_id: messageId }),
    });
    if (!res.ok) console.warn('[LumiBrain] reaction not kept:', res.status);
    return res.ok;
  } catch (e) {
    console.warn('[LumiBrain] reaction failed', e);
    return false;
  }
}
