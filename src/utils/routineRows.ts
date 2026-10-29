/**
 * routineRows — her routines that belong on the day on screen, as rows of
 * their own (6.10, her pick "A": "🔁 20:30–21:30 Kickboxing · routine
 * [✓ Going] [Not today]").
 *
 * Until now a routine reached Today only as one idea among many, inside a free
 * window she had to open — "why doesn't Meira take my routines into account
 * and offer them in the schedule?". A row is drawn for a routine she TOLD us
 * (her notes or the chat, not a pattern guessed from history) that has an
 * hour, falls on this weekday, is not already a task that day, has not been
 * waved off for this date, and — today — has not ended. Its hour is not free.
 *
 * Pure: the screen loads routines and skips; this only decides.
 * Consumed by screens/TodaySchedule. Tested by tests/run-routine-rows.ts.
 */
import { Task } from '../types/index';
import { Routine, routineConcept, routinesForDate, sameRoutine, alreadyPlanned, addressInRoutine, nameBeforeAddress, stripDaysPhrase, readDays } from './routines';
import { addMinutes, timeToMinutes } from './timeUtils';

export interface RoutineRow {
  routine: Routine;
  start: string;
  end: string;
  /** Her words without the hours and the address: "קיקבוקס". */
  title: string;
  address?: string;
  /** Stable across reloads — what "Not today" remembers. */
  key: string;
}

const TIME_RE = /\d{1,2}[:.]\d{2}(?:\s*[-–—]\s*\d{1,2}[:.]\d{2})?/g;

export function routineTitle(r: Routine): { title: string; address?: string } {
  // Without the days Meira wrote in ("· ימי ג׳"): the row's key, and so a
  // "Not today" already given, must survive her answering which days.
  const text = stripDaysPhrase(r.text);
  const address = addressInRoutine(text) || undefined;
  const base = (address && nameBeforeAddress(text, address)) || text;
  const title = base.replace(TIME_RE, ' ').replace(/\s{2,}/g, ' ').replace(/[\s,·\-–—]+$/u, '').trim();
  return { title: title || text, address };
}

/**
 * A workout is a 💪 whatever line it came from. A routine can arrive with a
 * category its text does not support (history, the chat, an older parse), and
 * the card is drawn — and "go to it" saved as a task — from this field.
 */
function honestCategory(r: Routine, title: string): Routine {
  const fitness = routineConcept(r.text) === 'fitness' || routineConcept(title) === 'fitness';
  return fitness && r.category !== 'gym' ? { ...r, category: 'gym' } : r;
}

export function routineRowsFor(
  routines: Routine[],
  date: string,
  tasks: Task[],
  opts: { now?: string; skipped?: string[] } = {},
): RoutineRow[] {
  const dayTasks = tasks.filter((t) => t.date === date && t.status !== 'moved');
  const seen = new Set<string>();
  const rows: RoutineRow[] = [];
  for (const r of routinesForDate(routines, date)) {
    if (r.kind !== 'habit' || r.source !== 'notes' || !r.time) continue;
    // "Changes weekly": no fixed day to stand on — it is offered in free windows instead.
    if (r.daysFrom === 'varies') continue;
    const { title, address } = routineTitle(r);
    const key = `${title.toLowerCase()}|${r.time}`;
    if (seen.has(key) || opts.skipped?.includes(key)) continue;
    if (alreadyPlanned(r, dayTasks) || alreadyPlanned({ ...r, text: title }, dayTasks)) continue;
    const end = addMinutes(r.time, r.durationMinutes || 60);
    if (opts.now && timeToMinutes(end) <= timeToMinutes(opts.now)) continue;
    seen.add(key);
    const row: RoutineRow = { routine: honestCategory(r, title), start: r.time, end, title, address, key };
    // The same workout said five ways is ONE card (11.10). The fuller line
    // wins — an address beats none, days beat none — and on a tie the later
    // one, which is what she said last; an address the winner lacks is kept.
    const twin = rows.findIndex((x) => sameRoutine(x.routine, r));
    if (twin < 0) { rows.push(row); continue; }
    const score = (x: RoutineRow) => (x.address ? 2 : 0) + (x.routine.weekdays.length ? 1 : 0);
    const keep = score(row) >= score(rows[twin]) ? row : rows[twin];
    // The title is the plainest of the tellings: "אימון", not the tail of a
    // spoken sentence ("work out and" — 11.10).
    const plain = [keep.title, row.title, rows[twin].title].filter((t) => t.trim().length > 1)
      .sort((x, y) => x.length - y.length)[0] ?? keep.title;
    // The card shows the plainest title ("אימון") but keeps the WINNING line's
    // routine — and with it that line's category. When the winner was the
    // spoken one ("work out and…") the card read "אימון" under a 💼 (15.10).
    // The category follows what the card IS, not which telling won.
    rows[twin] = {
      ...keep,
      routine: honestCategory(keep.routine, plain),
      title: plain,
      address: keep.address ?? row.address ?? rows[twin].address,
    };
  }
  return rows.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
}

/**
 * One routine per thing she does. The same line in both texts is one routine
 * that lives in both; and a line with no day is dropped when the same routine
 * (title + hour) is written elsewhere WITH its days — she has already said.
 * Used by GapFillService.loadRoutines; tested by tests/run-routine-days-question.ts.
 */
export function mergeRoutineSources(routines: Routine[]): Routine[] {
  const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
  const byText = new Map<string, Routine>();
  for (const r of routines) {
    const k = norm(r.text);
    const had = byText.get(k);
    if (had) had.origin = [...new Set([...(had.origin || []), ...(r.origin || [])])];
    else byText.set(k, { ...r, origin: [...(r.origin || [])] });
  }
  const all = [...byText.values()];
  // "קיקבוקס בשלישי" and "קיקבוקס" are the same routine: compare without the day words.
  const DAY_WORDS = /^(?:ימי|יום|ביום|בימי|כל|every|on)$/i;
  const keyOf = (r: Routine) => {
    const words = routineTitle(r).title.toLowerCase().split(/\s+/)
      .filter((w) => w && !DAY_WORDS.test(w) && !readDays(w).days.length);
    return `${words.join(' ')}|${r.time || ''}`;
  };
  const saidKeys = new Set(all.filter((r) => r.time && r.daysFrom === 'said').map(keyOf));
  return all.filter((r) => !(r.time && r.daysFrom === 'unsaid' && saidKeys.has(keyOf(r))));
}
