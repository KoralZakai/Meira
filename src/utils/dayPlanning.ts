/**
 * dayPlanning — pure decision helpers for the day/week planner:
 * "will this day actually work?" (overlaps + travel that doesn't fit) and
 * "is this emailed appointment already on the calendar?".
 *
 * Lives in utils (not GoogleSync) so it can be unit-tested without the Expo
 * runtime. Dependencies: types + timeUtils only, no I/O.
 * Consumers: services/GoogleSync (analyzeWeek, getGmailEventSuggestions),
 * tests/run-day-planning.ts.
 */
import { Task, TaskLocation } from '../types/index';
import { timeToMinutes } from './timeUtils';
import { isMeetingLink } from './meetingLink';

export const locOf = (t?: Task): TaskLocation | undefined =>
  t && t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;
export const addrOf = (t?: Task): string | undefined => {
  // A Zoom/Meet URL sitting in `location` is NOT somewhere to travel to.
  // Every route, leave-home time and wake alarm flows through here, so
  // refusing a link at this one point stops the whole chain — otherwise a
  // video call gets geocoded, given a bus plan, and set an alarm.
  const raw = typeof t?.location === 'string'
    ? t.location
    : locOf(t)?.address || locOf(t)?.displayName;
  return isMeetingLink(raw) ? undefined : raw;
};
/**
 * The location as TEXT, whatever shape it is stored in.
 *
 * `Task.location` is a string on hand-typed tasks and a TaskLocation object on
 * anything that has been routed. Half the app remembered that and half called
 * `.trim()` / read `.displayName` straight off it — which is not a type warning
 * you can ignore: `.trim` on an object is a TypeError that takes the whole
 * screen down, and an object handed to a TextInput or rendered as a child is a
 * hard crash too. Anything that wants the place as words goes through here.
 *
 * Unlike addrOf this keeps meeting links: it is for showing and editing, not
 * for routing.
 */
export const locationTextOf = (t?: Task): string => {
  if (typeof t?.location === 'string') return t.location;
  const loc = locOf(t);
  return loc?.displayName || loc?.address || '';
};

/**
 * Has this task got a journey worth drawing?
 *
 * The test TimelineTravelLeg already applies before it renders anything, made
 * shared so the timeline can pick WHICH task of an overlapping pair owns the
 * leg. It used to assume the first one, so an 09:00 desk task overlapping an
 * 11:30 trip hid that trip's whole route — wake, walk, line, arrival — even
 * though it was fully planned.
 */
export const taskHasJourney = (t?: Task): boolean => {
  const loc = locOf(t);
  return Boolean(loc && (loc.leaveHomeBy || loc.transitPlan));
};

export const timeOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime;

/**
 * The gold "next important" pill's task: the first timed task that has not
 * started yet, from today through `days` days. Complete and moved rows never
 * qualify. Pure, so tests/run-next-upcoming.ts can pin it.
 */
export function pickNextUpcoming(all: Task[], now: number, today: string, days = 7): Task | null {
  const [ty, tm, td] = today.split('-').map(Number);
  const lastDay = new Date(ty, tm - 1, td + days - 1);
  const last = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;
  let best: { task: Task; when: number } | null = null;
  for (const t of all) {
    if (t.status === 'complete' || t.status === 'moved') continue;
    if (!t.date || t.date < today || t.date > last) continue;
    const time = timeOf(t);
    if (!time) continue;
    const [h, m] = time.split(':').map(Number);
    const [y, mo, d] = t.date.split('-').map(Number);
    if ([h, m, y, mo, d].some((n) => !Number.isFinite(n))) continue;
    const when = new Date(y, mo - 1, d, h, m).getTime();
    if (when <= now) continue;
    if (!best || when < best.when) best = { task: t, when };
  }
  return best?.task ?? null;
}

/** Tasks that have a clock time, earliest first. */
export function sortTimed(tasks: Task[]): Task[] {
  return tasks.filter((t) => timeOf(t)).sort((a, b) => (timeOf(a)! < timeOf(b)! ? -1 : 1));
}

/**
 * What will go wrong on this day: appointments that overlap, and gaps between
 * two places too short for the travel between them. `timed` must be sorted.
 */
export function dayWarnings(timed: Task[], he: boolean): string[] {
  const warnings: string[] = [];
  for (let k = 1; k < timed.length; k++) {
    const prev = timed[k - 1];
    const cur = timed[k];
    const prevEnd = timeToMinutes(timeOf(prev)!) + (prev.durationMinutes || 30);
    const curStart = timeToMinutes(timeOf(cur)!);
    if (curStart < prevEnd) {
      warnings.push(he
        ? `⚠️ חפיפה: "${prev.text}" ו"${cur.text}"`
        : `⚠️ Overlap: "${prev.text}" and "${cur.text}"`);
      continue;
    }
    // Travel between the two places has to fit in the gap between them.
    const travel = locOf(cur)?.travelMinutes ?? locOf(cur)?.transitPlan?.totalDurationMinutes;
    if (travel && curStart - prevEnd < travel) {
      warnings.push(he
        ? `⚠️ זמן קצר מדי בין "${prev.text}" ל"${cur.text}" (${travel} דק' נסיעה)`
        : `⚠️ Too tight between "${prev.text}" and "${cur.text}" (${travel} min travel)`);
    }
  }
  return warnings;
}

/** Words that carry no matching signal when comparing an email to a calendar entry. */
const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'your', 'with', 'at', 'on', 'for', 'and', 'to', 'of',
  'appointment', 'meeting', 'confirmation', 'reminder', 'invitation', 'event',
  'תור', 'פגישה', 'אישור', 'תזכורת', 'הזמנה', 'עם', 'של',
]);

export const titleTokens = (s: string): string[] =>
  (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE_WORDS.has(w));

/**
 * True when an emailed event is already on the calendar / task list — same day
 * and either the same clock slot (±30 min) or a clearly overlapping title.
 * Without this, every appointment that also sent a confirmation email came back
 * as "are you going?" for something the user already scheduled.
 */
export function alreadyScheduled(
  existing: Task[], ev: { title: string; date: string; time?: string },
): boolean {
  const evWords = titleTokens(ev.title);
  return existing.some((t) => {
    if (t.date !== ev.date || t.status === 'missed') return false;
    const tTime = timeOf(t);
    if (ev.time && tTime && Math.abs(timeToMinutes(tTime) - timeToMinutes(ev.time)) <= 30) return true;
    if (!evWords.length) return false;
    const tWords = new Set(titleTokens(t.text));
    return evWords.filter((w) => tWords.has(w)).length / evWords.length >= 0.6;
  });
}
