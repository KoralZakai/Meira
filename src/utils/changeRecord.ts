/**
 * changeRecord — "the calendar moved something of hers": what happened, in her words (19.10).
 *
 * Koral's pick "1": a short card on Today — the title, the old time struck through → the new
 * one, and one line on what it gives or costs her. This file decides whether a move is worth
 * a card, and what the card says. Pure; the store is services/ChangeRecordStore and the card
 * is components/ChangeCards. tests/run-change-record.ts.
 *
 * WHEN IT FIRES — only a move that matters to her day:
 *   · the day changed, or the hour changed by 15 minutes or more;
 *   · the event has not already passed (neither the old nor the new moment);
 *   · it is not a prep block (those follow their interview by themselves, and a card about
 *     the card's own consequence is noise).
 * A move she made herself never reaches here: moveHeld keeps it, and GoogleSync only calls
 * this when GOOGLE changed the row.
 *
 * It states a fact, not a booking: nothing here says "I put study time in" — that is only said
 * by the code that saved it (silent-state rule 3).
 */
import type { Task } from '../types/index';
import type { AppLanguage } from '../types/index';
import { isInterview, isPrepBlock, subjectOf } from './interviewPrep';

export const MIN_SHIFT_MINUTES = 15;

export type ChangeKind = 'later' | 'earlier' | 'sameDay' | 'cancelled';

export interface Moment { date: string; time?: string }

export interface ChangeRecord {
  /** `change:<taskId>:<afterDate>:<afterTime>` — one card per new state; a re-import of the same state is not new. */
  key: string;
  taskId: string;
  title: string;
  titleHe: string;
  kind: ChangeKind;
  before: Moment;
  after: Moment;
  /** Whole days between the two dates (negative = earlier). 0 for a same-day shift. */
  daysDelta: number;
  /** Same-day shift in minutes (negative = earlier). */
  minutesDelta: number;
  /** An interview / exam / class: the change is about preparation time. */
  prep: boolean;
  /** The task's category, so the server judges "does this need preparing for" on the real one. */
  category: string;
  at: number;
  /** A cancelled event: the window it left free, and the prep blocks that were for it. */
  freed?: { start: string; end: string; minutes: number };
  orphanIds?: string[];
  /** When the card was first drawn on screen. Seen = no notification about it (utils/changeNudge). */
  seenAt?: number;
  /** Where the offer on the card has got to. Absent = nothing answered yet. */
  ui?: ChangeUi;
}

/** The card's own progress, kept so a booked or declined offer never comes back as chips. */
export interface ChangeUi {
  stage: 'study' | 'morning' | 'fill' | 'done';
  /** What was done, in her language, said only after it saved. */
  line?: string;
  /** The wake-up hours to offer next (from the server), until answered. */
  morning?: string[];
  /** The freed window's date, once the cancelled event is removed (the fill offer needs it). */
  fillDate?: string;
}

const EXAM = /exam|\bquiz\b|מבחן|בחינה|בוחן/i;

