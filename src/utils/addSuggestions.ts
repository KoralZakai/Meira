/**
 * addSuggestions — "Suggested for you", the list under an EMPTY Add input.
 *
 * Koral, 17.10: the + opens with ideas, not a blank box. Four sources, all of
 * them things the app already knows:
 *
 *   tomorrow  what tomorrow asks of tonight — prep for an interview that has
 *             none yet, lights-out for a 06:15 wake
 *   way       errands that sit ON a journey already planned (the places
 *             OnYourWayCard finds, server/errands_along.py)
 *   gap       a free window today, and what GapFillService would put in it
 *   open      something still open, offered a time that fits it
 *
 * THIS FILE IS THE RANKING AND NOTHING ELSE. The screen fetches the sources
 * (storage, the server, the clock) and hands them in as `SourceResult`s; this
 * decides what is worth a row, in what order, and what a tap does. No device,
 * no network, no clock of its own — tests/run-add-suggestions.ts drives it.
 *
 * THE SILENT-STATE RULE, applied. A source that could not be read is not an
 * empty source: it comes back as `{ ok: false, reason }`, contributes NO row
 * (never a made-up one), and is reported in `skipped` so the screen can warn
 * with the reason. "Nothing to suggest" and "the server said no" must not look
 * alike in the log.
 *
 * "Ranked by time relevance": a row's score is a base for its source plus how
 * near its moment is to NOW. Prep and lights-out belong to the evening; a gap
 * that opens in ten minutes beats one at four o'clock; an errand she passes at
 * 17:40 matters at 16:00, not at 09:00.
 */
import type { Task } from '../types/index';
import { addMinutes, minutesToTime, timeToMinutes } from './timeUtils';
import { isInterview, isPrepBlock, subjectOf } from './interviewPrep';
import { dayWakeOwner } from './alarmPlan';
import { rankOpenTasks } from './openTaskRank';

export type SuggestionSource = 'tomorrow' | 'way' | 'gap' | 'open';

/** What one tap does. */
export type SuggestionAction =
  /** Put these words (and the day / hour) in the input; she presses Add. */
  | { kind: 'prefill'; text: string; textHe?: string; time?: string; date?: string }
  /** Move an EXISTING task to this day and hour. */
  | { kind: 'schedule'; taskId: string; date: string; time: string; durationMinutes?: number }
  /** An existing open task with no window today that holds it: open it, so she picks when. */
  | { kind: 'open'; taskId: string }
  /** An existing errand gets this place, on the journey that passes it. */
  | {
    kind: 'place'; taskId: string; date: string; time: string; durationMinutes?: number;
    place: { name: string; address?: string; lat: number; lng: number };
  };

export interface Suggestion {
  id: string;
  source: SuggestionSource;
  icon: string;
  title: string;
  titleHe: string;
  /** WHY — one short clause, never a paragraph. */
  why: string;
  whyHe: string;
  action: SuggestionAction;
  score: number;
}

/** A source either answered (possibly with nothing) or could not. */
export type SourceResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface GapIdeaFact {
  title: string;
  titleHe: string;
  reason: string;
  reasonHe: string;
  icon: string;
  minutes: number;
  /** An existing task to pull into the window… */
  taskId?: string;
  /** …or the words of a new one. */
  draftText?: string;
}

export interface GapFact {
  start: string;
  end: string;
  minutes: number;
  /** What GapFillService would offer for it, best first. */
  ideas: GapIdeaFact[];
  /** Where she will be when the window opens (the previous task's place, else home) — open tasks nearer to it rank higher. */
  anchor?: { lat: number; lng: number };
}

export interface WayFact {
  task: { id: string; text: string };
  candidate: {
    name: string; address?: string; lat: number; lng: number;
    pass_at: string; date: string; off_route_m: number; open_when_passing: boolean | null;
    minutes?: number;
  };
}

