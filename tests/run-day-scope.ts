/**
 * run-day-scope — the day on screen is the day things are written to.
 *
 * Koral, 2026-09-22, looking at TOMORROW's timeline: "check why i cannot press
 * on adding tasks before tomorrow interview? … i press on add but nothing
 * happen."
 *
 * The button worked. Every one of them wrote to TODAY:
 *
 *     const handlePickGapIdea = async (idea, gap) => {
 *       await applyGapIdea(idea, gap, getTodayString());   // ← not dateKey
 *     };
 *     onAddOwn={(g) => navigation.navigate('AddTask', { initialTime: g.start })}
 *     suggestForGap(gap, { today: getTodayString(), … })
 *
 * So tapping "Add" on an idea in tomorrow's 11:00 window created the task on
 * today at 11:00 — an hour that had already gone — and tomorrow, the day she
 * was looking at, was unchanged. Nothing threw, nothing was empty, the store
 * grew by one row. From the outside: a dead button. And when the idea was an
 * EXISTING task, it was silently moved off its day onto today.
 *
 * This is wiring, not arithmetic, so there is no pure function to put a test
 * on — but there is a rule, and the rule is checkable: on a screen that draws
 * an arbitrary day, `getTodayString()` may decide whether the day IS today. It
 * may never be the day something is written to.
 *
 *   npx tsx tests/run-day-scope.ts
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
};

const root = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

console.log('\n1. TodaySchedule draws a chosen day, so it must write to one\n');

const today = read('src/screens/TodaySchedule.tsx');

// The two calls that put something INTO a day.
ok(/applyGapIdea\(idea, gap, dateKey\)/.test(today),
  'tapping "Add" on an idea applies it to the day on screen');
ok(!/applyGapIdea\([^)]*getTodayString\(\)/.test(today),
  'and never to today regardless of the day on screen');

// Ranking, too: ideas for tomorrow's window are about tomorrow's list.
ok(/suggestForGap\(gap, \{\s*today: dateKey/.test(today),
  'gap ideas are ranked against the day the gap belongs to');

// Every route into Add Task carries the day it was pressed on.
const navs = today.match(/navigation\.navigate\(\s*\n?\s*'AddTask',\s*\{[^}]*\}/g) ?? [];
ok(navs.length >= 2, `both + routes into Add Task were found`, `${navs.length}`);
for (const nav of navs) {
  ok(/initialDate/.test(nav), 'the + carries initialDate', nav.replace(/\s+/g, ' ').slice(0, 70));
}

console.log('\n2. Add Task honours the day it was opened on\n');

const addTask = read('src/screens/AddTaskScreen.tsx');
ok(/addMorningTasksFromSpeech\(trimmed, initialDate\)/.test(addTask),
  'the LLM path is given the day, not just the sentence');
ok(/addManualTask\(trimmed, \{ \.\.\.\(extra \?\? \{\}\), date: initialDate \}\)/.test(addTask),
  'and so is the manual fallback');
// Rule 3: the confirmation must be able to be wrong, or it is not a check.
ok(/landed/.test(addTask) && /Added to \$\{\(landed/.test(addTask),
  'the toast names the day the task actually landed on, read back from the result');

const useTasks = read('src/hooks/useTasks.ts');
ok(/task\.deadline \|\| defaultDate \|\| today/.test(useTasks),
  'a parsed task with no date of its own falls back to the CALLER\'s day, then today');
ok(/addMorningTasksFromSpeech = useCallback\(\s*\n\s*async \(speechText: string, defaultDate\?: string\)/.test(useTasks),
  'which means the hook has to accept one');

console.log('\n3. A dead-looking button must leave a trace in a release build\n');

// Rule 2: console.log is dropped by release builds. The add path had only
// console.log, so when she pressed Add and nothing appeared there was nothing
// in logcat either — no way to tell "parser returned nothing" from "the tap
// never fired".
const addPath = useTasks.slice(
  useTasks.indexOf('addMorningTasksFromSpeech = useCallback'),
  useTasks.indexOf('addMorningTasksFromParsed'),
);
ok(/console\.warn\('\[LLM_PARSER\] no parsed tasks found/.test(addPath),
  'an empty parse is a warn, so it survives a release build');
ok(/console\.warn\(`\[LLM_PARSER\] writing/.test(addPath),
  'and so is the line naming the day it wrote to');

console.log('\n4. One instant is drawn once\n');

/*
 * Koral, 2026-09-22, reading tomorrow's chain:
 *
 *   ⏰ Wake up      before getting ready   12:38
 *   🚿 Get ready    40 min                 13:18
 *   🚪 Leave home   don't miss it          13:18
 *
 * Two faults in three rows. The get-ready row printed `leaveHomeBy` — when it
 * ENDS — while every other row prints when its thing starts, so the same hour
 * appeared twice. And `wakeUpBy` IS leaveHomeBy minus the morning routine, so
 * the first two rows were one instant printed twice to begin with.
 *
 * She wrote the fix herself: "⏰🚿 Start getting ready 12:18 !!! / 40 minutes /
 * 🚪 Leave home 13:18". Two rows, and the number she acts on is on screen.
 */
