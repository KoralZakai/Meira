/**
 * run-clash-resolution — built from the real day that was reported.
 *
 * A Zoom call 18:00-19:00, "אפטר אופיס" 18:30-23:00, and a yoga class at 19:00
 * in a physical studio. Three commitments, overlapping, and Lumi said nothing.
 *
 * Detecting the clash is the easy half. The point of this module is the other
 * half: laying out what could actually be done, and — when nothing tidy is
 * available — ASKING which matters more instead of quietly choosing.
 *
 * Run:  npx tsx tests/run-clash-resolution.ts
 */
import { resolveClashes, firstFreeSlot, overlapMinutes } from '../src/utils/resolveClashes';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36).slice(2), text: 'task', category: 'general',
  priority: 'need_to', isFixed: false, durationMinutes: 60, date: '2026-08-26',
  status: 'pending', createdAt: 0, historicalDurations: [], ...over,
} as Task);

// The reported day, exactly.
const zoom = t({
  text: 'פגישת זום', category: 'zoom', isFixed: true, fixedTime: '18:00',
  durationMinutes: 60, meetingUrl: 'https://us02web.zoom.us/j/123',
});
const after = t({ text: 'אפטר אופיס', category: 'leisure', fixedTime: '18:30', durationMinutes: 270 });
const yoga = t({
  text: 'יוגה', category: 'hobby_class', isFixed: true, fixedTime: '19:00',
  durationMinutes: 60, location: 'Yigal Alon 94' as any,
});

