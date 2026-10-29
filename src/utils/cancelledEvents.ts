/**
 * cancelledEvents — "the invite is gone from the calendar" (19.10).
 *
 * Until now a cancelled event simply stayed: Google stops returning it, the importer only ever
 * ADDS or CORRECTS rows, and so the appointment sat on her day (with its route, its wake alarm,
 * its prep blocks) for ever. Nothing was broken; the value was wrong and unreachable
 * (silent-state rule: Lumi knew — Google no longer lists it — and did not say).
 *
 * Detecting an absence is how a calendar bug becomes a destroyed appointment, so it is strict:
 *
 *   · only rows of ONE calendar ("gcal-" Google, "dcal-" the phone's, "ocal-" Outlook) that it imported, still pending, timed, ahead;
 *   · only when Google ANSWERED for that day, for every connected account (a failed fetch is not
 *     an empty day — the caller passes nothing in that case);
 *   · never a row she moved herself (movedFromDate: Google still names the old day on purpose);
 *   · gone from TWO syncs in a row, on the same date — a move to another day re-dates the row in
 *     between and starts the count again;
 *   · and then the card ASKS before anything is removed.
 *
 * Pure. tests/run-cancelled-events.ts. Wiring: GoogleSync.syncCalendarForDate.
 */
import type { Task } from '../types/index';
import { ChangeRecord } from './changeRecord';
import { isSameMeeting } from './calendarEventTask';
import { findDayGaps } from './findGaps';
import { isInterview, subjectOf } from './interviewPrep';
import { isPrepKind } from './changeRecord';

export const MISSES_TO_CANCEL = 2;

/** The id prefix each calendar's rows carry (utils/calendarEventTask): Google, the phone's own calendars, Outlook. */
export type CalendarPrefix = 'gcal-' | 'dcal-' | 'ocal-';

/** Every day from `today` for `days` more, YYYY-MM-DD — the range the phone / Outlook read in one go. */
export function datesAhead(today: string, days: number): string[] {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: days + 1 }, (_, i) => {
    const dt = new Date(y, m - 1, d + i);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  });
}
export const MIN_FREED_MINUTES = 45;

export type MissLog = Record<string, { date: string; n: number }>;

const PREP_ID_RE = /^prep-(\d+)d-(.+)$/;

/** A row that Google could cancel: imported by the calendar, timed, still ahead, hers to lose nothing. */
export function isCancellable(t: Task, date: string, today: string, nowHHMM: string, prefix: CalendarPrefix = 'gcal-'): boolean {
  if (!(t.id || '').startsWith(prefix)) return false;
  // NOT `source === 'calendar'`: a row that has been through the cloud comes back stamped 'whatsapp'
  // (seen on the phone, 20.10), and that made every real calendar row unjudgeable. The id prefix is the
  // calendar's own mark — only the calendar import mints gcal- / dcal- / ocal- ids.
  if (t.status !== 'pending' || t.date !== date || !t.fixedTime) return false;
  if ((t as { movedFromDate?: string }).movedFromDate) return false;   // her move; Google names the old day
  if (date < today || (date === today && t.fixedTime <= nowHHMM)) return false;
  return true;
}

/**
 * Update the miss log for ONE successfully fetched day and say which rows are now confirmed gone.
 * `stored` = every stored task; `fetchedIds` = the ids Google returned for `date`.
 */