export interface SuggestionInput {
  /** Her clock: today's date and the time now. */
  now: { date: string; time: string };
  /** The day she is adding to (the + on a timeline can be on another day). */
  target: string;
  /** Today's tasks — the prep a tonight-block would duplicate lives here. */
  today?: SourceResult<Task[]>;
  tomorrow?: SourceResult<Task[]>;
  /** Pending tasks of the next 7 days after tomorrow — the interviews further out (17.10). */
  upcoming?: SourceResult<Task[]>;
  way?: SourceResult<WayFact[]>;
  gaps?: SourceResult<GapFact[]>;
  open?: SourceResult<Task[]>;
  /** Wake-rule inputs from her profile (alarmPlan.wakeInputs). */
  wake?: { usualWakeTime?: string; routineMinutes?: number };
}

export interface SuggestionResult {
  rows: Suggestion[];
  /** Sources that could not be read, with why — the screen warns on each. */
  skipped: Array<{ source: SuggestionSource; reason: string }>;
}

/** How many rows, in total and per source. */
// Koral, 17.10: "Meira should recommend finishing the open tasks — prep for
// tomorrow's interview, for Monday's, send the CV, keep working on Meira — not
// only the place nearby." Open work gets the most rows; interviews come first.
export const MAX_ROWS = 6;
const PER_SOURCE: Record<SuggestionSource, number> = { tomorrow: 3, way: 1, gap: 1, open: 4 };

/** A wake at or before this is "early" — worth going to bed for. */
export const EARLY_WAKE = '07:00';
/** Sleep she needs, to work lights-out backwards from the alarm. */
export const SLEEP_MINUTES = 8 * 60;
/** Prep for tomorrow's interview starts here in the evening, or at the next 5 minutes. */
export const PREP_EVENING = '19:00';
export const PREP_MINUTES = 45;

const BASE: Record<SuggestionSource, number> = { tomorrow: 60, way: 50, gap: 40, open: 30 };

// ── tiny time helpers ───────────────────────────────────────────────────────

const mins = (hhmm: string): number => timeToMinutes(hhmm);
const ceil5 = (hhmm: string): string => minutesToTime(Math.ceil(mins(hhmm) / 5) * 5);
/**
 * Which day a time belongs to, when it is not today (CLAUDE.md rule 4: anything
 * from another day shows that day): "at " for today, "tomorrow at " / "on 21.10 at ".
 */
function dayWord(date: string, now: SuggestionInput['now'], he: boolean): string {
  if (date === now.date) return he ? 'ב-' : 'at ';
  if (date === plusOneDay(now.date)) return he ? 'מחר ב-' : 'tomorrow at ';
  const [, m, d] = date.split('-').map(Number);
  return he ? `ב-${d}.${m} ב-` : `on ${d}.${m} at `;
}
/** A clock range that reads left to right even inside Hebrew text: 14:05–15:30. */
const span = (a: string, b: string): string => `\u200E${a}–${b}\u200E`;

function plusOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Minutes from now until `hhmm` on `date` (negative = gone). */
function minutesUntil(now: SuggestionInput['now'], date: string, hhmm: string): number {
  const dayDelta = date === now.date ? 0 : date > now.date ? (date === plusOneDay(now.date) ? 1 : 2) : -1;
  return dayDelta * 1440 + mins(hhmm) - mins(now.time);
}

const asLoc = (t: Task): { leaveHomeBy?: string; wakeUpBy?: string } | undefined =>
  t.location && typeof t.location === 'object' ? (t.location as any) : undefined;

// ── tomorrow ────────────────────────────────────────────────────────────────

