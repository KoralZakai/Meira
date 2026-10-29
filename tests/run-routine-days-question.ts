/**
 * run-routine-days-question — "קיקבוקס 20:30–21:30: every day, or on certain
 * days?" from detection to her line rewritten where it lives (6.10).
 *
 * The profile store and the server are stubbed (same trick as run-gap-slots):
 * the test owns what loadProfile returns and what the server answers, so the
 * failure paths — no connection, a line that changed — are exercised, not
 * just the happy one.
 *
 *   npx tsx tests/run-routine-days-question.ts
 */
let profile: any = { routinesNotes: 'מקלחת בוקר, קפה\nקיקבוקס 20:30-21:30 יגאל אלון 94' };
let serverReply: (input: any) => any = () => ({ ok: true, data: { ok: true, applied: {}, new_line: null, effect: { en: 'Saved: Tue.', he: 'נשמר: ימי ג׳.' } } });
const sent: any[] = [];

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    const m = new Map<string, string>();
    return { __esModule: true, default: { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); } } };
  }
  if (request.endsWith('/UserProfileStorage')) {
    return { __esModule: true, loadProfile: async () => profile, saveProfile: async (p: any) => { profile = p; } };
  }
  if (request.endsWith('/LumiServer')) {
    return { __esModule: true, answerQuestion: async (input: any) => { sent.push(input); return serverReply(input); } };
  }
  return origLoad.call(this, request, ...rest);
};

import { parseRoutineNotes, withDays } from '../src/utils/routines';
import { mergeRoutineSources, routineRowsFor } from '../src/utils/routineRows';
import { applyRoutineRules } from '../src/utils/routinePolicy';
// require, not import: imports are hoisted above the stubs, and the real
// LumiServer / UserProfileStorage pull in react-native.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyRoutineDays, detectRoutineDays, subjectOf } = require('../src/questions/kinds/routineDays') as typeof import('../src/questions/kinds/routineDays');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const KICK = 'קיקבוקס 20:30-21:30 יגאל אלון 94';
const fromBox = (text: string) => parseRoutineNotes(text).map((r) => ({ ...r, origin: ['box' as const] }));
const fromChat = (text: string) => parseRoutineNotes(text).map((r) => ({ ...r, id: `told-${r.id}`, origin: ['told' as const] }));