const leg = read('src/components/TimelineTravelLeg.tsx');
const chain = leg.slice(leg.indexOf('The chain, not just the vehicle'));

ok(/Start getting ready/.test(chain) && /להתחיל להתארגן/.test(chain),
  'the merged row exists, in both languages');
ok(/<Text style=\{styles\.legTime\}>\{loc\.wakeUpBy\}<\/Text>/.test(chain),
  'and it shows when she STARTS, not when she finishes');
// The exact regression: leaveHomeBy must appear once in the chain — on the
// door row — and never as the time of the getting-ready row.
const legTimes = chain.match(/<Text style=\{styles\.legTime\}>\{loc\.\w+\}<\/Text>/g) ?? [];
ok(legTimes.filter((t) => t.includes('leaveHomeBy')).length === 1,
  'leaveHomeBy is printed exactly once', legTimes.join(' '));
ok(!/'Get ready'/.test(chain) && !/'להתארגן'/.test(chain.slice(0, chain.indexOf('Leave home'))),
  'the separate get-ready row is gone');

// NextUpCard draws the same instant on the Today card. Two cards describing
// one moment differently is how she ends up trusting neither.
const nextUp = read('src/components/NextUpCard.tsx');
ok(/isGetReady/.test(nextUp) && /⏰🚿/.test(nextUp),
  'NextUpCard calls it the same thing when the wake time is the route\'s');

console.log('\n5. A timetable on another day cannot have been missed\n');

/*
 * "i am looking now at the trip to tomorrow and the other ways to navigate -
 * it got broken."
 *
 * TransitOptionsList drops any option whose vehicle leaves before she could
 * reach the stop — correct, and the reason the list exists. But `now` falls
 * back to the real clock when a caller passes nothing, so there was no way to
 * opt out: at 23:35, every one of tomorrow's 13:20 departures was "already
 * gone", the list filtered itself empty, and it said so — "The ones I offered
 * have gone — finding the next…" — over a perfectly good timetable.
 */
const list = read('src/components/TransitOptionsList.tsx');
ok(/date\?: string;/.test(list), 'the list can be told which DAY it is showing');
ok(/const isToday = !date \|\| date === todayKey\(\);/.test(list),
  'and only judges catchability on today');
