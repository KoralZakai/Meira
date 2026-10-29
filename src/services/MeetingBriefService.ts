/**
 * MeetingBriefService — "who am I about to meet, and what should I know?"
 *
 * The next thing on the calendar is often a meeting with people the user has
 * never met. This asks the server to research the company and the person, and
 * hands the Today screen a short, sourced brief.
 *
 * WHAT STAYS ON THE PHONE. The calendar, same as Gmail: we read it with the
 * user's own Google token and post ONE event. No Google credential goes to the
 * server, and the rest of the calendar never leaves the device.
 *
 * WHAT IS DELIBERATELY CHEAP. A brief costs live web searches and a model
 * call, so:
 *   - only tasks that came FROM the calendar are briefed (a self-typed "gym"
 *     has no company to look up);
 *   - the answer is cached on the device for the life of the event, and the
 *     server caches it again by event id;
 *   - a refusal is cached too. Without that, "nothing to research" re-asked
 *     the server on every single render of the Today screen.
 *
 * INTERVIEWS (17.10) are the exception to "a refusal draws nothing". She asked
 * to be prepared for one, so `interviewBrief` / `upcomingInterviewBriefs`
 * return the refusal WITH its reason (no company on the event, search down,
 * server unreachable) and the card says it. They also look past "next up":
 * tomorrow's 13:30 interview is researched tonight, while today still has
 * things in it.
 *
 * Never throws: a failed brief must never take the Today screen down with it.
 *
 * Dependencies: GoogleService (event detail), GoogleSync (what is next),
 * LumiServer (/app/meeting/brief). Consumed by screens/TodaySchedule.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { GoogleService } from './GoogleService';
import { getNextUpcomingTask } from './GoogleSync';
import { meetingBrief, BriefEvent, MeetingBriefResult } from './LumiServer';
import { Task } from '../types/index';
// task.location is `string | TaskLocation` across the app's history; these are
// the one place that difference is handled. Re-deriving it here is how the
// TypeScript error above was first written.
import { addrOf, locOf } from '../utils/dayPlanning';
import { digestFromBrief } from '../utils/briefDigest';
import { updateTaskFields, getAllTasks } from './TaskStorage';
import { getTodayString } from '../utils/timeUtils';
import { pickEventsToBrief, pickUpcomingInterviews, prepSlotFor, PrepSlot } from '../utils/interviewBrief';
import { armTaskAlerts } from './NotificationService';
import { taskNeedsAlerts } from '../utils/alertPlan';

// v2 (17.10): the server's shape grew interview sections and new refusal reasons,
// and a v1 row can be a cached "nothing_to_research" for an event the server now
// knows how to research — it would have been believed for six more hours.
const CACHE_KEY = 'lumi.meetingBrief.v2';
/** News goes stale, and so does a role. Shorter than the server's 7 days so a
 *  device copy never outlives the server's. */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** A refusal is re-asked far sooner: search may simply have been unconfigured. */
const REFUSAL_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheRow {
  brief: MeetingBriefResult;
  fetchedAt: number;
  /** What the brief was about (title + venue). A different one makes this row stale. */
  sig?: string;
}

export interface NextMeetingBrief {
  task: Task;
  brief: MeetingBriefResult;
}

function startOf(t: Task): string {
  return locOf(t)?.leaveHomeBy || t.fixedTime || t.scheduledTime || '';
}

async function readCache(): Promise<Record<string, CacheRow>> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeCache(map: Record<string, CacheRow>): Promise<void> {
  try {
    // Keep the 20 newest — this is a convenience cache, not a store.
    const keys = Object.keys(map).sort((a, b) => map[b].fetchedAt - map[a].fetchedAt);
    const trimmed: Record<string, CacheRow> = {};
    keys.slice(0, 20).forEach((k) => { trimmed[k] = map[k]; });
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* a cache that cannot be written is not an error worth surfacing */
  }
}

function fresh(row: CacheRow | undefined): boolean {
  if (!row) return false;
  const ttl = row.brief.ok ? TTL_MS : REFUSAL_TTL_MS;
  return Date.now() - row.fetchedAt < ttl;
}

/**
 * The full calendar event behind a task, when there is one. Tasks imported
 * from Google keep only a title and a time; the description is where the
 * interviewer's name and the position actually live, so without this the
 * brief would research a company and never learn who is calling.
 */