function mins(t?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

const clock = (t?: string) => (t ? t.slice(0, 5) : undefined);

export function isPrepKind(task: Task): boolean {
  return isInterview(task) || task.category === 'class' || task.category === 'course'
    || EXAM.test(task.text || '');
}

/** The change, or null when it needs no card. `today` is YYYY-MM-DD, `nowHHMM` HH:MM. */
export function describeChange(
  before: Pick<Task, 'date' | 'fixedTime'> | null | undefined,
  after: Task,
  today: string,
  nowHHMM: string,
  now: number = Date.now(),
): ChangeRecord | null {
  if (!before?.date || !after?.date) return null;
  if (after.status === 'complete' || isPrepBlock(after)) return null;
  const b: Moment = { date: before.date, time: clock(before.fixedTime) };
  const a: Moment = { date: after.date, time: clock(after.fixedTime) };
  const daysDelta = dayNumber(a.date) - dayNumber(b.date);
  const bm = mins(b.time); const am = mins(a.time);
  const minutesDelta = daysDelta === 0 && bm !== null && am !== null ? am - bm : 0;
  if (daysDelta === 0 && Math.abs(minutesDelta) < MIN_SHIFT_MINUTES) return null;
  // Nothing to say about something already over, or moved into the past.
  const passed = (m: Moment) => m.date < today || (m.date === today && !!m.time && m.time <= nowHHMM);
  if (passed(a)) return null;
  const kind: ChangeKind = daysDelta === 0 ? 'sameDay' : daysDelta > 0 ? 'later' : 'earlier';
  const interview = isInterview(after);
  const subject = interview ? subjectOf(after) : '';
  const name = (after.text || '').trim().slice(0, 48);
  return {
    key: `change:${after.id}:${a.date}:${a.time ?? ''}`,
    taskId: after.id,
    title: interview ? (subject ? `The ${subject} interview` : 'The interview') : name,
    titleHe: interview ? (subject ? `הראיון ב-${subject}` : 'הראיון') : name,
    kind, before: b, after: a, daysDelta, minutesDelta,
    prep: isPrepKind(after), category: String(after.category || 'general'), at: now,
  };
}

/** A card about something that has since passed (or whose event is over) is dropped. */
export function isStillOpen(r: ChangeRecord, today: string): boolean {
  return r.after.date >= today;
}

const WEEKDAY_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "ג׳ 20.10 13:00" — always dated, never "tomorrow" (rule 4: a card from yesterday must not read as today's). */
export function momentLabel(m: Moment, language: AppLanguage): string {
  const [y, mo, d] = m.date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, (mo || 1) - 1, d || 1)).getUTCDay();
  const day = language === 'he' ? WEEKDAY_HE[wd] : WEEKDAY_EN[wd];
  return `${day} ${d}.${mo}${m.time ? ` ${m.time}` : ''}`;
}

/** The one line under the times: what it gives, or costs. Facts only. */
export function effectLine(r: ChangeRecord, language: AppLanguage): string {
  const he = language === 'he';
  if (r.kind === 'cancelled') return cancelledLine(r, language);
  const n = Math.abs(r.daysDelta);
  if (r.kind === 'sameDay') {
    const m = Math.abs(r.minutesDelta);
    const span = m >= 60 && m % 60 === 0 ? (he ? `${m / 60} שעות` : `${m / 60} h`) : (he ? `${m} דקות` : `${m} min`);
    return r.minutesDelta > 0
      ? (he ? `מאוחר ב-${span} · הוזז ביומן` : `${span} later · moved in your calendar`)
      : (he ? `מוקדם ב-${span} · הוזז ביומן` : `${span} earlier · moved in your calendar`);
  }
  if (r.prep && r.kind === 'later') {
    return n === 1
      ? (he ? 'הוזז ביומן · יש לך עוד יום להתכונן' : 'Moved in your calendar · one more day to prepare')
      : (he ? `הוזז ביומן · יש לך עוד ${n} ימים להתכונן` : `Moved in your calendar · ${n} more days to prepare`);
  }
  if (r.prep && r.kind === 'earlier') {
    return n === 1
      ? (he ? 'הוזז ביומן · יש לך יום פחות להתכונן' : 'Moved in your calendar · one day less to prepare')
      : (he ? `הוזז ביומן · יש לך ${n} ימים פחות להתכונן` : `Moved in your calendar · ${n} days less to prepare`);
  }
  return he ? 'הוזז ביומן' : 'Moved in your calendar';
}

export function headline(r: ChangeRecord, language: AppLanguage): string {
  if (r.kind === 'cancelled') return language === 'he' ? `${r.titleHe} בוטל` : `${r.title} was cancelled`;
  return language === 'he' ? `${r.titleHe} הוזז` : `${r.title} moved`;
}

/** What a cancellation leaves her with: a free window, and prep for something that is not happening. */
function cancelledLine(r: ChangeRecord, language: AppLanguage): string {
  const he = language === 'he';
  const parts = [he ? 'בוטל ביומן' : 'Cancelled in your calendar'];
  if (r.freed) parts.push(he ? `פנוי ${r.freed.start}–${r.freed.end}` : `Free ${r.freed.start}–${r.freed.end}`);
  const n = r.orphanIds?.length ?? 0;
  if (n) parts.push(he ? (n === 1 ? 'יש הכנה אחת שלו' : `יש ${n} הכנות שלו`) : (n === 1 ? 'one prep block was for it' : `${n} prep blocks were for it`));
  return parts.join(' · ');
}
