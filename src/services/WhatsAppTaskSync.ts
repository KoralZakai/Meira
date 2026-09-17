/**
 * WhatsAppTaskSync — pulls tasks Lumi saved from the user's WhatsApp chat into
 * the app. The WhatsApp server and the app do NOT share a database: the server
 * stores WhatsApp tasks keyed by phone number, the app stores its own tasks
 * locally + in Supabase keyed by login id. This read-through bridges them using
 * the WhatsApp number the user entered in the app (settings.whatsAppPhone).
 *
 * Dependencies: EXPO_PUBLIC_SERVER_URL (the Fly backend), TaskStorage.getSettings
 * (the phone) + mergeExternalTasks (non-destructive merge by stable id).
 * Consumed by useTasks on load. Server endpoint: GET /tasks/{phone} in server/main.py.
 */
import { getSettings, mergeExternalTasks } from './TaskStorage';
import { authedFetch } from './serverAuth';
import { Task, TaskCategory, TaskPriority, TaskStatus } from '../types/index';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

/**
 * The floor between two pulls of the same list.
 *
 * The log showed `pulling from …/tasks/972500000000` 53 times in 200 lines,
 * each answering with all 121 tasks. The callers are all legitimate — mount,
 * and every return to the foreground — so rather than hunt for whichever one
 * fires most, the pull itself refuses to repeat work. A task typed in WhatsApp
 * is not more than half a minute stale, and the phone stops re-downloading the
 * whole list to discover nothing changed.
 */
const MIN_PULL_INTERVAL_MS = 30 * 1000;
let lastPullAt = 0;

/**
 * Map a server task row (snake_case, DB or memory) into an app Task.
 *
 * The WHERE comes across too. It used to be dropped: the server row for "יוגה
 * ב-11:00 ביגאל אלון 94" carries the address, the leave time and the route it
 * planned, and none of it was copied — so a trip arranged in WhatsApp landed in
 * the app as a bare line of text with no destination. No destination means no
 * entry in Trips, no leave time, no wake alarm and nothing for the travel chain
 * to re-plan, which is most of what Lumi is for.
 */
function mapRow(r: any): Task | null {
  if (!r || !r.text || !r.id) return null;
  const fixedTime = r.fixed_time ? String(r.fixed_time).slice(0, 5) : undefined; // HH:MM:SS -> HH:MM
  const rawDate = String(r.date || '').slice(0, 10);
  const date = rawDate || new Date().toISOString().slice(0, 10);
  // Either shape is accepted: the server sends an object for a routed place and
  // a plain string for one it only knows by name.
  const location = r.location ?? undefined;
  const hasPlace = typeof location === 'string'
    ? Boolean(location.trim())
    : Boolean(location && (location.address || location.displayName));
  return {
    id: String(r.id),
    text: String(r.text),
    category: (r.category ?? 'general') as TaskCategory,
    priority: (r.priority ?? 'need_to') as TaskPriority,
    isFixed: Boolean(fixedTime),
    fixedTime,
    scheduledTime: fixedTime,
    durationMinutes: r.duration_minutes ?? 30,
    date,
    status: (r.status ?? 'pending') as TaskStatus,
    // The stamp comes across with the status, or the app manufactures the very
    // shape it uses to detect foreign writes: `status:'complete'` with
    // `completedAt` empty. Ten rows on her phone looked server-written for a
    // month partly because this mapper dropped it. A complete row with no
    // stamp from the server still gets one, so "done, and we don't know when"
    // never masquerades as "done by something that isn't the app".
    completedAt: r.completedAt ?? (r.status === 'complete' ? Date.now() : undefined),
    source: 'whatsapp',
    // The batch label the server stamps on tasks that arrived in one message
    // (server/task_grouping) — dropping it here is what made eight design
    // tasks show up as eight unrelated notes on the task board.
    subgroup: r.subgroup ?? undefined,
    // "תעירי אותי ב-7" said over WhatsApp. The REAL phone alarm is armed by
    // this app, off alarmAt — so a request that never crossed the bridge could
    // only ever become a chat reminder that pings without ringing.
    alarmAt: r.alarmAt ?? undefined,
    ...(r.alarmAt ? { alarmState: 'planned' as const } : {}),
    location,
    hasLocation: hasPlace,
    createdAt: Date.now(),
    historicalDurations: [],
  } as Task;
}

/**
 * Fetch the user's WhatsApp tasks and merge new ones into local storage.
 * No-ops (returns 0) when the server URL or WhatsApp number isn't set, or on
 * any network error — this must never block the normal local task load.
 */
export async function pullWhatsAppTasks({ force = false } = {}): Promise<number> {
  if (!force && Date.now() - lastPullAt < MIN_PULL_INTERVAL_MS) return 0;
  // Runs for signed-in users too: the Supabase mirror needs the phone→account
  // link (app_settings.whatsAppPhone) to resolve server-side, and until it does
  // the pull is the only bridge. mergeExternalTasks dedups by shared UUID and
  // honors local dismissals, so double delivery is safe.
  const settings = await getSettings();
  const rawPhone = String(settings.whatsAppPhone || '').trim();
  const phone = rawPhone.replace(/\D/g, '');
  if (!SERVER_URL || !phone) {
    console.warn('[WhatsAppTaskSync] skipped: missing server url or phone', { SERVER_URL, phone });
    return 0;
  }
  // Stamped before the request, not after: two pulls that start together must
  // not both get through while the first is still in flight.
  lastPullAt = Date.now();
  try {
    const url = `${SERVER_URL}/tasks/${phone}`;
    console.log('[WhatsAppTaskSync] pulling from', url);
    // Authenticated now: the server returns the CALLER'S tasks, resolved from
    // the Supabase token, and 403s if `phone` names a different account.
    // Signed out -> null -> nothing to pull, and the local list is untouched.
    const res = await authedFetch(url);
    if (!res) {
      console.warn('[WhatsAppTaskSync] skipped: not signed in');
      return 0;
    }
    if (!res.ok) {
      console.warn('[WhatsAppTaskSync] server returned non-ok', { status: res.status, url });
      return 0;
    }
    const body = await res.json();
    const mapped = (body.tasks ?? []).map(mapRow).filter((t: Task | null): t is Task => t !== null);
    console.log('[WhatsAppTaskSync] merged tasks', { count: mapped.length, source: body.source });
    return await mergeExternalTasks(mapped);
  } catch (e) {
    console.warn('[WhatsAppTaskSync] pull failed', e);
    return 0;
  }
}
