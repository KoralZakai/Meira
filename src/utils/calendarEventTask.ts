/**
 * One calendar event → one Meira task, whichever calendar it came from.
 *
 * Google (REST), the phone's own calendars (expo-calendar: Samsung, Outlook
 * app, Exchange, family calendars) and Outlook / Teams through Microsoft Graph
 * all land here, so an interview is an interview — 🎯, `must`, prep days, a
 * journey — no matter which app she booked it in. Before this, the mapping
 * lived inside GoogleSync, and a second calendar would have had to copy it
 * and then drift from it.
 *
 * Pure: no storage, no network. Node-testable (tests/run-calendar-sources.ts).
 */
import { sharesAName } from './nameSkeleton';
import { categoryForCalendarEvent } from './categorize';
import { isOnlineOnlyPlace } from './meetingLink';
import type { CalendarEvent, Task } from '../types/index';

/** Where an event came from. The id prefix carries it, so it survives storage. */
export type CalendarProvider = 'google' | 'device' | 'outlook';

const PREFIX: Record<CalendarProvider, string> = {
  google: 'gcal-',
  device: 'dcal-',
  outlook: 'ocal-',
};

// "Microsoft Teams Meeting" is not a place — the rule and its regex moved to
// meetingLink, which isRemoteTask needs it from; re-exported for old imports.
export { isOnlineOnlyPlace };

/** Which calendar a stored task came from, read off its id. */
export function providerOfTaskId(id: string): CalendarProvider | null {
  for (const [p, prefix] of Object.entries(PREFIX)) {
    if (id.startsWith(prefix)) return p as CalendarProvider;
  }
  return null;
}

/** Duration in minutes between two HH:MM times (>= 15). */
export function diffMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(15, eh * 60 + em - (sh * 60 + sm));
}

/**
 * The stored id. Google's own id is already per-occurrence (singleEvents=true);
 * the phone's calendar provider hands every occurrence of a weekly meeting the
 * SAME id, so a recurring device or Outlook event is keyed by its date too —
 * or the second Tuesday would be "already imported" and never appear.
 */
export function calendarTaskId(provider: CalendarProvider, eventId: string, date: string, recurring = false): string {
  return `${PREFIX[provider]}${eventId}${recurring ? `@${date}` : ''}`;
}

export function calendarEventToTask(
  e: CalendarEvent,
  date: string,
  provider: CalendarProvider = 'google',
  opts: { recurring?: boolean; calendarName?: string } = {},
): Task {
  // The title is the one field nobody controls. An invitation called
  // "Ceva — Marika Klubakov" says nothing, while its body says "An in-person
  // interview has been scheduled for you". Both are read.
  const label = categoryForCalendarEvent({
    title: e.title,
    description: e.description,
    organizer: e.organizer,
    hasMeetingUrl: Boolean(e.meetingUrl),
  });
  // A video link, or a location that only NAMES a video service, is not
  // somewhere you can stand. `location` keeps only a real place.
  const place = e.location && !isOnlineOnlyPlace(e.location) ? e.location : undefined;
  const id = calendarTaskId(provider, e.id, date, opts.recurring);
  if (e.allDay) {
    // A whole day or a range (vacation, a conference): no hour, so no route,
    // no leave time and no wake alarm — a strip above the day (utils/allDay).
    const start = e.startDate || date;
    return {
      id: calendarTaskId(provider, e.id, start, opts.recurring),
      text: e.title,
      isFixed: false,
      allDay: true,
      date: start,
      endDate: e.endDate && e.endDate > start ? e.endDate : undefined,
      durationMinutes: 24 * 60,
      status: 'pending',
      source: 'calendar',
      calendarEventId: provider === 'google' ? e.id : `${provider}:${e.id}`,
      location: place,
      hasLocation: Boolean(place),
      calendarName: opts.calendarName,
      category: label.category,
      priority: label.priority,
      createdAt: Date.now(),
      historicalDurations: [],
    } as unknown as Task;
  }
  return {
    id,
    text: e.title,
    isFixed: true,
    fixedTime: e.startTime,
    scheduledTime: e.startTime,
    durationMinutes: diffMinutes(e.startTime, e.endTime),
    date,
    status: 'pending',
    source: 'calendar',
    // Google keeps its raw id: MeetingBriefService looks it up on Google.
    // Other providers are namespaced so two calendars can never share one.
    calendarEventId: provider === 'google' ? e.id : `${provider}:${e.id}`,
    location: place,
    hasLocation: Boolean(place),
    meetingUrl: e.meetingUrl,
    attendees: e.attendees,
    calendarName: opts.calendarName,
    category: label.category,
    priority: label.priority,
    createdAt: Date.now(),
    historicalDurations: [],
  } as unknown as Task;
}

