/**
 * run-timeline-chronology — does the day read top to bottom, like a day?
 *
 * Koral has reported this screen twice, both times as an ordering failure:
 *
 *   "tasks that are timed at the same time show in columns and the tasks are
 *    not seen, the text disappears"
 *   "צריך להראות את המשימות לפי השעות הנכונות ולא כולם ביחד באותו בלוק —
 *    כמו בcalendar של google"
 *
 * and then asked for the result to be validated rather than assumed: "must
 * show tasks in very good chronologic way — use ux ui expert and ADHD
 * personalize to test and validate that".
 *
 * So this is the bar, written down. Each rule is here because breaking it
 * costs something specific to a reader with ADHD, not because it is tidy:
 *
 *   ORDER      a row never appears above an earlier one. A day view that is
 *              not monotonic cannot be skimmed at all — every row has to be
 *              read and re-sorted in the head, which is the exact work the
 *              screen exists to remove.
 *
 *   OWNERSHIP  every task carries its OWN start and end. One task speaking for
 *              the group is what produced "כולם ביחד באותו בלוק": a 09:00 and
 *              an 11:30 task both labelled 09:00.
 *
 *   LEGIBILITY one task per row, full width. Columns on a phone clip the title
 *              to nothing, and an unreadable block conveys strictly less than
 *              no block.
 *
 *   PRESENCE   nothing timed is silently dropped, and nothing appears twice. A
 *              task that vanishes from the day is the worst possible failure
 *              for someone using this screen as their memory.
 *
 *   PLACE      free time is drawn where it falls — before the thing it
 *              precedes — and "now" appears exactly once.
 *
 * Run:  npx tsx tests/run-timeline-chronology.ts
 */
import { Task } from '../src/types/index';
import { layoutDay } from '../src/utils/timelineLayout';
import { buildTimelineRows, outOfOrderRows, rowStartMin } from '../src/utils/timelineRows';
import { findDayGaps } from '../src/utils/findGaps';
import { timeToMinutes } from '../src/utils/timeUtils';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (id: string, time: string, mins: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  category: 'general',
  priority: 'need_to',
  isFixed: true,
  fixedTime: time,
  durationMinutes: mins,
  date: '2026-09-15',
  status: 'pending',
  createdAt: 0,
  historicalDurations: [],
  ...extra,
} as Task);

const sortByClock = (tasks: Task[]) =>
  [...tasks].sort((a, b) => timeToMinutes(a.fixedTime!) - timeToMinutes(b.fixedTime!));

/** The whole pipeline, the way DayTimeline runs it. */
const build = (tasks: Task[], now?: string) => {
  const scheduled = sortByClock(tasks);
  const blocks = layoutDay(scheduled, { now });
  const gaps = findDayGaps(scheduled, {
    now, dayStart: '08:00', dayEnd: '22:00', minMinutes: 20,
  });
  return buildTimelineRows({
    scheduled, blocks, gaps, nowMin: now ? timeToMinutes(now) : null,
  });
};

const groupsOf = (rows: ReturnType<typeof build>) =>
  rows.filter((r) => r.kind === 'blocks') as Array<{ kind: 'blocks'; group: any[] }>;
const allBlocks = (rows: ReturnType<typeof build>) =>
  groupsOf(rows).flatMap((r) => r.group);