async function eventForTask(task: Task): Promise<Partial<BriefEvent>> {
  if (!task.calendarEventId) return {};
  try {
    // The account the event came from first (its calendarName), then the
    // others — a work meeting is on the work calendar, not the first one's.
    const accounts = (await GoogleService.listGoogleAccounts()).filter((a) => a.calendar).map((a) => a.email);
    const from = (task as Task & { calendarName?: string }).calendarName;
    const order = [from, ...accounts.filter((a) => a !== from)].filter(Boolean) as string[];
    let match: Awaited<ReturnType<typeof GoogleService.fetchCalendarEvents>>['events'][number] | undefined;
    for (const account of order.length ? order : [undefined]) {
      const { events } = await GoogleService.fetchCalendarEvents(task.date, account);
      match = events.find((e) => e.id === task.calendarEventId);
      if (match) break;
    }
    if (!match) return {};
    return {
      description: match.description,
      organizer: match.organizer,
      attendees: match.attendees,
      location: match.location,
    };
  } catch {
    return {};
  }
}

/**
 * Brief for one task. `force` bypasses both caches — the card's refresh.
 * Returns null when there is nothing to show (no server, or a refusal).
 */
export async function briefForTask(task: Task, force = false): Promise<MeetingBriefResult | null> {
  const res = await resolveBrief(task, force);
  return res && res.ok ? res : null;
}

/**
 * The venue as she wrote it. `addrOf` prefers the geocoded street address,
 * which names a building and no employer; the display name is the words she
 * typed ("רפאל מכון דוד"), and for an interview the server reads the employer
 * out of exactly those words.
 */
function placeNameOf(task: Task): string | undefined {
  return locOf(task)?.displayName || addrOf(task);
}

/** Requests in flight, so two screens asking for one task make ONE server call. */
const inflight = new Map<string, Promise<MeetingBriefResult | null>>();

/**
 * The server's answer for one task, REFUSALS INCLUDED — null only when the
 * server could not be asked. briefForTask hides refusals (a gym has no card);
 * an interview must not, because "no brief" and "no company on the event" are
 * different sentences to say to someone who asked to be prepared.
 */
async function resolveBrief(task: Task, force: boolean): Promise<MeetingBriefResult | null> {
  const id = `${task.calendarEventId || task.id}|${force ? 'f' : 'n'}`;
  const running = inflight.get(id);
  if (running) return running;
  const p = fetchBrief(task, force).finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
}

async function fetchBrief(task: Task, force: boolean): Promise<MeetingBriefResult | null> {
  const key = task.calendarEventId || task.id;
  // What the brief was ABOUT. Editing the venue or the title makes a cached
  // brief about the wrong employer, and the event id did not change.
  const sig = `${task.text}|${placeNameOf(task) ?? ''}`;
  const cache = await readCache();
  if (!force && fresh(cache[key]) && cache[key].sig === sig) {
    const cached = cache[key].brief;
    if (!cached.ok) return cached;
    // Attach on the cached path too. A brief is fetched once and then read
    // from cache for three days, so if the first attach failed — the task not
    // saved yet, storage busy — the research would sit in the cache, correct,
    // and never reach the task or the alerts again until it expired.
    // attachBrief is a no-op when the task already carries this same brief, so
    // this costs one comparison on the common path.
    await attachBrief(task, cached).catch(() => {});
    return cached;
  }

  const detail = await eventForTask(task);
  const organizer = detail.organizer || task.contact?.email;
  const event: BriefEvent = {
    id: task.calendarEventId || task.id,
    title: task.text,
    date: task.date,
    time: startOf(task),
    location: detail.location || placeNameOf(task),
    description: detail.description,
    organizer,
    attendees: detail.attendees,
    category: task.category,
    // What the two of them have already said to each other. Read here, on the
    // phone, with her own token, and sent as at most four subject lines — the
    // mailbox itself never reaches the server. Without this the brief can say
    // what Ceva does and not that she already promised to send her CV.
    history: await historyFor(organizer, detail.attendees),
    // And the last time they MET — "what did we cover" is the first minute of a call.
    previous: await previousFor(task, organizer, detail.attendees),
  };

  const result = await meetingBrief(event, force);
  if (!result) return null;   // server unreachable — cache nothing

  cache[key] = { brief: result, fetchedAt: Date.now(), sig };
  await writeCache(cache);
  if (!result.ok) return result;

  // ONTO THE TASK. "inside the task, edit the task and insert a summery and
  // reminders" — a brief drawn on one card, on one screen, for the single next
  // meeting is one she has to go and look for, and the alerts have no way to
  // reach it at all. Stored here it survives the screen, and the night-before
  // and hour-before alerts read it straight off the task.
  await attachBrief(task, result).catch(() => {});
  return result;
}