function main() {
  console.log('\nClash resolution\n');

  console.log('1. Overlaps are measured, not guessed');
  check('zoom 18:00-19:00 vs after-office 18:30-23:00 = 30 min',
    overlapMinutes(zoom, after) === 30, `${overlapMinutes(zoom, after)}`);
  check('zoom vs yoga do NOT overlap (18:00-19:00 / 19:00-20:00)',
    overlapMinutes(zoom, yoga) === 0, `${overlapMinutes(zoom, yoga)}`);
  check('after-office vs yoga = 60 min', overlapMinutes(after, yoga) === 60);

  console.log('\n2. The reported day produces real clashes');
  const clashes = resolveClashes([zoom, after, yoga]);
  check('two genuine clashes found', clashes.length === 2, `${clashes.length}`);
  check('every clash carries at least one option',
    clashes.every((c) => c.options.length > 0));

  console.log('\n3. A call rides along; a class does not');
  // The whole point of isRemoteTask: the Zoom can happen in transit, the yoga cannot.
  const zoomYoga = resolveClashes([
    t({ ...zoom, fixedTime: '18:30' } as Partial<Task>), yoga,
  ]);
  const remote = zoomYoga[0]?.options.find((o) => o.kind === 'attend-remotely');
  check('offers joining the call on the way to the class', Boolean(remote), remote?.labelEn);
  check('it is the CALL that moves, not the class', remote?.taskId !== yoga.id);

  console.log('\n4. A flexible task is offered a real free slot');
  // A short flexible task simply moves.
  const shortFlexible = t({ text: 'Call mum', category: 'call', fixedTime: '19:15', durationMinutes: 20 });
  const movedOpt = resolveClashes([yoga, shortFlexible])
    .flatMap((c) => c.options).find((o) => o.kind === 'move');
  check('a short flexible task is offered a move', Boolean(movedOpt), movedOpt?.labelEn);
  check('the proposed time is a real clock time', /^\d{2}:\d{2}$/.test(movedOpt?.newTime || ''), movedOpt?.newTime);

  console.log('\n4b. What does not FIT is offered a shorter version');
  // אפטר אופיס is 270 min. After yoga ends at 20:00 there are only 180 min
  // before 23:00 — it cannot move, but it can still happen, for less time.
  const shorten = resolveClashes([after, yoga])
    .flatMap((c) => c.options).find((o) => o.kind === 'shorten');
  check('offers a shortened after-office instead of dropping it', Boolean(shorten), shorten?.labelEn);
  check('it starts once the class is over', shorten?.newTime === '20:00', shorten?.newTime);

  console.log('\n5. When nothing can move, ASK — never choose silently');
  const a = t({ text: 'Interview', category: 'interview', isFixed: true, fixedTime: '10:00', durationMinutes: 60, location: 'Herzliya' as any });
  const b = t({ text: 'Doctor', category: 'doctor', isFixed: true, fixedTime: '10:30', durationMinutes: 60, location: 'Tel Aviv' as any });
  const hard = resolveClashes([a, b]);
  check('a clash is reported', hard.length === 1);
  check('both options are "choose"', hard[0].options.every((o) => o.kind === 'choose'));
  check('one option per task', hard[0].options.length === 2);
  check('it asks which matters more', /matters more/i.test(hard[0].questionEn), hard[0].questionEn);
  check('and asks in Hebrew too', hard[0].questionHe.includes('יותר חשוב'));

  console.log('\n5b. Two places, no time to travel between them');
  // Her real report: a gym 19:00-20:00, and a beach at 20:00. Being at the
  // beach at 20:00 while leaving the gym at 20:00 is not a preference, it is
  // impossible — the only honest fix is to leave the gym sooner.
  const gymTask = t({
    text: 'אימון עיצוב', category: 'gym', fixedTime: '19:00', durationMinutes: 60,
    location: 'Space Gym' as any,
  });
  const beach = t({
    text: 'אבישי פרץ בחוף הילטון', category: 'leisure', isFixed: true,
    fixedTime: '19:40', durationMinutes: 120,
    location: { address: 'Hilton Beach', lat: 0, lng: 0, confirmed: true, travelMinutes: 25 } as any,
  });
  const tight = resolveClashes([gymTask, beach]);
  const earlier = tight.flatMap((c) => c.options).find((o) => o.kind === 'end-earlier');
  check('offers leaving the gym earlier', Boolean(earlier), earlier?.labelEn);
  check('the cut accounts for the 25 min journey', earlier?.newTime === '19:15', earlier?.newTime);
  check('it cuts the FLEXIBLE task, not the pinned one', earlier?.taskId === gymTask.id);

  console.log('\n5c. Back-to-back in two places is STILL a conflict');
  // The exact report: gym 19:00-20:00, beach at 20:00, 25 min apart. Overlap is
  // ZERO, so this pair used to be skipped entirely and Lumi said nothing.
  const beachAt20 = t({
    text: 'אבישי פרץ בחוף הילטון', category: 'leisure', isFixed: true,
    fixedTime: '20:00', durationMinutes: 120,
    location: { address: 'Hilton Beach', lat: 0, lng: 0, confirmed: true, travelMinutes: 25 } as any,
  });
  const touching = resolveClashes([gymTask, beachAt20]);
  check('a zero-overlap pair 25 min apart IS flagged', touching.length === 1);
  check('overlap really is zero', touching[0]?.overlapMinutes === 0);
  check('the shortfall is the full journey', touching[0]?.travelShortfall === 25,
    String(touching[0]?.travelShortfall));
  const kinds = (touching[0]?.options || []).map((o) => o.kind);
  check('BOTH answers are offered, not one chosen for her',
    kinds.includes('end-earlier') && kinds.includes('delay-next'), kinds.join(' · '));
  const cut = touching[0].options.find((o) => o.kind === 'end-earlier');
  const push = touching[0].options.find((o) => o.kind === 'delay-next');
  check('cut the gym at 19:35 (20:00 − 25)', cut?.newTime === '19:35', cut?.newTime);
  check('or start the beach at 20:25 (20:00 + 25)', push?.newTime === '20:25', push?.newTime);
  check('the question names travel, not overlap',
    /apart/.test(touching[0].questionEn), touching[0].questionEn);

  console.log('\n6. Free slots respect the rest of the day');
  const day = [
    t({ fixedTime: '09:00', durationMinutes: 60, isFixed: true }),
    t({ fixedTime: '10:00', durationMinutes: 60, isFixed: true }),
  ];
  check('finds the gap after both', firstFreeSlot(day, 30, '09:00') === '11:00', firstFreeSlot(day, 30, '09:00'));
  check('respects notBefore', firstFreeSlot(day, 30, '14:00') === '14:00');
  check('returns nothing when the day is over',
    firstFreeSlot(day, 60, '22:45', '23:00') === undefined, String(firstFreeSlot(day, 60, '22:45', '23:00')));

  console.log('\n8. A long conference does not eat the evening');
  // The reported bug, exactly: a conference running 09:00-22:00 and a course
  // at 18:00-21:00. The only thing Lumi offered was "keep one" — which let the
  // other one go. But you can walk out of a conference; the real answer is to
  // leave it at 17:45 and make both.
  const conf = t({
    text: 'כנס האקריות באוניברסיטת תל אביב', category: 'conference', isFixed: true,
    fixedTime: '09:00', durationMinutes: 780, priority: 'must',
    location: { address: 'Tel Aviv University', lat: 32.11, lng: 34.80, confirmed: true, travelMinutes: 15 } as any,
  });
  const course = t({
    text: 'from prompt to ai', category: 'course', isFixed: true,
    fixedTime: '18:00', durationMinutes: 180, priority: 'have_to',
    location: { address: 'Yigal Alon 94', lat: 32.07, lng: 34.79, confirmed: true, travelMinutes: 15 } as any,
  });
  const evening = resolveClashes([conf, course], '23:00');
  check('the collision is seen', evening.length === 1, `${evening.length}`);
  const opts = evening[0]?.options ?? [];
  check('it is NOT reduced to "pick one"',
    !opts.every((o) => o.kind === 'choose'), opts.map((o) => o.kind).join(' · '));
  const keepBoth = opts.find((o) => o.kind === 'end-earlier');
  check('leaving the conference early is offered', Boolean(keepBoth), keepBoth?.labelEn);
  check('it cuts the CONFERENCE, not the course', keepBoth?.taskId === conf.id);
  check('leave at 17:45 — 18:00 less the 15 min journey',
    keepBoth?.newTime === '17:45', keepBoth?.newTime);
  check('nothing is dropped: no let-go option is the only way out',
    opts.some((o) => o.kind !== 'choose'));

  // …but an interview is NOT something you walk out of half way through.
  const interview = t({
    text: 'ראיון עבודה', category: 'interview', isFixed: true,
    fixedTime: '09:00', durationMinutes: 780, priority: 'must',
    location: { address: 'Tel Aviv University', lat: 32.11, lng: 34.80, confirmed: true, travelMinutes: 15 } as any,
  });
  const held = resolveClashes([interview, course], '23:00');
  check('an interview is never offered as "leave early"',
    !(held[0]?.options ?? []).some((o) => o.kind === 'end-earlier'),
    (held[0]?.options ?? []).map((o) => o.kind).join(' · '));

  console.log('\n7. A clean day produces nothing');
  check('no clashes, no noise', resolveClashes([
    t({ fixedTime: '09:00', durationMinutes: 60 }),
    t({ fixedTime: '11:00', durationMinutes: 60 }),
  ]).length === 0);
  check('untimed tasks are ignored', resolveClashes([t({}), t({})]).length === 0);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