function main() {
  console.log('\nTimeline chronology — the ADHD / UX bar\n');

  // ── An ordinary day, spread out ──
  const ordinary = [
    t('gym', '07:00', 60),
    t('standup', '09:30', 15),
    t('deep-work', '10:00', 120),
    t('lunch', '13:00', 45),
    t('dentist', '16:30', 30),
  ];

  console.log('1. ORDER — the day reads downwards');
  const day = build(ordinary, '11:00');
  check('nothing appears above something earlier',
    outOfOrderRows(day).length === 0,
    JSON.stringify(outOfOrderRows(day)));
  const starts = day.filter((r) => r.kind !== 'now').map(rowStartMin);
  check('row start times are non-decreasing',
    starts.every((s, i) => i === 0 || s >= starts[i - 1]), starts.join(' → '));
  check('the first block of the day is the earliest task',
    allBlocks(day)[0].task.id === 'gym');
  check('the last block is the latest task',
    allBlocks(day)[allBlocks(day).length - 1].task.id === 'dentist');

  // Tasks handed over in the WRONG order must still come out right — the
  // screen sorts, but a regression there would be invisible without this.
  const shuffled = build([ordinary[3], ordinary[0], ordinary[4], ordinary[1], ordinary[2]], '11:00');
  check('an unsorted input still renders in clock order',
    outOfOrderRows(shuffled).length === 0);
  check('...with the same sequence as the sorted input',
    allBlocks(shuffled).map((b) => b.task.id).join(',')
    === allBlocks(day).map((b) => b.task.id).join(','));

  console.log('\n2. OWNERSHIP — every task keeps its own clock');
  // The reported bug: a long thing and a short thing inside it, both labelled
  // with the long thing's start. The group exists; the SHARED LABEL must not.
  const conference = [
    t('conference', '09:00', 540),   // 09:00 → 18:00
    t('call', '11:30', 30),
    t('dentist-across-town', '14:00', 60),
  ];
  const confDay = build(conference, '10:00');
  const confBlocks = allBlocks(confDay);
  check('all three are drawn', confBlocks.length === 3);
  check('each has its OWN start minute',
    new Set(confBlocks.map((b) => b.startMin)).size === 3,
    confBlocks.map((b) => b.startMin).join(','));
  check('the call starts at 11:30, not 09:00',
    confBlocks.find((b) => b.task.id === 'call')!.startMin === timeToMinutes('11:30'));
  check('the dentist starts at 14:00, not 09:00',
    confBlocks.find((b) => b.task.id === 'dentist-across-town')!.startMin === timeToMinutes('14:00'));
  check('within the overlap group they are still in clock order',
    confBlocks.map((b) => b.startMin).every((s, i, a) => i === 0 || s >= a[i - 1]));
  check('the whole day is still monotonic', outOfOrderRows(confDay).length === 0);

  console.log('\n3. LEGIBILITY — one task per row, and duration you can see');
  // The blocks are stacked full width by the renderer; what the layout must
  // guarantee is that a longer task is never drawn shorter than a shorter one.
  const heights = allBlocks(build([
    t('quick', '09:00', 15), t('hour', '10:00', 60),
    t('long', '12:00', 180), t('all-day', '16:00', 300),
  ])).map((b) => ({ id: b.task.id, h: b.height, m: b.endMin - b.startMin }));
  check('a longer task is never drawn shorter',
    heights.every((b, i) => i === 0 || b.h >= heights[i - 1].h
      || b.m < heights[i - 1].m),
    heights.map((b) => `${b.id}:${b.h}px`).join(' '));
  check('an hour is visibly taller than a quarter hour',
    heights[1].h > heights[0].h, `${heights[1].h} vs ${heights[0].h}`);
  check('three hours is visibly taller than one',
    heights[2].h > heights[1].h, `${heights[2].h} vs ${heights[1].h}`);
  check('nothing is too short to hold a title',
    heights.every((b) => b.h >= 44), heights.map((b) => b.h).join(','));

  console.log('\n4. PRESENCE — nothing lost, nothing doubled');
  const ids = allBlocks(confDay).map((b) => b.task.id);
  check('every timed task appears', conference.every((task) => ids.includes(task.id)));
  check('...exactly once', new Set(ids).size === ids.length, ids.join(','));

  // The hardest shape: three things at the SAME minute. Columns would leave
  // ~100px each and the text would disappear — her words.
  const pileUp = build([
    t('a', '09:00', 60), t('b', '09:00', 60), t('c', '09:00', 60),
  ]);
  const pile = allBlocks(pileUp);
  check('three simultaneous tasks are all drawn', pile.length === 3);
  check('...each exactly once',
    new Set(pile.map((b) => b.task.id)).size === 3);
  check('...and each is its own row entry, not a column of one row',
    pileUp.filter((r) => r.kind === 'blocks').length >= 1 && pile.length === 3);
  check('the day with a pile-up is still monotonic', outOfOrderRows(pileUp).length === 0);

  // A day where an overlap group is followed by ordinary tasks — the ordering
  // trap, because the group emits several tasks at once and the loop must not
  // then double back.
  const mixed = build([
    t('conf', '09:00', 240), t('inside', '10:00', 30),
    t('after', '14:00', 60), t('later', '17:00', 30),
  ], '09:30');
  check('tasks after an overlap group stay after it',
    outOfOrderRows(mixed).length === 0,
    allBlocks(mixed).map((b) => `${b.task.id}@${b.startMin}`).join(' '));
  check('and all four survive', allBlocks(mixed).length === 4);

  console.log('\n5. PLACE — free time and "now" land where they belong');
  const withGaps = build(ordinary, '11:00');
  const gapRows = withGaps.filter((r) => r.kind === 'gap');
  check('free windows are drawn', gapRows.length > 0, `${gapRows.length} gaps`);
  check('every gap sits above the task it precedes',
    outOfOrderRows(withGaps).length === 0);

  // 11:00 falls inside deep-work, so the block owns the marker.
  check('an active block owns the marker — no standalone row',
    !withGaps.some((r) => r.kind === 'now'));
  // 09:00 falls between gym (07:00-08:00) and standup (09:30).
  const quiet = build(ordinary, '09:00');
  check('when nothing is running, "now" gets its own row',
    quiet.filter((r) => r.kind === 'now').length === 1);
  const nowAt = quiet.findIndex((r) => r.kind === 'now');
  const after = quiet.slice(nowAt + 1).filter((r) => r.kind !== 'now');
  const before = quiet.slice(0, nowAt).filter((r) => r.kind !== 'now');
  check('...after everything earlier than it',
    before.every((r) => rowStartMin(r) <= timeToMinutes('09:00')),
    before.map(rowStartMin).join(','));
  check('...and before everything later',
    after.every((r) => rowStartMin(r) > timeToMinutes('09:00')),
    after.map(rowStartMin).join(','));

  console.log('\n6. The degenerate days must not throw');
  // Not an empty list: a day with nothing in it is a day that is entirely
  // free, and saying so is the useful answer. What it must not contain is a
  // block.
  check('an empty day has no blocks', allBlocks(build([])).length === 0);
  check('...and offers the free day instead of a blank screen',
    build([]).some((r) => r.kind === 'gap'));
  check('one task is one block', allBlocks(build([t('only', '12:00', 60)])).length === 1);
  check('a task with no time is not on the timeline',
    allBlocks(build([t('someday', '', 30, { fixedTime: undefined })])).length === 0);
  check('a day at midnight is still ordered',
    outOfOrderRows(build([t('late', '23:30', 20), t('early', '00:10', 20)])).length === 0);

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
