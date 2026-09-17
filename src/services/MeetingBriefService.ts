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
 * Never throws: a failed brief must never take the Today screen down with it.
 *
 * Dependencies: GoogleService (event detail), GoogleSync (what is next),
 * LumiServer (/app/meeting/brief). Consumed by screens/TodaySchedule.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleService } from './GoogleService';
import { getNextUpcomingTask } from './GoogleSync';
import { meetingBrief, BriefEvent, MeetingBriefResult } from './LumiServer';
import { Task } from '../types/index';
// task.location is `string | TaskLocation` across the app's history; these are
// the one place that difference is handled. Re-deriving it here is how the
// TypeScript error above was first written.
import { addrOf, locOf } from '../utils/dayPlanning';
import { digestFromBrief } from '../utils/briefDigest';
import { updateTaskFields } from './TaskStorage';
import { armTaskAlerts } from './NotificationService';
import { taskNeedsAlerts } from '../utils/alertPlan';

const CACHE_KEY = 'lumi.meetingBrief.v1';
/** News goes stale, and so does a role. Shorter than the server's 7 days so a
 *  device copy never outlives the server's. */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** A refusal is re-asked far sooner: search may simply have been unconfigured. */
const REFUSAL_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheRow {
  brief: MeetingBriefResult;
  fetchedAt: number;
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
    const events = await GoogleService.getCalendarEventsToday(task.date);
    const match = events.find((e) => e.id === task.calendarEventId);
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
  const key = task.calendarEventId || task.id;
  const cache = await readCache();
  if (!force && fresh(cache[key])) {
    const cached = cache[key].brief;
    if (!cached.ok) return null;
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
    location: detail.location || addrOf(task),
    description: detail.description,
    organizer,
    attendees: detail.attendees,
    // What the two of them have already said to each other. Read here, on the
    // phone, with her own token, and sent as at most four subject lines — the
    // mailbox itself never reaches the server. Without this the brief can say
    // what Ceva does and not that she already promised to send her CV.
    history: await historyFor(organizer, detail.attendees),
  };

  const result = await meetingBrief(event, force);
  if (!result) return null;   // server unreachable — say nothing, cache nothing

  cache[key] = { brief: result, fetchedAt: Date.now() };
  await writeCache(cache);
  if (!result.ok) return null;

  // ONTO THE TASK. "inside the task, edit the task and insert a summery and
  // reminders" — a brief drawn on one card, on one screen, for the single next
  // meeting is one she has to go and look for, and the alerts have no way to
  // reach it at all. Stored here it survives the screen, and the night-before
  // and hour-before alerts read it straight off the task.
  await attachBrief(task, result).catch(() => {});
  return result;
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
  for (const address of addresses) {
    const found = await GoogleService.gmailHistoryWith(address, 3).catch(() => []);
    rows.push(...found);
    if (rows.length >= 4) break;
  }
  return rows.length ? rows.slice(0, 4) : undefined;
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