/** Does anything already prepare for this interview (tonight's block, the D-1 one)? */
function hasPrepFor(interview: Task, pool: Task[], now?: SuggestionInput['now']): boolean {
  return pool.some((p) => isPrepBlock(p) && p.status !== 'missed' && p.status !== 'complete'
    // A block that has already begun (today, before now) is not "prep still
    // planned" — the 19:00 review at 19:12 must not hide tomorrow's prep (17.10).
    && !(now && p.date === now.date && (p.fixedTime || p.scheduledTime)
      && mins((p.fixedTime || p.scheduledTime) as string) <= mins(now.time))
    && ((p as { prepForTaskId?: string }).prepForTaskId === interview.id
      || String(p.id || '').endsWith(interview.id)));
}

export function tomorrowSuggestions(
  tomorrow: Task[],
  /** Today's tasks, or null when they could not be read — then NO prep is proposed,
   *  because a block we cannot see might already be there. */
  today: Task[] | null,
  now: SuggestionInput['now'],
  wake?: SuggestionInput['wake'],
): Suggestion[] {
  const out: Suggestion[] = [];
  const nowMin = mins(now.time);
  const pending = tomorrow.filter((t) => t.status === 'pending');

  // 1. Prep for an interview that has no prep yet.
  for (const t of today ? pending.filter((x) => isInterview(x)) : []) {
    if (hasPrepFor(t, [...(today as Task[]), ...tomorrow], now)) continue;
    const at = nowMin <= mins(PREP_EVENING) ? PREP_EVENING : ceil5(now.time);
    // Not after 22:00: a prep block that ends past bedtime is not a suggestion.
    if (mins(at) + PREP_MINUTES > 22 * 60) continue;
    const subject = subjectOf(t);
    const when = (t.fixedTime || t.scheduledTime) ? ` ${t.fixedTime || t.scheduledTime}` : '';
    out.push({
      id: `tomorrow-prep-${t.id}`,
      source: 'tomorrow',
      icon: '🎯',
      title: `Prep for tomorrow's ${subject} interview`,
      titleHe: `הכנה לראיון ב${subject} מחר`,
      why: `Interview tomorrow${when} · nothing planned yet`,
      whyHe: `ראיון מחר${when} · עוד לא תכננתי הכנה`,
      action: {
        kind: 'prefill',
        text: `Prep for the ${subject} interview`,
        textHe: `הכנה לראיון ב${subject}`,
        time: at,
        date: now.date,
      },
      // The evening before is when this matters.
      score: BASE.tomorrow + (nowMin >= 17 * 60 ? 30 : nowMin >= 14 * 60 ? 15 : -20) + 10,
    });
  }

  // 2. Lights-out for an early wake.
  const owner = dayWakeOwner(pending, wake ?? {});
  if (owner && mins(owner.at) <= mins(EARLY_WAKE)) {
    const lightsOut = minutesToTime(mins(owner.at) - SLEEP_MINUTES);
    // Only while it can still be tonight's lights-out.
    if (mins(lightsOut) > mins(owner.at) && mins(lightsOut) > nowMin - 30) {
      const t = pending.find((x) => x.id === owner.taskId);
      const leave = t ? asLoc(t)?.leaveHomeBy : undefined;
      const what = t ? t.text.slice(0, 32) : '';
      out.push({
        id: `tomorrow-lights-${owner.at}`,
        source: 'tomorrow',
        icon: '🌙',
        title: `Lights out by ${lightsOut}`,
        titleHe: `לישון עד ${lightsOut}`,
        why: `Up at ${owner.at}${leave ? ` · leave ${leave}` : ''}${what ? ` for ${what}` : ''}`,
        whyHe: `קמים ב-${owner.at}${leave ? ` · יוצאים ב-${leave}` : ''}${what ? ` ל${what}` : ''}`,
        action: { kind: 'prefill', text: 'Lights out', textHe: 'ללכת לישון', time: lightsOut, date: now.date },
        // It is an evening thing: before 15:00 it is noise.
        score: BASE.tomorrow + (nowMin >= 20 * 60 ? 40 : nowMin >= 18 * 60 ? 20 : nowMin >= 15 * 60 ? -5 : -40),
      });
    }
  }
  return out;
}

