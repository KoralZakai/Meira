/**
 * run-timeline-layout — the day as geometry.
 * Run: npx tsx tests/run-timeline-layout.ts
 */
import { layoutDay, hasClash, PX_PER_MIN, MIN_BLOCK_PX } from '../src/utils/timelineLayout';
import { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const t = (id: string, time: string, mins: number, over: Partial<Task> = {}): Task => ({
  id, text: id, category: 'general', priority: 'need_to', isFixed: true,
  fixedTime: time, durationMinutes: mins, date: '2026-09-07', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as unknown as Task);

function main() {
  console.log('\nTimeline layout\n');

  const conf = t('conference', '09:00', 540);   // 09:00-18:00
  const talk = t('prompt', '18:00', 180);       // 18:00-21:00
  const meet = t('builder', '18:00', 240);      // 18:00-22:00

  console.log('1. Height follows duration');
  const day = layoutDay([conf, talk], { now: '13:10' });
  const C = day.find((b) => b.task.id === 'conference')!;
  const T = day.find((b) => b.task.id === 'prompt')!;
  check('a 9h block is 432px', C.height === 432, `${C.height}px`);
  check('an hour is 48px — visible, not floored',
    layoutDay([t('hour', '10:00', 60)])[0].height === 48, `${layoutDay([t('hour', '10:00', 60)])[0].height}px`);
  check('two hours is 96px', layoutDay([t('two', '10:00', 120)])[0].height === 96);
  check('a 3h block is shorter', T.height < C.height, `${T.height}px`);
  check('a 15m block is floored at 52px, not 12px',
    layoutDay([t('call', '10:00', 15)])[0].height === MIN_BLOCK_PX, `${MIN_BLOCK_PX}px`);

  console.log('\n2. Where she is');
  check('13:10 is inside the conference', C.active);
  check('…46% through', Math.round(C.progress * 100) === 46, `${Math.round(C.progress * 100)}%`);
  check('the 18:00 talk is not active', !T.active);
  check('nothing is past yet', !C.past && !T.past);
  check('the talk is the NEXT block', T.next && !C.next);

  const evening = layoutDay([conf, talk], { now: '19:00' });
  check('at 19:00 the conference is past',
    evening.find((b) => b.task.id === 'conference')!.past);
  check('and the talk is active',
    evening.find((b) => b.task.id === 'prompt')!.active);

  console.log('\n3. Overlaps go side by side');
  const clash = layoutDay([conf, talk, meet], { now: '13:10' });
  const cT = clash.find((b) => b.task.id === 'prompt')!;
  const cM = clash.find((b) => b.task.id === 'builder')!;
  check('the clashing pair report 2 columns', cT.columns === 2 && cM.columns === 2);
  check('and take different columns', cT.column !== cM.column, `${cT.column} vs ${cM.column}`);
  check('the day is flagged as clashing', hasClash(clash));
  check('the conference is NOT dragged into their group',
    clash.find((b) => b.task.id === 'conference')!.columns === 1);

  console.log('\n4. Things it must not do');
  check('a clean day has no clash', !hasClash(layoutDay([conf])));
  check('untimed tasks are dropped', layoutDay([t('someday', '', 30, { fixedTime: undefined })]).length === 0);
  check('archived tasks are dropped',
    layoutDay([t('gone', '09:00', 60, { status: 'moved' })]).length === 0);
  check('zero-length blocks are dropped', layoutDay([t('empty', '09:00', 0)]).length === 1,
    'duration falls back to 30m, so it survives');
  check('with no clock, nothing is past or active',
    layoutDay([conf]).every((b) => !b.past && !b.active));

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