ok(/isToday\s*\n?\s*\? options\.filter\(\(o\) => !departureUncatchable/.test(list),
  'the uncatchable filter is skipped on any other day');
ok(/const left = isToday \? minutesToDecide/.test(list),
  'and so is the countdown — "leave in -580 min" is worse than no countdown');
ok(/Omitted = today/.test(list),
  'omitting it still means today, so existing callers are unchanged');

const trips = read('src/screens/TripsScreen.tsx');
ok(/date=\{task\.date\}/.test(trips), 'Trips passes the trip\'s own day');

console.log('\n6. A plan chosen by rules we have replaced is stale\n');

/*
 * Her interview card at 00:23 on the morning of the interview:
 *
 *   🧭 12:38 get ready → 🚪 13:39 leave → 📍 14:30 starts
 *   45 min door to door, arrive 14:29
 *
 * Arriving one minute before a job interview, chosen by the old "latest
 * departure" rule — and the next recompute was not due until 10:39, because a
 * stored route is only refreshed when it is half an hour old AND its departure
 * is within three hours. Those tests ask "has the world moved". Nothing asked
 * "did we change our mind".
 *
 * And 12:38 → 13:39 is sixty-one minutes for a forty-minute routine: the wake
 * time had been worked back from the 13:18 departure the route had BEFORE a
 * study block was added ahead of it and the journey was replanned. Two numbers
 * on one card describing one morning, disagreeing.
 */
const sync = read('src/services/GoogleSync.ts');
ok(/export const ROUTE_RULES_VERSION = \d+;/.test(sync),
  'the choosing rules carry a version');
ok(/const byOldRules = Boolean\(existing && \(existing\.rulesVersion \?\? 1\) < ROUTE_RULES_VERSION\)/
  .test(sync), 'a plan from an older version is stale');
ok(/const stale = wrongOrigin \|\| byOldRules \|\|/.test(sync),
  'independently of its age and of how soon it departs');
ok(/rulesVersion: ROUTE_RULES_VERSION/.test(sync),
  'and every plan we store is stamped with it');

/**
 * AND THE VERSION HAS TO ACTUALLY MOVE.
 *
 * Version 2 shipped at 00:44 on 2026-09-23 carrying a ranker that had been
 * rewritten again in the same sitting. The stored plan was stamped 2, the
 * constant said 2, so it counted as fresh — no recompute, and the route on her
 * phone was still the one the replaced rule had picked. The staleness
 * mechanism worked exactly as designed and was pointed at a number nobody had
 * moved. Remembering is not a control.
 *
 * So the decisions themselves are fingerprinted. Comments and whitespace are
 * stripped, because a clarified docstring is not a changed rule; anything else
 * — a weight, a comparison, an added step — changes the hash and fails here
 * until someone has looked at ROUTE_RULES_VERSION and decided. Updating the
 * hash without bumping the version is a legitimate answer (a refactor that
 * chooses identically); doing it without noticing is what this prevents.
 */
const decisionSource = (): string => {
  const src = read('src/utils/transitFallback.ts');
  const bodies = ['missesTargetBy', 'rankPlans', 'arrivalBufferFor']
    .map((name) => {
      const start = src.indexOf(`export function ${name}(`);
      if (start < 0) return `MISSING:${name}`;
      // To the next top-level `export ` — good enough, and it fails loudly if
      // the file is reorganised, which is itself worth a second look.
      const after = src.indexOf('\nexport ', start + 1);
      return src.slice(start, after < 0 ? src.length : after);
    })
    .join('\n');
  return bodies
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '');
};

const fingerprint = createHash('sha256').update(decisionSource()).digest('hex').slice(0, 16);
const EXPECTED = { version: 3, fingerprint: 'c1a39b9d50b34852' };
const version = Number(/export const ROUTE_RULES_VERSION = (\d+);/.exec(sync)?.[1] ?? 0);

ok(version === EXPECTED.version && fingerprint === EXPECTED.fingerprint,
  'the route-choosing rules are unchanged since the version was last set',
  `v${version} / ${fingerprint} — if you changed how a route is chosen, bump `
  + 'ROUTE_RULES_VERSION so the plans already on her phone are recomputed, then '
  + 'record the new pair here');

ok(/const wakeUpBy = subtractMinutes\(plan\.leaveHomeAt, prepMinutes\);/.test(sync),
  'the get-ready time is derived from THIS plan\'s departure');
ok(!/const wakeUpBy = firstTrip\s*\n?\s*\?/.test(sync),
  'never carried over from whatever an earlier route computed');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
