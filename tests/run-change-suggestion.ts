/**
 * run-change-suggestion — booking the offer on the Today card; nothing claimed that did not save (19.10).
 * Run:  npx tsx tests/run-change-suggestion.ts
 */
import { readFileSync } from 'node:fs';
import { bookStudy, bookWake, studyChipLabel, studyDraft, whenWord, BookDeps } from '../src/utils/changeSuggestion';
import { describeChange } from '../src/utils/changeRecord';
import { nudgesFor } from '../src/utils/nudgeLevel';
import { isInterview, isPrepBlock } from '../src/utils/interviewPrep';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const iv = { id: 'gcal-w', text: 'Your Phone Screen at Workday', category: 'interview', priority: 'must', isFixed: true,
  date: '2026-10-20', fixedTime: '13:00', durationMinutes: 60, status: 'pending', createdAt: 0, historicalDurations: [] } as Task;
const rec = describeChange({ date: '2026-10-19', fixedTime: '13:00' }, iv, '2026-10-18', '10:00')!;
const NOW = new Date(2026, 9, 18, 10, 0);

function deps(over: Partial<{ addFails: boolean; remindFails: boolean; level: any }> = {}) {
  const added: any[] = []; const reminded: Array<{ when: Date; text: string }> = [];
  const d: BookDeps = {
    addTask: async (draft) => { if (over.addFails) throw new Error('disk'); added.push(draft); return { ...(draft as any), id: 't1' } as Task; },
    scheduleReminderAt: async (when, text) => { if (over.remindFails) return null; reminded.push({ when, text }); return 'n' + reminded.length; },
    level: over.level ?? 'gentle', now: NOW,
  };
  return { d, added, reminded };
}
const run = async () => {
  // ── the chip ──
  check('chip: today 20:00 (HE/EN)', studyChipLabel({ date: '2026-10-18', time: '20:00' }, '2026-10-18', 'he') === 'לימוד היום 20:00'
    && studyChipLabel({ date: '2026-10-19', time: '20:00' }, '2026-10-18', 'en') === 'Study tomorrow 20:00');
  check('chip further out is dated', whenWord('2026-10-21', '2026-10-18', 'he') === 'ד׳ 21.10');

  // ── the booking ──
  { const { d, added, reminded } = deps();
    const r = await bookStudy(d, rec, '2026-10-18', '20:00', 120, 'he');
    check('saved + reminded: ✓ and 🔔', r.saved && r.reminded && r.line.includes('✓') && r.line.includes('🔔'));
    check('the diary entry is dated, timed and preparation FOR the interview',
      added[0].date === '2026-10-18' && added[0].fixedTime === '20:00' && added[0].prepForTaskId === 'gcal-w' && !!added[0].pickedAt);
    check('the study block is not itself an interview (no runaway prep)', !isInterview({ ...added[0], id: 'x' } as Task) && isPrepBlock({ ...added[0], id: 'x' } as Task));
    check('gentle: heads-up 19:30 + 20:00', reminded.map((x) => `${x.when.getHours()}:${String(x.when.getMinutes()).padStart(2, '0')}`).join() === '19:30,20:00'); }
  { const { d, added } = deps({ addFails: true });
    const r = await bookStudy(d, rec, '2026-10-18', '20:00', 120, 'he');
    check('diary failed: no ✓, no 🔔, says so', !r.saved && !r.line.includes('✓') && !r.line.includes('🔔') && r.line.includes('לא הצלחתי') && added.length === 0); }
  { const { d } = deps({ remindFails: true });
    const r = await bookStudy(d, rec, '2026-10-18', '20:00', 120, 'en');
    check('reminder failed: ✓ but no 🔔', r.saved && !r.reminded && r.line.includes('✓') && !r.line.includes('🔔')); }
  { const { d, reminded } = deps({ level: 'alarm' }); await bookStudy(d, rec, '2026-10-18', '20:00', 120, 'en');
    check('alarm only: one reminder', reminded.length === 1); }
  { const { d, reminded } = deps({ level: 'motivating' }); await bookStudy(d, rec, '2026-10-18', '20:00', 120, 'en');
    check('motivating: three reminders', reminded.length === 3); }
  { const { d, added } = deps(); const r = await bookStudy(d, rec, '2026-10-18', '09:00', 120, 'he');
    check('an hour already gone is refused, nothing saved', !r.saved && added.length === 0); }
  { const { d, reminded } = deps(); const r = await bookStudy(d, rec, '2026-10-18', '10:20', 60, 'en');
    check('a 10:20 block today: the heads-up already past is skipped, the rest set', r.saved && reminded.length === 1); }

  // ── the wake-up ──
  { const { d, added, reminded } = deps();
    const r = await bookWake(d, rec, '08:00', 'he');
    check('wake: on the event day, no second diary entry', r.reminded && added.length === 0 && reminded.some((x) => x.when.getDate() === 20 && x.when.getHours() === 8));
    check('wake says the hour and the dated day', r.line.includes('08:00') && r.line.includes('20.10')); }
  { const { d } = deps({ remindFails: true }); const r = await bookWake(d, rec, '08:00', 'en');
    check('wake not set: says so, no promise', !r.reminded && !r.line.includes('wake you')); }

  // ── parity with the server's reminders ──
  const py = readFileSync('server/reschedule.py', 'utf8');
  const sample = nudgesFor('motivating', '20:00', 'X', true).concat(nudgesFor('motivating', '20:00', 'X', false), nudgesFor('gentle', '20:00', 'X', true), nudgesFor('gentle', '20:00', 'X', false));
  const phrases = ['בעוד חצי שעה', 'in half an hour', 'יש לך את זה! עוד שעה לומדים 💪', 'את מסוגלת! 💪', 'איך הולך? 🙂',
    "You've got this! Study in an hour 💪", 'You can do this! 💪', "How's it going? 🙂"];
  check('every phrase the phone speaks is the server\'s too', phrases.every((p) => py.includes(p)) && sample.length === 10);
  check('hours match the server: gentle 19:30/20:00, motivating 19:00/20:00/20:30',
    nudgesFor('gentle', '20:00', 'x', true).map((n) => n.at).join() === '19:30,20:00'
    && nudgesFor('motivating', '20:00', 'x', true).map((n) => n.at).join() === '19:00,20:00,20:30'
    && nudgesFor('alarm', '20:00', 'x', true).map((n) => n.at).join() === '20:00'
    && nudgesFor('motivating', '23:50', 'x', true).map((n) => n.at).join() === '22:50,23:50');
  check('the draft never asks how she will get there', !/how will you get|איך תגיעי/i.test(JSON.stringify(studyDraft(rec, '2026-10-18', '20:00', 120, 'he'))));

  if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
  console.log(`\n✅ ${checks}/${checks} checks passed`);
};
run();