/** Lower-case, no punctuation, no emoji: "Meeting — Nebius team!" ≈ "meeting nebius team". */
function normTitle(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The same meeting seen through two doors.
 *
 * A work meeting sits in Outlook AND is mirrored into Google; the phone shows
 * both. Importing both gives her two identical blocks, a clash with herself,
 * and two leave-home alarms. Same day, same start, same words = one meeting.
 * Deliberately strict: two different meetings at 10:00 must both survive.
 */
export function isSameMeeting(
  a: { date: string; fixedTime?: string; text: string },
  b: { date: string; fixedTime?: string; text: string },
): boolean {
  if (a.date !== b.date || !a.fixedTime || a.fixedTime !== b.fixedTime) return false;
  const ta = normTitle(a.text);
  const tb = normTitle(b.text);
  return Boolean(ta) && (ta === tb || (ta.length >= 6 && tb.length >= 6 && (ta.includes(tb) || tb.includes(ta)))
    // …or the same person in two scripts: "שיחה עם סגית" typed by her and
    // "Sagit/Koral- intro" from Google, same minute (1.10).
    || sharesAName(a.text, b.text));
}

const EXTERNAL_ID = /^(gcal|dcal|ocal)-/;
const isExternalRow = (t: any): boolean => EXTERNAL_ID.test(String(t?.id || ''))
  || t?.source === 'calendar' || t?.source === 'email';

/**
 * One card per meeting, whatever doors it came through. Her own row wins — her
 * words, her ✓ — and borrows what the calendar knows better: the end time, the
 * link, who is coming, and the event id it now answers for. The calendar twin
 * stays in storage, unseen: `twinIds` names it.
 */
export function collapseSameMeetings<T extends { id: string; date: string; fixedTime?: string; text: string }>(
  tasks: T[],
): T[] {
  const out: T[] = [];
  for (const t of tasks) {
    const i = out.findIndex((x) => isSameMeeting(x, t));
    if (i === -1) { out.push(t); continue; }
    const [mine, theirs] = isExternalRow(out[i]) && !isExternalRow(t) ? [t, out[i]] : [out[i], t];
    const ext: any = isExternalRow(theirs) ? theirs : null;
    out[i] = {
      ...mine,
      ...(ext && ext.durationMinutes ? { durationMinutes: ext.durationMinutes } : {}),
      meetingUrl: (mine as any).meetingUrl || (theirs as any).meetingUrl,
      attendees: (mine as any).attendees || (theirs as any).attendees,
      calendarEventId: (mine as any).calendarEventId || (ext ? ext.calendarEventId || ext.id : undefined),
      twinIds: [...((mine as any).twinIds || []), theirs.id],
    } as T;
  }
  return out;
}

/**
 * Drop incoming events that another calendar already put in her day.
 * `existing` is the store; an incoming row whose own id is already there is
 * kept (that is a re-sync of the same event, and reconcile owns it).
 */
export function withoutDuplicates<T extends { id: string; date: string; fixedTime?: string; text: string }>(
  incoming: T[],
  existing: Array<{ id: string; date: string; fixedTime?: string; text: string; status?: string }>,
): { kept: T[]; duplicates: T[] } {
  const kept: T[] = [];
  const duplicates: T[] = [];
  for (const t of incoming) {
    const clash = existing.find((x) => x.id !== t.id && x.status !== 'deleted' && isSameMeeting(x, t))
      || kept.find((x) => isSameMeeting(x, t));
    if (clash) duplicates.push(t);
    else kept.push(t);
  }
  return { kept, duplicates };
}
