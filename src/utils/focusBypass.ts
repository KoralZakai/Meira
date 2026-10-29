/**
 * focusBypass — what Meira says when a learning session is bypassed.
 *
 * Koral, 17.10: "If the user defined a learning time but somehow BYPASSES the restriction, Meira
 * lectures her: 'You said you were studying!!' and gives her further opportunities to return to
 * her studies and block out distractions."
 *
 * FOUR WAYS TO BYPASS, each with its own typed kind (silent-state rule 1: "nothing happened" and
 * "I could not tell" must never look alike):
 *
 *   permission_revoked  usage access / display-over-apps switched off mid-session
 *   service_killed      the session is still inside its window and nothing is running it
 *   slipped             a blocked app had more than a minute in front of her, inside the window
 *   ended_early         she ended it after the 10-second wait — a gentler line, not a lecture
 *
 * plus block_failed — not hers: the block screen could not be shown. Said, but not counted.
 *
 * The lecture is SHORT (Meira speaks in 1-2 sentences; the "!!" is hers) and always offers a way
 * back: resume with the block re-armed, a 5-minute break then auto-resume, move the rest to a
 * later free time, or done for today.
 *
 * Pure: no storage, no clock (nowMs is passed in), no native module — tests/run-focus-bypass.ts
 * drives every kind in both languages. The native half (noticing, measuring) is Kotlin; the glue
 * is services/FocusBypassService.ts.
 */
import type { AppLanguage, Task } from '../types/index';
import type { NativeIncident, SessionSnapshot, UsageEntry } from '../../modules/focus-guard';
import { findDayGaps, roundSlotStart } from './findGaps';
import { addMinutes, timeToMinutes, minutesToTime } from './timeUtils';
import { appOfPackage, appName, hhmmOf, localDateKey, MIN_SESSION_MINUTES } from './focusSession';

export type BypassKind =
  | 'permission_revoked' | 'service_killed' | 'slipped' | 'ended_early' | 'block_failed';

/** The kinds that are HER bypass. block_failed is ours, and is not held against her. */
export const COUNTED_KINDS: BypassKind[] = ['permission_revoked', 'service_killed', 'slipped', 'ended_early'];

/** A blocked app must be in front for MORE than this to be a slip. */
export const SLIP_THRESHOLD_MS = 60_000;
/** Below this many minutes left there is nothing worth offering back. */
export const MIN_OFFER_MINUTES = MIN_SESSION_MINUTES;
/** The break offered between a lecture and the resumed session. */
export const BREAK_MINUTES = 5;
/** A lecture older than this is stale: logged, but not shown. */
export const LECTURE_TTL_MS = 12 * 3_600_000;

/** Browsers: reported neutrally, because the domain cannot be known and studying happens there. */
export const BROWSER_PACKAGES: string[] = [
  'com.android.chrome', 'com.chrome.beta', 'com.google.android.apps.chrome',
  'org.mozilla.firefox', 'org.mozilla.firefox_beta', 'com.sec.android.app.sbrowser',
  'com.microsoft.emmx', 'com.opera.browser', 'com.opera.mini.native', 'com.brave.browser',
  'com.duckduckgo.mobile.android', 'com.vivaldi.browser', 'com.kiwibrowser.browser',
];

export interface BypassEvent {
  /** `<session id>@<start>:<kind>[:<permission>]` — one lecture per session per kind. */
  id: string;
  kind: BypassKind;
  atMs: number;
  session: SessionSnapshot;
  permission?: 'usage' | 'overlay';
  /** Minutes left in the window when it happened (ended_early, service_killed). */
  minutesLeft?: number;
  usage?: UsageEntry[];
  blockedMs?: number;
}

const KIND_OF: Record<NativeIncident['kind'], BypassKind> = {
  permission_revoked: 'permission_revoked',
  block_failed: 'block_failed',
  killed: 'service_killed',
  ended_early: 'ended_early',
  slipped: 'slipped',
};

