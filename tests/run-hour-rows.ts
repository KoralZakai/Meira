/**
 * run-hour-rows — the drag ruler: half hours from now to the end of the day, each saying what is there.
 *
 * Run:  npx tsx tests/run-hour-rows.ts
 */
import { hourRows } from '../src/utils/hourRows';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const t = (text: string, at: string, mins: number, status = 'pending') =>
  ({ id: text, text, fixedTime: at, durationMinutes: mins, status } as unknown as Task);
const rows = hourRows([t('Yosi', '17:30', 90), t('done', '19:00', 30, 'complete')], 15 * 60 + 22, '21:00');
check('starts at the next half hour after now (+5′)', rows[0]?.start === '15:30', rows[0]?.start);
check('ends before the end of the day', rows[rows.length - 1]?.start === '20:30');
check('a busy half hour names what is there', rows.find((r) => r.start === '18:00')?.busy === 'Yosi');
check('free is free', rows.find((r) => r.start === '16:00')?.busy === '');
check('a done task does not block', rows.find((r) => r.start === '19:00')?.busy === 'Yosi' || rows.find((r) => r.start === '19:00')?.busy === '');
const morning = hourRows([], 7 * 60, '23:00');
check('a long day fits one screen — whole hours', morning.length <= 22 && morning[1]?.start === '09:00', `${morning.length} rows, ${morning[0]?.start},${morning[1]?.start}`);
const lateBed = hourRows([], 15 * 60 + 37, '00:30');
check('a bedtime after midnight still leaves the evening (28.10: the ruler was empty)', lateBed.length > 0 && lateBed[lateBed.length - 1].start === '23:30', `${lateBed.length} rows`);
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
