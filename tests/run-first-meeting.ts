/**
 * Meira's first meeting (8.10, Koral): the opening line, the checklist that
 * ticks off as she answers, and the profile it saves — on top of what was there.
 */
import {
  checklist, doneLine, draftFromProfile, draftOf, fixRow, openingLine, resumeDraft, routineLines, savedSummary,
  toProfile, welcomeBackLine,
} from '../src/utils/firstMeeting';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

ok(openingLine(true).startsWith('היי, אני מאירה! ספרי לי קצת על עצמך'), 'the opening, in Hebrew');
ok(openingLine(false, 'Koral').startsWith("Hi Koral, I'm Meira!"), 'by name when known');
ok(doneLine(true, 'קורל').includes('מתי לקום, מתי לצאת'), 'the close says what she gets');

const draft = draftOf({
  name: 'קורל', wakeTime: '07:00', totalMorningMinutesEstimate: 40, morningConfirmed: true,
  routines: [{ what: 'קיקבוקס', place: 'יגאל אלון 94', days: 'ב׳ וד׳', time: '20:30', transport: 'bike' }],
  workAddress: 'עזריאלי', workTransport: 'bus', hasCar: false,
  missingFields: ['homeAddress', 'sleepTime'], followUpQuestion: 'איפה את גרה?', isComplete: false,
});
ok(!('missingFields' in draft), 'bookkeeping is stripped');
const rows = checklist(draft, true);
ok(rows.map((r) => r.key).join(',') === 'name,wake,morning,routines,work,home,car,sleep', 'the order she is asked');
ok(rows.find((r) => r.key === 'morning')?.value === '40 דק׳', 'morning, confirmed');
ok(rows.find((r) => r.key === 'routines')?.value === "קיקבוקס · ב׳ וד׳ · 20:30", 'a routine shows its day and hour, not only its name');
ok(rows.find((r) => r.key === 'work')?.value === 'עזריאלי · אוטובוס', 'work and how she gets there');
ok(rows.find((r) => r.key === 'car')?.value === 'אין', 'no car is an answer');
ok(rows.find((r) => r.key === 'home')?.value === null && rows.find((r) => r.key === 'sleep')?.value === null,
  'home and sleep still to ask');
ok(checklist({ totalMorningMinutesEstimate: 40 }, true).find((r) => r.key === 'morning')?.value === '40 דק׳ ?',
  'an unconfirmed morning shows its question mark');

const existing: any = { name: 'קורל', homeAddress: 'מרדכי הגטאות 5, תל אביב', homeLatLng: { lat: 32.08, lng: 34.78 },
  transportMode: 'transit', morningHabits: [], totalMorningRoutineMinutes: 30, workStartTime: '09:00',
  sleepTime: '23:30', routinesNotes: 'פילאטיס · א׳', onboardingComplete: true, createdAt: 'x', lastUpdated: 'x' };
const p: any = toProfile(draft, existing, false, '2026-10-08T18:00:00Z');
ok(p.totalMorningRoutineMinutes === 40 && p.defaultWakeTime === '07:00', 'morning and wake time saved');
ok(p.homeAddress === existing.homeAddress && p.homeLatLng?.lat === 32.08, 'home she did not re-say is kept, coordinates too');
ok(p.routinesNotes === 'פילאטיס · א׳\nקיקבוקס · ב׳ וד׳ · 20:30 · יגאל אלון 94', 'routines are added, never replaced');
ok(p.hasCar === false && p.workAddress === 'עזריאלי', 'car and work');
ok(p.onboardingComplete === true, 'a partial re-run never un-completes her');
const fresh: any = toProfile({ name: 'דנה' }, null, false, 'now');
ok(fresh.onboardingComplete === false && fresh.name === 'דנה', 'a new user who stops halfway is asked again next time');

{
  const back = draftFromProfile({ ...existing, defaultWakeTime: '07:00', hasCar: false } as any);
  ok(back.wakeTime === '07:00' && back.morningConfirmed === true && back.homeAddress === existing.homeAddress,
    'a returning user is not asked what Meira already knows');
  ok(back.routines === undefined, 'routines are asked again — new ones are ADDED');
  ok(welcomeBackLine(true, 'קורל').startsWith('היי קורל! ספרי לי מה חדש'), 'welcome back, not the whole interview');
}

{
  const sum = savedSummary(draft, true);
  const kick = sum.find((r) => r.label === 'קיקבוקס');
  ok(kick?.value === 'ב׳ וד׳ · 20:30 · יגאל אלון 94 · אופניים', 'the summary shows each routine in full');
  ok(sum.findIndex((r) => r.label === 'קיקבוקס') < sum.findIndex((r) => r.key === 'work'), 'routines before work, as asked');
  ok(!sum.some((r) => r.value === null), 'only what was saved — nothing blank to check');
}

{
  // 9.10: "there's a mistake about my work — how do I edit it?" — tap the row.
  const fix = fixRow(draft, 'work', true);
  ok(fix?.question === 'איפה את עובדת, ואיך את מגיעה לשם?', 'tapping Work asks the work question again');
  ok(fix?.draft.workAddress === undefined && fix?.draft.workTransport === undefined && fix?.draft.name === 'קורל',
    'only the work fields are dropped, so the answer replaces them');
  ok(fixRow(draft, 'routine-0', true)?.draft.routines === undefined, 'a routine row re-asks the routines');
  ok(fixRow(draft, 'nope', true) === null, 'an unknown row asks nothing');
}

{
  // 9.10: "I don't work right now, so fix Palo Alto" — and Palo Alto stayed.
  const was: any = { ...existing, workAddress: 'Palo Alto Networks' };
  const p2: any = toProfile({ workAddress: 'none' }, was, false, 'now');
  ok(p2.workAddress === '', '"I don\'t work" clears the old workplace');
  ok((toProfile({}, was, false, 'now') as any).workAddress === 'Palo Alto Networks', 'an answer about something else keeps it');
}

{
  // 9.10: "when I leave the screen and come back, it isn't saved!"
  const said = draftOf({
    routines: [{ what: 'אימון', days: 'ראשון', time: '20:00', place: 'יגאל אלון 94', transport: 'bike' }],
    workAddress: 'none',
  });
  const back = resumeDraft(draftFromProfile({ ...existing, workAddress: '' } as any), { draft: said, lines: [] });
  ok(Array.isArray(back.routines) && back.routines[0].what === 'אימון', 'reopened, the routines she said are there');
  ok(back.workAddress === 'none' && checklist(back, true).find((r) => r.key === 'work')?.value === 'אין',
    'reopened, "I don\'t work" is still an answer');
  ok(back.homeAddress === existing.homeAddress, 'the profile still fills what the conversation did not');

  // Saving after every answer must not pile the same routine up.
  const first: any = toProfile(said, existing, false, 'now');
  const lines = routineLines(said);
  const more = draftOf({ ...said, routines: [{ ...(said.routines as any)[0], time: '20:30' }] });
  const second: any = toProfile(more, first, false, 'now', lines);
  ok(second.routinesNotes === 'פילאטיס · א׳\nאימון · ראשון · 20:30 · יגאל אלון 94',
    'a changed routine replaces its line; her other notes stay');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