export function eventId(session: SessionSnapshot, kind: BypassKind, permission?: string): string {
  return `${session.id}@${session.startedAtMs}:${kind}${permission ? `:${permission}` : ''}`;
}

/** One native incident → one event. Unknown kinds are dropped (a newer native than JS). */
export function eventFromIncident(inc: NativeIncident): BypassEvent | null {
  const kind = KIND_OF[inc.kind];
  if (!kind || !inc.session || typeof inc.session.endsAtMs !== 'number') return null;
  return {
    id: eventId(inc.session, kind, inc.kind === 'permission_revoked' ? inc.permission : undefined),
    kind,
    atMs: inc.atMs,
    session: inc.session,
    permission: inc.permission,
    minutesLeft: inc.minutesLeft,
    usage: inc.usage,
    blockedMs: inc.blockedMs,
  };
}

/** Several incidents → events, one per id (the first wins), oldest first. */
export function eventsFromIncidents(incidents: NativeIncident[]): BypassEvent[] {
  const seen = new Set<string>();
  const out: BypassEvent[] = [];
  for (const inc of incidents) {
    const ev = eventFromIncident(inc);
    if (!ev || seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

// ── Slips: which blocked apps were used, and for how long ──────────────────

export interface SlipApp { pkg: string; appId: string | null; ms: number; minutes: number }

export interface SlipReport {
  apps: SlipApp[];
  /** Foreground time in browsers: reported, never judged. */
  browserMinutes: number;
  /** Minutes in the blocked apps listed above. */
  totalMinutes: number;
}

const minutesOf = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/**
 * From a window's per-package foreground time, the blocked apps that were used for more than a
 * minute (TikTok's two packages count as one app) and the browsers' minutes. null when no blocked
 * app crossed the line — browser time alone is never a lecture.
 */
export function slipReport(usage: UsageEntry[] | undefined, blocked: string[]): SlipReport | null {
  if (!usage || !usage.length) return null;
  const byApp = new Map<string, SlipApp>();
  let browserMs = 0;
  for (const u of usage) {
    if (BROWSER_PACKAGES.includes(u.pkg)) { browserMs += u.ms; continue; }
    if (!blocked.includes(u.pkg)) continue;
    const app = appOfPackage(u.pkg);
    const key = app ? app.id : u.pkg;
    const cur = byApp.get(key);
    if (cur) cur.ms += u.ms;
    else byApp.set(key, { pkg: u.pkg, appId: app ? app.id : null, ms: u.ms, minutes: 0 });
  }
  const apps = [...byApp.values()]
    .filter((a) => a.ms > SLIP_THRESHOLD_MS)
    .map((a) => ({ ...a, minutes: minutesOf(a.ms) }))
    .sort((a, b) => b.ms - a.ms);
  if (!apps.length) return null;
  return {
    apps,
    browserMinutes: browserMs > SLIP_THRESHOLD_MS ? minutesOf(browserMs) : 0,
    totalMinutes: apps.reduce((n, a) => n + a.minutes, 0),
  };
}

function slipAppName(a: SlipApp, lang: AppLanguage, inForm: boolean): string {
  const app = a.appId ? appOfPackage(a.pkg) : undefined;
  if (!app) return a.pkg.split('.').slice(-1)[0];
  return inForm && lang === 'he' ? app.heIn : appName(app, lang);
}

/** "12 דק׳ באינסטגרם, 5 דק׳ בוואטסאפ" / "12 min on Instagram, 5 min on WhatsApp" (+ browsers, neutrally). */
export function slipLine(report: SlipReport, lang: AppLanguage): string {
  const he = lang === 'he';
  const shown = report.apps.slice(0, 3).map((a) => (he
    ? `${a.minutes} דק׳ ${slipAppName(a, lang, true)}`
    : `${a.minutes} min on ${slipAppName(a, lang, false)}`));
  const rest = report.apps.length - 3;
  let line = shown.join(', ');
  if (rest > 0) line += he ? ` ועוד ${rest}` : ` and ${rest} more`;
  if (report.browserMinutes > 0) {
    line += he ? ` · ועוד ${report.browserMinutes} דק׳ בדפדפן` : ` · plus ${report.browserMinutes} min in the browser`;
  }
  return line;
}

// ── The lecture ────────────────────────────────────────────────────────────

export type OfferKind = 'resume' | 'break' | 'move' | 'done';

export interface Offer {
  kind: OfferKind;
  label: string;
  /** Minutes of studying this offer gives back (0 for done). */
  minutes: number;
}

export interface MoveTarget {
  date: string;
  start: string;
  end: string;
  from: 'gap' | 'next_hour' | 'tomorrow';
}

export interface Lecture {
  eventId: string;
  kind: BypassKind;
  /** 'lecture' = "You said you were studying!!"; 'gentle' = she chose to stop, or it is not her doing. */
  tone: 'lecture' | 'gentle';
  title: string;
  body: string;
  /** A second, smaller line: what exactly was missing. */
  hint?: string;
  remainingMinutes: number;
  /** When the original window closes. */
  endsAtMs: number;
  offers: Offer[];
  /** What the "move" offer would do; present only when that offer is. */
  moveTo?: MoveTarget;
}

export function remainingMinutes(session: SessionSnapshot, nowMs: number): number {
  return Math.max(0, Math.ceil((session.endsAtMs - nowMs) / 60_000));
}

/** "19:45", or "מחר 09:00" / "tomorrow 09:00" — a date that is not today always shows (rule 4). */
export function whenLabel(t: MoveTarget, nowMs: number, lang: AppLanguage): string {
  if (t.date === localDateKey(nowMs)) return t.start;
  return lang === 'he' ? `מחר ${t.start}` : `tomorrow ${t.start}`;
}

/**
 * Where the rest of the session could go: the first free window today that holds it (starting at
 * least a quarter-hour from now), else the next full hour, else tomorrow morning. `tasks` are
 * today's; the task being moved is left out so it does not block its own new slot.
 */
export function suggestMoveTarget(
  tasks: Task[], nowMs: number, minutes: number,
  opts: { ignoreTaskId?: string | null; dayEnd?: string } = {},
): MoveTarget {
  const today = localDateKey(nowMs);
  const dayEnd = opts.dayEnd || '22:00';
  const nowHm = hhmmOf(nowMs);
  const todays = tasks.filter((t) => t.date === today && t.id !== opts.ignoreTaskId && t.status !== 'complete');
  const gaps = findDayGaps(todays, { now: addMinutes(nowHm, 15), dayEnd, minMinutes: minutes });
  for (const g of gaps) {
    const start = roundSlotStart(g.start);
    if (timeToMinutes(start) + minutes <= timeToMinutes(g.end)) {
      return { date: today, start, end: addMinutes(start, minutes), from: 'gap' };
    }
  }
  const nextHour = Math.ceil((timeToMinutes(nowHm) + 30) / 60) * 60;
  // The next full hour is a fallback, not a promise: it must still be free.
  const busyThen = todays.some((t) => {
    const s = t.fixedTime || t.scheduledTime;
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return false;
    const from = timeToMinutes(s);
    // A task at a place is followed by the trip back: that half hour is not free either.
    const hasPlace = Boolean(typeof t.location === 'string' ? t.location.trim() : (t.location?.address || t.location?.displayName));
    const until = from + (t.durationMinutes || 30) + (hasPlace ? 30 : 0);
    return nextHour < until && nextHour + minutes > from;
  });
  if (!busyThen && nextHour + minutes <= timeToMinutes(dayEnd)) {
    const start = minutesToTime(nextHour);
    return { date: today, start, end: addMinutes(start, minutes), from: 'next_hour' };
  }
  const tomorrow = localDateKey(nowMs + 24 * 3_600_000);
  return { date: tomorrow, start: '09:00', end: addMinutes('09:00', minutes), from: 'tomorrow' };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function offerLabels(lang: AppLanguage, n: number, when: string) {
  return lang === 'he'
    ? {
      resume: `📚 חזרה ללמידה — עוד ${n} דק׳, חוסמת שוב`,
      break: `☕ הפסקה של ${BREAK_MINUTES} דק׳ ואז ממשיכים`,
      move: `🕐 להעביר את השאר ל${when}`,
      done: 'סיימתי להיום',
    }
    : {
      resume: `📚 Back to learning — ${n} more min, blocking again`,
      break: `☕ ${BREAK_MINUTES}-min break, then we go on`,
      move: `🕐 Move the rest to ${when}`,
      done: "I'm done for today",
    };
}

/**
 * The lecture for one event, or null when there is nothing worth saying (a stale event, an early
 * end with a couple of minutes left, a "slip" that no blocked app backs up).
 *
 * `moveTo` is computed by the caller from the day's tasks (suggestMoveTarget); without it the
 * "move" offer is simply not made.
 */
export function lectureFor(
  ev: BypassEvent, nowMs: number, lang: AppLanguage, opts: { moveTo?: MoveTarget | null } = {},
): Lecture | null {
  if (nowMs - ev.atMs > LECTURE_TTL_MS) return null;
  const he = lang === 'he';
  const left = remainingMinutes(ev.session, nowMs);
  const ends = hhmmOf(ev.session.endsAtMs);

  let tone: Lecture['tone'] = 'lecture';
  let title = he ? '📚 אמרת שאת לומדת!!' : '📚 You said you were studying!!';
  let body = '';
  let hint: string | undefined;
  let makeUp = 0;

  switch (ev.kind) {
    case 'permission_revoked':
      body = he ? 'כיבית את החסימה.' : 'You turned the block off.';
      hint = ev.permission === 'overlay'
        ? (he ? 'חסר: הצגה מעל אפליקציות אחרות' : 'Missing: display over other apps')
        : (he ? 'חסר: גישת שימוש' : 'Missing: usage access');
      break;
    case 'service_killed':
      body = he ? 'החסימה נעצרה באמצע הלימוד.' : 'The block stopped mid-session.';
      hint = he ? 'מאירה נסגרה בזמן שלמדת.' : 'Meira was closed while you studied.';
      break;
    case 'slipped': {
      const report = slipReport(ev.usage, ev.session.blocked);
      if (!report) return null;
      body = slipLine(report, lang);
      makeUp = clamp(report.totalMinutes, 10, 45);
      break;
    }
    case 'ended_early':
      if (left < MIN_OFFER_MINUTES) return null;
      tone = 'gentle';
      title = he ? '📚 עצרת באמצע' : '📚 You stopped early';
      body = he ? `אמרת שתלמדי עד ${ends} — נשארו ${left} דק׳` : `You said you'd study until ${ends} — ${left} min left`;
      break;
    case 'block_failed':
      tone = 'gentle';
      title = he ? '📚 החסימה לא עובדת' : "📚 The block isn't working";
      body = he ? "לא מצליחה לחסום — לאפשר ׳הצגה מעל אפליקציות אחרות׳." : "I can't block — allow 'display over other apps'.";
      break;
  }

  // How much studying can be offered back: what is left of the window, or — when the window is
  // over and she slipped — the minutes she lost, so the offer is to make them up.
  const study = left >= MIN_OFFER_MINUTES ? left : makeUp;
  const moveTo = study >= 2 * MIN_OFFER_MINUTES ? (opts.moveTo ?? undefined) : undefined;
  const L = offerLabels(lang, study, moveTo ? whenLabel(moveTo, nowMs, lang) : '');
  const offers: Offer[] = [];
  if (study >= MIN_OFFER_MINUTES) offers.push({ kind: 'resume', label: L.resume, minutes: study });
  if (study >= 2 * MIN_OFFER_MINUTES) offers.push({ kind: 'break', label: L.break, minutes: study });
  if (moveTo) offers.push({ kind: 'move', label: L.move, minutes: study });
  offers.push({ kind: 'done', label: L.done, minutes: 0 });

  return {
    eventId: ev.id, kind: ev.kind, tone, title, body, hint,
    remainingMinutes: left, endsAtMs: ev.session.endsAtMs, offers, moveTo,
  };
}

const RANK: Record<BypassKind, number> = {
  slipped: 0, permission_revoked: 1, service_killed: 2, ended_early: 3, block_failed: 4,
};

/** Of several waiting events, the one to say first: the worst, and the newest of those. */
export function pickEvent(events: BypassEvent[]): BypassEvent | null {
  if (!events.length) return null;
  return [...events].sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.atMs - a.atMs)[0];
}

// ── What the offers do (as plans, for the service to carry out) ─────────────

export interface SessionPlan { startAtMs: number; endsAtMs: number; minutes: number }

/** "Back to learning": from now, until the window's end — or N minutes when the window is over. */
export function resumePlan(ev: BypassEvent, offer: Offer, nowMs: number): SessionPlan {
  const left = remainingMinutes(ev.session, nowMs);
  const endsAtMs = left >= MIN_OFFER_MINUTES ? ev.session.endsAtMs : nowMs + offer.minutes * 60_000;
  return { startAtMs: nowMs, endsAtMs, minutes: Math.max(1, Math.round((endsAtMs - nowMs) / 60_000)) };
}

/** "5-minute break": the block comes back by itself after the break, for the full minutes owed. */
export function breakPlan(offer: Offer, nowMs: number): SessionPlan {
  const startAtMs = nowMs + BREAK_MINUTES * 60_000;
  return { startAtMs, endsAtMs: startAtMs + offer.minutes * 60_000, minutes: offer.minutes };
}

// ── The weekly count ───────────────────────────────────────────────────────

export interface BypassLogEntry {
  id: string;
  /** YYYY-MM-DD — rule 4: anything dated shows its date. */
  date: string;
  kind: BypassKind;
  /** Slipped: minutes in blocked apps. Ended early: minutes that were left. Else 0. */
  minutes: number;
  atMs: number;
}

const LOG_CAP = 200;

export function logEntryFor(ev: BypassEvent): BypassLogEntry {
  let minutes = 0;
  if (ev.kind === 'slipped') minutes = slipReport(ev.usage, ev.session.blocked)?.totalMinutes ?? 0;
  else if (ev.kind === 'ended_early') minutes = ev.minutesLeft ?? 0;
  return { id: ev.id, date: localDateKey(ev.atMs), kind: ev.kind, minutes, atMs: ev.atMs };
}

/** Adds an entry once (by id) and keeps the newest LOG_CAP. */
export function appendLog(log: BypassLogEntry[], entry: BypassLogEntry): BypassLogEntry[] {
  if (log.some((e) => e.id === entry.id)) return log;
  return [...log, entry].sort((a, b) => a.atMs - b.atMs).slice(-LOG_CAP);
}

export interface WeeklySummary {
  total: number;
  byKind: Record<BypassKind, number>;
  /** Minutes spent in blocked apps during sessions this week. */
  slippedMinutes: number;
}

export function weeklySummary(log: BypassLogEntry[], nowMs: number): WeeklySummary {
  const from = nowMs - 7 * 24 * 3_600_000;
  const byKind: Record<BypassKind, number> = {
    permission_revoked: 0, service_killed: 0, slipped: 0, ended_early: 0, block_failed: 0,
  };
  let slippedMinutes = 0;
  let total = 0;
  for (const e of log) {
    if (e.atMs < from || e.atMs > nowMs || !COUNTED_KINDS.includes(e.kind)) continue;
    byKind[e.kind] += 1;
    total += 1;
    if (e.kind === 'slipped') slippedMinutes += e.minutes;
  }
  return { total, byKind, slippedMinutes };
}

/** "This week: 3 times out of learning" — '' when there were none. */
export function weeklyLine(s: WeeklySummary, lang: AppLanguage): string {
  if (s.total === 0) return '';
  if (lang === 'he') {
    return s.total === 1 ? 'השבוע: פעם אחת יצאת מהלמידה' : `השבוע: ${s.total} פעמים יצאת מהלמידה`;
  }
  return s.total === 1 ? 'This week: 1 time out of learning' : `This week: ${s.total} times out of learning`;
}
