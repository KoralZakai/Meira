/**
 * run-routine-delete — × on a routine really removes it (21.10, Koral: "I can't delete a routine
 * that is already written in the profile").
 * Run:  npx tsx tests/run-routine-delete.ts
 */
import { removeRoutineFromNotes } from '../src/utils/routines';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

// Her real Routines box (Supabase user_profiles, 21.10).
const NOTES = [
  'ברמיה 94',
  'קיקבוקס · Sundays · 20:30 · יגאל אלון 76, תל אביב',
  'many classes · Mondays · 18:00-20:00 · יגאל אלון 76',
  'training · Thursdays · 19:00 · יגאל אלון 76, תל אביב',
  'אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76, תל אביב',
  'yoga class · Sunday, Monday, Tuesday · 08:00-09:30 · יגאל אלון 76, תל אביב',
  'אימון בוקר · יום שישי · 11:00 · יגאל אלון 76, תל אביב',
].join('\n');

const a = removeRoutineFromNotes(NOTES, 'אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76, תל אביב');
check('a line with commas INSIDE it (days list, city) is removed whole', a.removed === 1 && !a.notes.includes('יום ראשון, שני ושלישי'), `removed=${a.removed}`);
check('…and nothing else goes with it', a.notes.split('\n').length === 6 && a.notes.includes('training · Thursdays'));
const b = removeRoutineFromNotes(NOTES, 'אימון בוקר · יום שישי · 11:00 · יגאל אלון 76, תל אביב');
check('the Friday workout goes', b.removed === 1 && !b.notes.includes('אימון בוקר'));
const c = removeRoutineFromNotes(NOTES, 'not a routine she has');
check('not there: 0 removed, text untouched — the caller says so, never "removed"', c.removed === 0 && c.notes === NOTES);
const d = removeRoutineFromNotes('עיגל אלון 96 · יום שלישי · 20:00', 'יגאל אלון 96 · יום שלישי · 20:00');
check('a place the screen read corrected still matches what is stored', d.removed === 1, JSON.stringify(d));
const e = removeRoutineFromNotes('gym Mon/Wed 18:00, kids 16:00 every day', 'kids 16:00 every day');
check('a plain comma list still loses just its piece', e.removed === 1 && e.notes === 'gym Mon/Wed 18:00', e.notes);
const f = removeRoutineFromNotes('a\n\nb', 'zzz');
check('blank lines survive', f.notes === 'a\n\nb');
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