(async () => {
  console.log('\nWhat is asked\n');
  const qs = detectRoutineDays(mergeRoutineSources([...fromBox(`מקלחת בוקר, קפה\n${KICK}`)]));
  check('a routine with an hour and no day is asked about', qs.length === 1 && qs[0].title.startsWith('קיקבוקס'),
    JSON.stringify(qs.map((x) => x.title)));
  check('…in both languages', qs[0]?.ask.he === 'כל יום, או בימים מסוימים?' && /certain days/.test(qs[0]?.ask.en));
  check('…keyed exactly like its row on Today (so the chip opens THIS question)',
    qs[0]?.subject === routineRowsFor(parseRoutineNotes(KICK), '2026-10-07', [])[0]?.key,
    `${qs[0]?.subject} vs ${routineRowsFor(parseRoutineNotes(KICK), '2026-10-07', [])[0]?.key}`);
  check('a routine with its days is not asked about', detectRoutineDays(fromBox('קיקבוקס בשלישי 20:30')).length === 0);
  check('"every day" said is not asked about', detectRoutineDays(fromBox('kids 16:00 every day')).length === 0);
  check('a line with no hour is not asked about', detectRoutineDays(fromBox('מקלחת בוקר')).length === 0);
  const perWeek = detectRoutineDays(fromBox('ריצה פעמיים בשבוע 06:30'));
  check('"twice a week" asks WHICH days', perWeek.length === 1 && /באילו ימים/.test(perWeek[0].ask.he), JSON.stringify(perWeek[0]?.ask));

  console.log('\nOne routine, wherever she wrote it\n');
  const both = mergeRoutineSources([...fromBox(KICK), ...fromChat(KICK)]);
  check('the same line in her box and in the chat is one routine that lives in both',
    both.length === 1 && JSON.stringify(both[0].origin) === '["box","told"]', JSON.stringify(both.map((r) => r.origin)));
  const dup = mergeRoutineSources([...fromBox(KICK), ...fromChat('קיקבוקס בשלישי 20:30-21:30')]);
  check('a dayless copy is dropped when the same routine has its days elsewhere — no question',
    detectRoutineDays(dup).length === 0 && dup.filter((r) => /קיקבוקס/.test(r.text)).length === 1,
    JSON.stringify(dup.map((r) => r.text)));

  console.log('\nA rule she taught Meira\n');
  const rule = (answer: any) => [{ id: 'x', kind: 'routine_days', answer, text: { en: '', he: '' }, at: 1 }];
  const everyDay = applyRoutineRules(fromBox(KICK), rule({ choice: 'every_day' }));
  check('"every day" fills the days and says it came from her rule',
    everyDay[0].daysFrom === 'rule' && everyDay[0].weekdays.length === 0);
  check('…and nothing is asked any more', detectRoutineDays(everyDay).length === 0);
  const workweek = applyRoutineRules(fromBox(KICK), rule({ choice: 'days', days: [0, 1, 2, 3, 4] }));
  check('"Sunday–Thursday": the row is on Tuesday, not on Saturday',
    routineRowsFor(workweek, '2026-10-06', []).length === 1 && routineRowsFor(workweek, '2026-10-10', []).length === 0);
  check('a routine with its days is left as she wrote it',
    applyRoutineRules(fromBox('קיקבוקס בשלישי 20:30'), rule({ choice: 'every_day' }))[0].daysFrom === 'said');

  console.log('\nHer answer, written where the line lives\n');
  const [box] = detectRoutineDays(mergeRoutineSources(fromBox(`מקלחת בוקר, קפה\n${KICK}`)));
  const r1 = await applyRoutineDays(box, { choice: 'days', days: [2] });
  check('box line rewritten on the phone', profile.routinesNotes === `מקלחת בוקר, קפה\n${KICK} · ימי ג׳`, profile.routinesNotes);
  check('…the answer sent to Meira, without touching what she told the chat',
    sent[0]?.rewrite_told === false && sent[0]?.subject === subjectOf(parseRoutineNotes(KICK)[0]) && sent[0]?.line === KICK);
  check('…✓ only because every part saved', r1.result.ok && r1.result.savedLocally && !r1.retry);
  check('…and the row is now on Tuesdays only',
    routineRowsFor(parseRoutineNotes(profile.routinesNotes), '2026-10-06', []).length === 1
    && routineRowsFor(parseRoutineNotes(profile.routinesNotes), '2026-10-07', []).length === 0);

  profile = { routinesNotes: KICK };
  serverReply = () => ({ ok: false, reason: 'Could not reach the server: Network request failed' });
  const [again] = detectRoutineDays(mergeRoutineSources(fromBox(KICK)));
  const r2 = await applyRoutineDays(again, { choice: 'every_day' });
  check('no connection: saved on the phone, NOT reported as done, queued for retry',
    !r2.result.ok && r2.result.savedLocally && r2.result.reason === 'offline' && Boolean(r2.retry), JSON.stringify(r2.result));
  check('…her line has its days anyway', profile.routinesNotes === withDays(KICK, [0, 1, 2, 3, 4, 5, 6]));

  serverReply = () => ({ ok: false, reason: 'Sign in first — the server needs to know it is you' });
  const told = detectRoutineDays(mergeRoutineSources(fromChat(KICK)))[0];
  const r3 = await applyRoutineDays(told, { choice: 'varies' });
  check('signed out, chat line: nothing saved, nothing queued — she is told to sign in',
    !r3.result.ok && !r3.result.savedLocally && r3.result.reason === 'auth' && !r3.retry, JSON.stringify(r3.result));

  serverReply = () => ({ ok: true, data: { ok: false, reason: 'line_changed', applied: { told: 'line_changed' }, new_line: null, effect: { en: '', he: '' } } });
  const r4 = await applyRoutineDays(told, { choice: 'days', days: [1] });
  check('the chat line changed meanwhile: said, never guessed', !r4.result.ok && r4.result.reason === 'line_changed');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
