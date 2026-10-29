/**
 * "Hear my day" — 13.10, Koral: "it's too long! heavy, repetitive". It read
 * the date, the hour, a random motivational line and every title, prep blocks
 * and duplicates included. Now: greeting, ≤3 things still ahead, the first
 * trip's leave time, the count of the rest, one wish for an interview.
 */
import { buildMorningBriefing } from '../src/utils/dayBriefing';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}  ${detail}`); }
};

const at = new Date(2026, 9, 13, 8, 30);
const day = [
  { time: '13:00', text: 'ראיון ראשון - קורל זכאי - חיפה', leaveAt: '10:34', category: 'interview' },
  { time: '13:00', text: 'ראיון ראשון - קורל זכאי - חיפה', leaveAt: '10:34', category: 'interview' },  // second calendar
  { text: 'Prep for the ראיון ראשון - קורל זכאי - חיפה interview — company, role, questions', prep: true },
  { time: '09:00', text: 'Study for ללמוד לראיון של אמזון — right up until you leave', prep: true },
  { time: '16:30', text: 'Deep Inside AI Coding' },
  { time: '18:00', text: 'The Software Factory : AI Agents Community Meetup' },
  { time: '20:00', text: 'אימון' },
  { text: 'לקנות חלב' },
];
const he = buildMorningBriefing('קורל', day, 'he', at);
console.log(`     ${he}`);
ok(he.startsWith('בוקר טוב קורל!'), 'greets by name');
ok((he.match(/ראיון ראשון/g) || []).length === 1, 'the interview is said ONCE');
ok(!/Prep for|Study for/.test(he), "Meira's prep blocks are not read as her day");
ok(he.includes('יוצאים ב-10:34'), 'the first trip carries its leave time');
ok(he.includes('ועוד 2'), 'the rest is a count, not a list');
ok(!/השעה|13\.10|את\/ה/.test(he), 'no date, no clock readout, no "את/ה"');
ok(he.split(/[.!]/).filter((x) => x.trim()).length <= 6 && he.length < 200, `short (${he.length} chars)`);
ok(he.endsWith('בהצלחה בראיון!'), 'one wish for the interview');
const en = buildMorningBriefing('Koral', [{ time: '07:00', text: 'gym' }], 'en', at);
ok(en === 'Good morning Koral! Nothing else fixed today.', 'what is behind her is not read out', en);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