export function judgeDay(
  stored: Task[], fetchedIds: Set<string>, date: string, today: string, nowHHMM: string, log: MissLog,
  prefix: CalendarPrefix = 'gcal-',
  fetched: Task[] = [],
): { log: MissLog; cancelled: Task[] } {
  const next: MissLog = { ...log };
  const cancelled: Task[] = [];
  const onDay = stored.filter((t) => isCancellable(t, date, today, nowHHMM, prefix));
  const ids = new Set(onDay.map((t) => t.id));
  for (const t of onDay) {
    const key = t.id.slice(prefix.length);
    if (fetchedIds.has(t.id) || fetchedIds.has(key)) { delete next[t.id]; continue; }
    // The same meeting under ANOTHER id (an invite re-issued, a mirror in a second calendar — seen on the
    // phone on 20.10: the live Workday interview was "cancelled" while its twin was on screen). If anything
    // returned now, or anything else she holds, is that meeting, it is not gone.
    if (fetched.some((f) => isSameMeeting(t, f))
      || stored.some((o) => o.id !== t.id && o.status !== 'complete' && isSameMeeting(t, o))) {
      delete next[t.id]; continue;
    }
    const prev = next[t.id];
    const n = prev && prev.date === date ? prev.n + 1 : 1;
    if (n >= MISSES_TO_CANCEL) { cancelled.push(t); delete next[t.id]; } else next[t.id] = { date, n };
  }
  // A row that is no longer on a cancellable day (moved, done, deleted) forgets its misses.
  for (const id of Object.keys(next)) if (next[id].date === date && !ids.has(id)) delete next[id];
  return { log: next, cancelled };
}

/**
 * Prep blocks that were for `event` and are still ahead.
 *
 * Linked by `prepForTaskId` / the derived `prep-Nd-<id>`, AND by the words of the study block the
 * Today card books ("לימוד לקראת …" / "Study for …"): on the phone (20.10) the link field did not
 * survive a round trip through the cloud, so a study block booked for an interview was left behind
 * when that interview was removed. The title match is exact on the label the card itself writes.
 */
export function orphanPrepIds(event: Task, all: Task[], today: string, studyLabels: string[] = []): string[] {
  const labels = new Set(studyLabels.map((l) => l.trim().toLowerCase()));
  return all
    .filter((t) => t.id !== event.id && t.status === 'pending' && (t.date || '') >= today)
    .filter((t) => {
      const parent = (t as { prepForTaskId?: string }).prepForTaskId || PREP_ID_RE.exec(t.id || '')?.[2];
      if (parent === event.id) return true;
      return labels.has((t.text || '').trim().toLowerCase()) && (t.date || '') <= event.date;
    })
    .map((t) => t.id);
}

/** The window the event leaves, from the day's OTHER tasks; null when too short or already over. */
export function freedWindow(event: Task, all: Task[], today: string, nowHHMM: string) {
  const others = all.filter((t) => t.date === event.date && t.id !== event.id && t.status !== 'complete');
  const gaps = findDayGaps(others, { now: event.date === today ? nowHHMM : undefined, minMinutes: MIN_FREED_MINUTES });
  const start = event.fixedTime || '';
  const end = (() => {
    const [h, m] = start.split(':').map(Number);
    const total = h * 60 + m + (event.durationMinutes || 60);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  })();
  // The gap that contains the slot (or the one it opens into).
  const hit = gaps.find((g) => g.start <= start && g.end > start) || gaps.find((g) => g.start < end && g.end > start);
  return hit ? { start: hit.start, end: hit.end, minutes: hit.minutes } : null;
}

export function describeCancel(event: Task, all: Task[], today: string, nowHHMM: string, now = Date.now()): ChangeRecord | null {
  if (!event.fixedTime || event.date < today) return null;
  const interview = isInterview(event);
  const subject = interview ? subjectOf(event) : '';
  const name = (event.text || '').trim().slice(0, 48);
  return {
    key: `change:${event.id}:cancelled`,
    taskId: event.id,
    title: interview ? (subject ? `The ${subject} interview` : 'The interview') : name,
    titleHe: interview ? (subject ? `הראיון ב-${subject}` : 'הראיון') : name,
    kind: 'cancelled',
    before: { date: event.date, time: event.fixedTime },
    after: { date: event.date, time: event.fixedTime },
    daysDelta: 0, minutesDelta: 0,
    prep: isPrepKind(event),
    category: String(event.category || 'general'),
    freed: freedWindow(event, all, today, nowHHMM) ?? undefined,
    orphanIds: orphanPrepIds(event, all, today, [
      `לימוד לקראת ${interview ? (subject ? `הראיון ב-${subject}` : 'הראיון') : name}`,
      `Study for ${(interview ? (subject ? `the ${subject} interview` : 'the interview') : name).replace(/^./, (c) => c.toLowerCase())}`,
    ]),
    at: now,
  };
}