/**
 * Interviews 2–7 days out (Monday's Workday interview, seen from Saturday):
 * a prep row each, sooner first. The time is tonight's evening slot or the
 * next 5 minutes, like tomorrow's; the row says which day the interview is.
 */
export function upcomingInterviewSuggestions(
  upcoming: Task[], pool: Task[] | null, now: SuggestionInput['now'],
): Suggestion[] {
  if (!pool) return [];
  const out: Suggestion[] = [];
  const nowMin = mins(now.time);
  const at = nowMin <= mins(PREP_EVENING) ? PREP_EVENING : ceil5(now.time);
  if (mins(at) + PREP_MINUTES > 22 * 60) return out;
  for (const t of upcoming.filter((x) => x.status === 'pending' && isInterview(x))) {
    if (hasPrepFor(t, [...pool, ...upcoming], now)) continue;
    const days = daysBetween(now.date, t.date);
    if (days < 2 || days > 7) continue;
    const subject = subjectOf(t);
    const [, m, d] = t.date.split('-').map(Number);
    const when = `${d}.${m}${(t.fixedTime || t.scheduledTime) ? ` ${t.fixedTime || t.scheduledTime}` : ''}`;
    out.push({
      id: `upcoming-prep-${t.id}`,
      source: 'tomorrow',
      icon: '🎯',
      title: `Prep for the ${subject} interview (${when})`,
      titleHe: `הכנה לראיון ב${subject} (${when})`,
      why: `Interview in ${days} days · nothing planned yet`,
      whyHe: `ראיון בעוד ${days} ימים · עוד אין הכנה`,
      action: { kind: 'prefill', text: `Prep for the ${subject} interview`, textHe: `הכנה לראיון ב${subject}`, time: at, date: now.date },
      score: BASE.tomorrow + 40 - days * 4,
    });
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = (b || a).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// ── way ─────────────────────────────────────────────────────────────────────

export function waySuggestions(facts: WayFact[], now: SuggestionInput['now']): Suggestion[] {
  const out: Suggestion[] = [];
  for (const f of facts) {
    const c = f.candidate;
    if (c.open_when_passing === false) continue;           // closed when she passes — not a suggestion
    const away = minutesUntil(now, c.date, c.pass_at);
    if (away < 0) continue;                                // she has passed it already
    const open = c.open_when_passing === true;
    out.push({
      id: `way-${f.task.id}-${c.name}`,
      source: 'way',
      icon: '🛣️',
      title: `${f.task.text} — ${c.name}`,
      titleHe: `${f.task.text} — ${c.name}`,
      why: `On your way ${dayWord(c.date, now, false)}${c.pass_at}${open ? ", open" : ", hours unknown"} · ${c.off_route_m} m off route`,
      whyHe: `בדרך ${dayWord(c.date, now, true)}${c.pass_at}${open ? ", פתוח" : ", שעות לא ידועות"} · ${c.off_route_m} מ׳ מהמסלול`,
      action: {
        kind: 'place', taskId: f.task.id, date: c.date, time: c.pass_at,
        durationMinutes: c.minutes,
        place: { name: c.name, address: c.address, lat: c.lat, lng: c.lng },
      },
      // Near in time matters most; an unknown-hours place is worth a bit less.
      score: BASE.way + (away <= 90 ? 50 - away / 3 : away <= 240 ? 15 : 0) + (open ? 4 : 0),
    });
  }
  return out;
}

// ── gaps ────────────────────────────────────────────────────────────────────

export function gapSuggestions(
  gaps: GapFact[], target: string, now: SuggestionInput['now'],
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const g of gaps) {
    const idea = g.ideas[0];
    if (!idea) continue;
    const at = ceil5(g.start);
    const away = minutesUntil(now, target, at);
    const proximity = away <= 60 ? 30 : away <= 180 ? 15 : -10;
    const text = idea.draftText || idea.title;
    out.push({
      id: `gap-${target}-${at}-${idea.taskId ?? text}`,
      source: 'gap',
      icon: idea.icon || '💡',
      title: idea.title,
      titleHe: idea.titleHe || idea.title,
      why: `Free ${span(at, g.end)} · ${idea.reason}`.slice(0, 90),
      whyHe: `פנוי ${span(at, g.end)} · ${idea.reasonHe || idea.reason}`.slice(0, 90),
      action: idea.taskId
        ? { kind: 'schedule', taskId: idea.taskId, date: target, time: at, durationMinutes: idea.minutes || undefined }
        : { kind: 'prefill', text, textHe: idea.draftText ? undefined : idea.titleHe, time: at, date: target },
      score: BASE.gap + proximity + Math.min(5, Math.floor(g.minutes / 30)),
    });
  }
  return out;
}

// ── open tasks ──────────────────────────────────────────────────────────────

export function openSuggestions(
  open: Task[], gaps: GapFact[], target: string, now: SuggestionInput['now'],
): Suggestion[] {
  const out: Suggestion[] = [];
  const todayIsTarget = target === now.date;
  // Deadline, importance and place decide the order (utils/openTaskRank) — not the date alone.
  const anchor = gaps.find((g) => g.anchor)?.anchor;
  const ranked = rankOpenTasks(
    open.filter((t) => t.status === 'pending' && !isPrepBlock(t)),
    { today: now.date, nowHHMM: now.time, anchor },
  );
  const sorted = ranked.map((r) => r.task);
  const why = new Map(ranked.map((r) => [r.task.id, r]));
  for (const t of sorted) {
    const rk = why.get(t.id)!;
    const need = (t.durationMinutes || 30) + 10;                       // her 10-minute buffer
    const gap = gaps.find((g) => g.minutes >= need
      && (!todayIsTarget || mins(g.start) >= mins(now.time) - 5));
    const overdue = (t.date || '') < now.date;
    if (!gap) {
      // No window holds it today — still worth saying (17.10: "all the other
      // open tasks too"). The tap opens the task, so she picks when.
      const [, m, d] = (t.date || now.date).split('-').map(Number);
      out.push({
        id: `open-${t.id}`,
        source: 'open',
        icon: '📝',
        title: t.text,
        titleHe: t.text,
        why: `${overdue ? `Left over from ${d}.${m}` : rk.reason} · no free window today — pick a time`,
        whyHe: `${overdue ? `נשאר מ-${d}.${m}` : rk.reasonHe} · אין היום חלון פנוי — לבחור שעה`,
        action: { kind: 'open', taskId: t.id },
        score: BASE.open - 5 + rk.score,
      });
      continue;
    }
    const at = ceil5(gap.start);
    const away = minutesUntil(now, target, at);
    out.push({
      id: `open-${t.id}`,
      source: 'open',
      icon: '📝',
      title: `${t.text} · ${at}`,
      titleHe: `${t.text} · ${at}`,
      why: `${overdue && rk.reason === 'Left over' ? 'Left over from ' + t.date : rk.reason} · fits ${span(gap.start, gap.end)}`,
      whyHe: `${overdue && rk.reasonHe === 'נשאר מקודם' ? 'נשאר מ-' + t.date : rk.reasonHe} · נכנס ב-${span(gap.start, gap.end)}`,
      action: {
        kind: 'schedule', taskId: t.id, date: target, time: at, durationMinutes: t.durationMinutes || 30,
      },
      score: BASE.open + rk.score + (away <= 120 ? 10 : 0),
    });
  }
  return out;
}

// ── the list ────────────────────────────────────────────────────────────────

/** Rank everything the screen managed to read. Never throws, never invents. */
export function rankSuggestions(input: SuggestionInput, limit = MAX_ROWS): SuggestionResult {
  const skipped: SuggestionResult['skipped'] = [];
  const rows: Suggestion[] = [];

  const need = <T>(source: SuggestionSource, r: SourceResult<T> | undefined): T | null => {
    if (!r) return null;                       // the screen did not ask for it
    if (!r.ok) { skipped.push({ source, reason: r.reason }); return null; }
    return r.data;
  };

  const tomorrow = need('tomorrow', input.tomorrow);
  // Today's tasks only tell tomorrow's prep what already exists. If they cannot
  // be read, say so — and propose no prep rather than risk a duplicate of a
  // block we cannot see (lights-out does not need them).
  const today = input.today ? need('tomorrow', input.today) : [];
  if (tomorrow) rows.push(...tomorrowSuggestions(tomorrow, today, input.now, input.wake));
  const upcoming = input.upcoming ? need('tomorrow', input.upcoming) : null;
  if (upcoming) rows.push(...upcomingInterviewSuggestions(upcoming, today, input.now));
  const way = need('way', input.way);
  if (way) rows.push(...waySuggestions(way, input.now));

  const gaps = need('gap', input.gaps);
  if (gaps) rows.push(...gapSuggestions(gaps, input.target, input.now));

  const open = need('open', input.open);
  // An open task with a window that holds it is offered that time; without one
  // it is still offered, and the tap opens it to pick a time (17.10).
  if (open) rows.push(...openSuggestions(open, gaps ?? [], input.target, input.now));

  // One row per thing: the gap source and the open source can both reach for
  // the same task; the better-ranked one stays.
  const key = (s: Suggestion) =>
    ('taskId' in s.action ? `task:${s.action.taskId}` : `id:${s.id}`);
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const perSource: Record<string, number> = {};
  const kept: Suggestion[] = [];
  for (const s of rows) {
    if (seen.has(key(s))) continue;
    if ((perSource[s.source] ?? 0) >= PER_SOURCE[s.source]) continue;
    seen.add(key(s));
    perSource[s.source] = (perSource[s.source] ?? 0) + 1;
    kept.push(s);
    if (kept.length >= limit) break;
  }
  return { rows: kept, skipped };
}

/** End time of a suggestion's block, for the toast ("until 15:45"). */
export function actionEnd(a: SuggestionAction): string | undefined {
  const minutes = 'durationMinutes' in a ? a.durationMinutes : undefined;
  const time = 'time' in a ? a.time : undefined;
  return time && minutes ? addMinutes(time, minutes) : undefined;
}

// ── is this open task an errand? ────────────────────────────────────────────

/**
 * The words that make a to-do an ERRAND at a business — a mirror of the rule
 * table in server/errands_along.py (`_RULES`), so the phone only asks the
 * server about tasks the server will accept. (The server answers rules_only
 * requests from this same table and says "not_an_errand" to the rest.)
 */
const ERRAND_RES: RegExp[] = [
  /(?:^|\s)(?:לתקן|תיקון|fix|repair)\s/i,
  /חבילה|דואר|parcel|package|post office/i,
  /כביסה|ניקוי יבש|laundry|dry clean/i,
  /תספורת|מספרה|haircut|barber/i,
  /להדפיס|הדפסה|\bprint\b/i,
  /שכפול מפתח|key cut|copy a key/i,
  /שטיפת רכב|לשטוף את הרכב|car wash/i,
  /בית מרקחת|תרופ|pharmacy|prescription/i,
  /סופר|מכולת|groceries|supermarket/i,
  /מתנה|\bgift\b/i,
  /(?:^|\s)(?:לקנות|buy)\s/i,
];

export function looksLikeErrand(text: string): boolean {
  const t = String(text || '');
  return ERRAND_RES.some((re) => re.test(t));
}

/** A pending task that is an errand with no place yet — the "on your way" candidates. */
export function placelessErrands(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === 'pending' && !isPrepBlock(t) && looksLikeErrand(t.text)
    && !(t.location && (typeof t.location === 'string' ? t.location.trim()
      : (t.location.address || t.location.displayName))));
}