export interface InterviewBrief {
  task: Task;
  /** Always an answer: `ok: false` carries the reason, never a bare null. */
  brief: MeetingBriefResult;
  /** The study block already on her calendar for this interview, if there is one. */
  prep: PrepSlot | null;
}

/**
 * The brief for one INTERVIEW, whatever came back. A server that could not be
 * reached becomes `{ ok: false, reason: 'unreachable' }` — not cached, so the
 * next focus asks again — because the card has to say why there is nothing,
 * and "null" says nothing.
 */
export async function interviewBrief(task: Task, force = false): Promise<MeetingBriefResult> {
  try {
    return (await resolveBrief(task, force)) ?? { ok: false, reason: 'unreachable' };
  } catch (e) {
    console.warn('[MeetingBrief] interview brief failed', task.id, e);
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * Briefs for the interviews coming up (today's still ahead, then tomorrow's and
 * the day after's — at most two, utils/interviewBrief). Safe on every Today
 * focus: a cached answer costs one AsyncStorage read, and a refusal is cached
 * for six hours.
 *
 * TRIGGER (CLAUDE.md rule 7). The Today screen calls this: on focus, on a
 * picked day, and when a calendar sync lands something while she is there.
 * What it does NOT have is a caller for "app open elsewhere" and "app closed":
 * the brief for tomorrow's interview is made when she opens Today, not the
 * evening before with the phone in her pocket. The owner of that trigger is
 * CalendarAutoSync (app root heartbeat + background task): after an import
 * that adds or changes an interview, or on the evening before one, it should
 * call this. It is safe to call from there — cached, deduped, never throws.
 *
 * `onProgress` hears each interview as it finishes, so the first chip does not
 * wait for the second interview's research (each can take most of a minute).
 */
export async function upcomingInterviewBriefs(
  force = false,
  onProgress?: (soFar: InterviewBrief[]) => void,
): Promise<{ briefs: InterviewBrief[]; error?: string }> {
  try {
    const all = await getAllTasks();
    const now = Date.now();
    const today = getTodayString();
    const nowHHMM = new Date(now).toTimeString().slice(0, 5);
    const briefs: InterviewBrief[] = [];
    // One after another, not together: each is up to six searches and a model
    // call, and a server that is down should fail once, not twice at once.
    for (const task of pickUpcomingInterviews(all, now, today)) {
      briefs.push({
        task,
        brief: await interviewBrief(task, force),
        prep: prepSlotFor(task, all, today, nowHHMM),
      });
      onProgress?.([...briefs]);
    }
    return { briefs };
  } catch (e) {
    // A failed read of her tasks is not "no interviews" (rule 1): `error` says
    // so, and the caller keeps what it already showed instead of clearing it.
    console.warn('[MeetingBrief] upcoming interviews unreadable', e);
    return { briefs: [], error: 'tasks_unreadable' };
  }
}

/**
 * Every calendar event of tomorrow (and the rest of today) that is not an
 * interview: researched the evening before, so the day-before alert can say who
 * the call is with and what was covered last time (18.10, Koral: mandatory for
 * EVERY event, not only interviews).
 *
 * Only what came from a calendar (an id prefix gcal- / dcal- / ocal-, or a
 * calendarEventId) — a self-typed "gym" has nobody to look up. The server
 * refuses cheaply (no model call) when an event names no company, person or
 * history, and a refusal is cached 6 h, so this is safe on every sweep. At most
 * MAX_EVENT_BRIEFS, one after another.
 */
export async function upcomingEventBriefs(force = false): Promise<{ briefed: number; error?: string }> {
  try {
    const all = await getAllTasks();
    const today = getTodayString();
    const t = new Date(`${today}T00:00:00`);
    t.setDate(t.getDate() + 1);
    const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const nowHHMM = new Date().toTimeString().slice(0, 5);
    let briefed = 0;
    for (const task of pickEventsToBrief(all, today, tomorrow, nowHHMM)) {
      const res = await resolveBrief(task, force).catch((e) => {
        console.warn('[MeetingBrief] event brief failed for', task.id, e);
        return null;
      });
      if (res && res.ok) briefed += 1;
    }
    return { briefed };
  } catch (e) {
    console.warn('[MeetingBrief] tomorrow\'s events unreadable', e);
    return { briefed: 0, error: 'tasks_unreadable' };
  }
}

/**
 * Her email with the people in this meeting.
 *
 * The organiser first: on an ATS invite that is the person actually running
 * the call. Attendees are a fallback and are capped, because a twelve-person
 * invite is not twelve mailbox searches.
 */
async function historyFor(
  organizer?: string, attendees?: string[],
): Promise<BriefEvent['history']> {
  const addresses = [organizer, ...(attendees || [])]
    .map((a) => String(a || '').trim())
    .filter((a) => a.includes('@'))
    .slice(0, 2);
  if (!addresses.length) return undefined;
  const rows: NonNullable<BriefEvent['history']> = [];
  // Every mailbox she connected for its mail: the thread with a recruiter may
  // be in the work inbox. Capped — four rows is the whole card.
  const boxes = (await GoogleService.listGoogleAccounts().catch(() => [])).filter((a) => a.mail).map((a) => a.email);
  outer: for (const box of boxes.length ? boxes : [undefined]) {
    for (const address of addresses) {
      const found = await GoogleService.gmailHistoryWith(address, 3, box).catch(() => []);
      rows.push(...found);
      if (rows.length >= 4) break outer;
    }
  }
  return rows.length ? rows.slice(0, 4) : undefined;
}

/**
 * Earlier calendar events with the same people (or the same title) before this
 * one, from the account the event lives on first. Said when it could not be read
 * (rule 2): a lookup that failed is not "there was no earlier meeting".
 */
async function previousFor(
  task: Task, organizer?: string, attendees?: string[],
): Promise<BriefEvent['previous']> {
  const me = new Set((await GoogleService.listGoogleAccounts().catch(() => [])).map((a) => a.email.toLowerCase()));
  const others = [organizer, ...(attendees || [])]
    .map((a) => String(a || '').trim())
    .filter((a) => a.includes('@') && !me.has(a.toLowerCase()))
    .slice(0, 3);
  const from = (task as Task & { calendarName?: string }).calendarName;
  const { meetings, error } = await GoogleService.previousMeetingsWith(others, task.text, task.date, from);
  if (error) console.warn('[MeetingBrief] earlier meetings not read:', error);
  return meetings.length ? meetings : undefined;
}

/**
 * Write the brief onto the task and re-arm its alerts so the night-before and
 * hour-before notifications carry it.
 *
 * Re-arming is the load-bearing half: alerts are planned when the task is
 * saved or routed, which is almost always BEFORE the research exists. Without
 * this the brief would sit on the task, correct and unmentioned, and the
 * notification the night before would say what it always said.
 */
async function attachBrief(task: Task, result: MeetingBriefResult): Promise<void> {
  const digest = digestFromBrief(result as any);
  if (!digest) return;
  // Unchanged research is not worth re-arming for: re-planning alerts cancels
  // and re-creates every notification on the task, and doing that on each
  // Today-screen focus is how alerts got duplicated before.
  const existing = task.brief;
  if (existing
    && existing.headlineHe === digest.headlineHe
    && existing.headlineEn === digest.headlineEn
    && existing.linesEn.join('|') === digest.linesEn.join('|')) return;

  await updateTaskFields(task.id, { brief: digest } as any);
  const withBrief = { ...task, brief: digest } as Task;
  if (taskNeedsAlerts(withBrief)) await armTaskAlerts(withBrief).catch(() => {});
}

/**
 * The next upcoming meeting and its brief, or null when the next thing is not
 * a meeting worth researching. Safe to call on every Today-screen focus: a
 * cached answer costs one AsyncStorage read.
 */
export async function nextMeetingBrief(force = false): Promise<NextMeetingBrief | null> {
  try {
    const task = await getNextUpcomingTask(7);
    if (!task) return null;
    const brief = await briefForTask(task, force);
    return brief ? { task, brief } : null;
  } catch {
    return null;
  }
}
