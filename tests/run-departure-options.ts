/**
 * run-departure-options — "at least three, with both clock times, in order".
 *
 * The reported behaviour: having missed the 08:30 at 09:00, the app offered
 * one recomputed departure and a sentence. This covers the pure half of the
 * fix — the ranking, the de-duplication, the late/early arithmetic and the
 * labels the row renders. The Google probing (getDepartNowOptions) is network
 * and lives in RoutePlanner; run-week-schedule exercises that.
 *
 * Run:  npx tsx tests/run-departure-options.ts
 */
import {
  rankDepartureOptions, changesLabel, slackLabel, vehicleLabel, optionSignature,
  boardLabel, departureUncatchable, minutesToDecide, urgencyLabel, platformLabel,
  superlativeLabel, awardSuperlatives,
} from '../src/utils/departureOptions';
import { TransitPlan } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** A train plan: leave HH:MM, arrive HH:MM, on `line`. */
function train(leave: string, arrive: string, line = 'המכבים', rides = 1): TransitPlan {
  const legs: any[] = [
    { type: 'walk', from: 'home', to: 'stop', durationMinutes: 6, departureTime: leave, arrivalTime: leave },
  ];
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  // Chain the rides through the window instead of stacking them all on the
  // same two clock times. The old fixture gave every ride identical departure
  // and arrival, which is a shape Google cannot return and which
  // utils/planIntegrity now correctly refuses as out-of-order — a fixture that
  // could not exist was hiding behind an assertion about labels.
  const each = Math.max(1, Math.floor((mins(arrive) - mins(leave)) / rides));
  for (let i = 0; i < rides; i += 1) {
    const dep = mins(leave) + i * each;
    legs.push({
      type: 'train', from: 'a', to: 'b', durationMinutes: each,
      departureTime: hhmm(dep),
      arrivalTime: i === rides - 1 ? arrive : hhmm(dep + each),
      lineNumber: i === 0 ? line : `${line}-${i}`,
    });
  }
  return {
    totalDurationMinutes: mins(arrive) - mins(leave),
    leaveHomeAt: leave,
    arriveAt: arrive,
    firstBusDeparture: leave,
    firstBusStop: 'תל אביב ההגנה',
    walkToStopMinutes: 6,
    legs,
    source: 'google',
    fetchedAt: Date.now(),
  } as TransitPlan;
}

function main() {
  console.log('\nDeparture options\n');

  // The reported scenario, exactly: it is 09:00, the 08:30 is gone, the plan
  // said 09:05, and the timetable has 09:15 / 09:45 / 10:05.
  console.log('1. The reported case — missed the 08:30, it is 09:00');
  const timetable = [
    train('09:15', '10:05'),
    train('09:45', '10:35'),
    train('10:05', '10:55'),
  ];
  const opts = rankDepartureOptions(timetable, {
    after: '09:00', appointment: '10:30', currentDeparture: '09:05', max: 3,
  });
  check('three options are offered, not one', opts.length === 3, `${opts.length}`);
  check('in departure order', opts.map((o) => o.departAt).join(',') === '09:15,09:45,10:05');
  check('every option carries a departure AND an arrival',
    opts.every((o) => /^\d{2}:\d{2}$/.test(o.departAt) && /^\d{2}:\d{2}$/.test(o.arriveAt)));
  check('the 09:15 arrives 25 min early for a 10:30', opts[0].slackMinutes === 25);
  check('…and is not flagged late', opts[0].late === false);
  check('the 10:05 arrives 25 min LATE', opts[2].slackMinutes === -25 && opts[2].late);

  console.log('\n2. Nothing that has already gone');
  const withPast = rankDepartureOptions([train('08:30', '09:20'), ...timetable], {
    after: '09:00', max: 3,
  });
  check('the 08:30 is dropped — it is 09:00',
    !withPast.some((o) => o.departAt === '08:30'));
  check('and the list is still three long', withPast.length === 3);

  console.log('\n3. The same trip is not three options');
  const dupes = [train('09:15', '10:05'), train('09:15', '10:05'), train('09:45', '10:35')];
  const deduped = rankDepartureOptions(dupes, { after: '09:00', max: 3 });
  check('duplicates collapse', deduped.length === 2, `${deduped.length}`);
  check('signature is departure + lines + arrival',
    optionSignature(train('09:15', '10:05')) === optionSignature(train('09:15', '10:05')));

  console.log('\n4. The one already on the task is marked, never re-offered as new');
  const marked = rankDepartureOptions(timetable, { after: '09:00', currentDeparture: '09:45' });
  check('the 09:45 is flagged current',
    marked.find((o) => o.departAt === '09:45')?.current === true);
  check('the others are not', marked.filter((o) => o.current).length === 1);

  console.log('\n5. A plan with no arrival time is not an option');
  const noArrive = { ...train('09:15', '10:05'), arriveAt: '' } as TransitPlan;
  check('dropped rather than shown with a blank half',
    rankDepartureOptions([noArrive], { after: '09:00' }).length === 0);

  console.log('\n6. Labels');
  const [first] = rankDepartureOptions([train('09:15', '10:05')], { appointment: '10:30' });
  check('direct ride says so (en)', changesLabel(first, false) === 'direct');
  check('…and in Hebrew', changesLabel(first, true) === 'ישיר');
  const [two] = rankDepartureOptions([train('09:15', '10:20', 'x', 2)], {});
  check('two rides is one change', changesLabel(two, false) === '1 change');
  check('early slack is stated, not implied', slackLabel(first, false) === '25 min early');
  check('late slack too',
    slackLabel(rankDepartureOptions([train('10:05', '10:55')], { appointment: '10:30' })[0], false)
    === '25 min late');
  check('a train is badged as a train', vehicleLabel(first, false).startsWith('🚆'));
  check('the line name is in the badge', vehicleLabel(first, false).includes('המכבים'));

  console.log('\n7. An empty timetable is an empty list, not a crash');
  check('no plans', rankDepartureOptions([], { after: '09:00' }).length === 0);
  check('nulls survive', rankDepartureOptions([null, undefined], { after: '09:00' }).length === 0);

  // ── The 08:37 report ──────────────────────────────────────────────────
  //
  // Reported live, on the device: "the app is offering to take a train that
  // already left (8:25), now is 8:37". Two separate faults met in that one
  // screen, and each one alone reproduces it.
  console.log('\n8. A departure you cannot physically reach is not an option');

  /** A plan the way parseTransitRoute really builds one: door time = board - walk,
   *  and leaveHomeAt carries the extra 5-minute safety margin on top. */
  const real = (board: string, arrive: string, walk: number, line = 'המכבים'): TransitPlan => {
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const hhmm = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const door = hhmm(mins(board) - walk);
    return {
      totalDurationMinutes: mins(arrive) - mins(door),
      leaveHomeAt: hhmm(mins(door) - 5),   // the real -5 fudge
      arriveAt: arrive,
      firstBusDeparture: board,
      firstBusStop: 'תל אביב ההגנה',
      walkToStopMinutes: walk,
      legs: [
        { type: 'walk', from: 'home', to: 'תל אביב ההגנה', durationMinutes: walk, departureTime: door, arrivalTime: board },
        { type: 'train', from: 'תל אביב ההגנה', to: 'אוניברסיטה', durationMinutes: mins(arrive) - mins(board), departureTime: board, arrivalTime: arrive, lineNumber: line },
      ],
      source: 'google',
      fetchedAt: Date.now(),
    } as TransitPlan;
  };

  // It is 08:37. The 08:25 has gone. The next two are 08:52 and 09:12, and the
  // station is a 12-minute walk.
  const gone = real('08:25', '08:53', 12);
  const next = real('08:52', '09:20', 12);
  const after = real('09:12', '09:40', 12);
  const live = rankDepartureOptions([gone, next, after], {
    after: '08:37', appointment: '09:30', max: 3,
  });

  check('the departed train is gone from the list', !live.some((o) => o.boardAt === '08:25'));
  // The fault that hid the fix: leaveHomeAt for the 08:52 reads 08:35 — five
  // minutes in the PAST — so the old `leaveHomeAt < after` filter threw away
  // the one train she could still run for.
  check('the train she can still catch survives', live.some((o) => o.boardAt === '08:52'),
    live.map((o) => o.boardAt).join(', '));
  check('and it is first', live[0]?.boardAt === '08:52');
  check('the later one is still offered', live.some((o) => o.boardAt === '09:12'));
  check('leave time never reads in the past', live.every((o) => o.departAt >= '08:37'),
    live.map((o) => o.departAt).join(', '));
  check('a 12-minute walk at 08:37 does not catch a train at 08:45',
    rankDepartureOptions([real('08:45', '09:13', 12)], { after: '08:37' }).length === 0);
  check('…but a 4-minute walk does',
    rankDepartureOptions([real('08:45', '09:13', 4)], { after: '08:37' }).length === 1);

  console.log('\n9. The row says which train, and how far the platform is');
  const one = live[0];
  check('the walk is stated', boardLabel(one, true).includes('12'));
  check('the vehicle departure is stated', boardLabel(one, true).includes('08:52'));
  check('the stop is named', boardLabel(one, true).includes('ההגנה'));
  check('arrival is the updated one', one.arriveAt === '09:20');
  check('slack is against the appointment', one.slackMinutes === 10);
  check('car/walk have no platform to miss',
    boardLabel({ ...one, boardAt: undefined, rides: 0 } as any, true) === '');

  console.log('\n10. A list already on screen can be re-checked without Google');
  const soonest = rankDepartureOptions([gone, next, after], { after: '08:10' })[0];
  check('at 08:10 the 08:25 is still listed', soonest.boardAt === '08:25');
  check('…and by 08:37 the same option reports itself gone',
    departureUncatchable(soonest, '08:37'));
  check('at 08:12 it was still catchable', !departureUncatchable(soonest, '08:12'));
  check('exactly on the last moment it still counts',
    !departureUncatchable(soonest, '08:13'));

  console.log('\n11. The countdown is to the WALK, not to the train');
  // A train at 08:52 twelve minutes from the door is decided at 08:40, not
  // 08:52. That gap is the whole reason she missed the last one.
  const decide = live.find((o) => o.boardAt === '08:52')!;
  check('at 08:37 there are 3 minutes to decide', minutesToDecide(decide, '08:37') === 3);
  check('at 08:40 there are none left', minutesToDecide(decide, '08:40') === 0);
  check('and it is only gone at 08:41', departureUncatchable(decide, '08:41'));
  check('under five minutes it says run', urgencyLabel(decide, '08:37', true).includes('🏃'));
  check('with room to spare it does not', !urgencyLabel(decide, '08:30', true).includes('🏃'),
    urgencyLabel(decide, '08:30', true));
  check('at the deadline it says leave now', urgencyLabel(decide, '08:40', true) === '🏃 צאי עכשיו');

  console.log('\n12. Which of the trains out of this station');
  /*
   * "also for trains it's important מספר רציף. if we check many optionals of
   * train they are from other platform."
   *
   * Google's Directions API returns no platform number for any Israeli
   * station. Inventing one is the worst possible lie to tell someone running
   * for a train, so it is never invented — the DIRECTION goes there instead,
   * which is how the departure boards are actually organised and what
   * separates two trains leaving the same station minutes apart.
   */
  const withDirection = rankDepartureOptions(
    [{ ...train('08:20', '09:10'), legs: train('08:20', '09:10').legs.map((l) =>
      (l.type === 'train' ? { ...l, headsign: 'בנימינה' } : l)) } as TransitPlan],
    { appointment: '09:30' },
  )[0];
  check('the direction is carried onto the option',
    withDirection.boardDirection === 'בנימינה', withDirection.boardDirection);
  check('and read as "towards", not as a platform',
    platformLabel(withDirection, true) === 'לכיוון בנימינה', platformLabel(withDirection, true));
  check('in English too', platformLabel(withDirection, false) === 'towards בנימינה');
  check('it reaches the line she actually reads',
    boardLabel(withDirection, true).includes('לכיוון בנימינה'), boardLabel(withDirection, true));

  // A real platform, the day a provider gives one, outranks the direction.
  const withPlatform = rankDepartureOptions(
    [{ ...train('08:20', '09:10'), legs: train('08:20', '09:10').legs.map((l) =>
      (l.type === 'train' ? { ...l, headsign: 'בנימינה', platform: '3' } : l)) } as TransitPlan],
    { appointment: '09:30' },
  )[0];
  check('a real platform number wins when there is one',
    platformLabel(withPlatform, true) === 'רציף 3', platformLabel(withPlatform, true));

  // And when we have neither, we say neither.
  const plain = rankDepartureOptions([train('08:20', '09:10')], { appointment: '09:30' })[0];
  check('no platform and no direction means an empty label, never a guess',
    platformLabel(plain, true) === '', JSON.stringify(platformLabel(plain, true)));
  check('and the board line still reads fine without it',
    boardLabel(plain, true).includes('08:20') && !boardLabel(plain, true).includes('רציף'),
    boardLabel(plain, true));

  // ── The pair of numbers she can actually check ──────────────────────────
  //
  // Koral looked up rail.co.il, read back "13:15-14:01, 13:20-13:58,
  // 13:30-14:16" and asked why none of them were offered. All three WERE. The
  // card's headline times are door to door — they include the walk at each end
  // — so her 13:15→14:01 train appears there as 13:03→14:02, and the one pair
  // she could verify against was the pair we never printed.
  const checkable = rankDepartureOptions([train('13:03', '14:02')], { appointment: '14:30' })[0];
  check('the vehicle\'s own two times are printed, as a pair, as a timetable prints them',
    boardLabel(checkable, true).includes('13:03–14:02'), boardLabel(checkable, true));
  check('and the door-to-door times are still their own separate thing',
    checkable.departAt === '13:03' && checkable.arriveAt === '14:02');

  // ── "score the options and offer the best way" ──────────────────────────
  //
  // Her three axes, verbatim: "fastest route, Earliest arrival, latest
  // departure". They disagree with each other on purpose, which is the point —
  // the ranker picks one and the list says what each of the others is best at.
  const scored = rankDepartureOptions(
    [
      train('13:03', '14:02'),   // 59 min
      train('13:09', '13:59'),   // 50 min — fastest AND earliest arrival
      train('13:18', '14:17'),   // 59 min — latest departure
    ],
    { appointment: '14:30', max: 5 },
  );
  check('three options, in timetable order', scored.length === 3, `${scored.length}`);
  check('the fastest is named', scored[1].superlatives.includes('fastest'), scored[1].arriveAt);
  check('so is the earliest arrival', scored[1].superlatives.includes('earliest'));
  check('and the latest departure, which is a different option',
    scored[2].superlatives.includes('latest') && !scored[2].superlatives.includes('fastest'));
  check('an option that wins nothing claims nothing',
    scored[0].superlatives.length === 0, superlativeLabel(scored[0], true));
  for (const [he, want] of [[true, 'הכי מהירה'], [false, 'fastest']] as const) {
    check(`[${he ? 'he' : 'en'}] and it is said in her language`,
      superlativeLabel(scored[1], he).includes(want), superlativeLabel(scored[1], he));
  }

  // A superlative on an option that misses the appointment is worse than none:
  // "earliest arrival" over something arriving after the interview started.
  const withLate = rankDepartureOptions(
    [train('13:09', '13:59'), train('14:20', '15:10')],
    { appointment: '14:30', max: 5 },
  );
  check('a late option is never crowned',
    withLate[1].late && withLate[1].superlatives.length === 0);
  check('...and the on-time one keeps every award it earned',
    withLate[0].superlatives.length === 3, superlativeLabel(withLate[0], false));

  // When NOTHING arrives in time the axes are all she has left, so they apply.
  const allLate = rankDepartureOptions(
    [train('14:40', '15:20'), train('15:00', '15:55')],
    { appointment: '14:30', max: 5 },
  );
  check('when every option is late they are still scored against each other',
    allLate[0].superlatives.includes('fastest') && allLate[1].superlatives.includes('latest'),
    `${superlativeLabel(allLate[0], false)} | ${superlativeLabel(allLate[1], false)}`);

  // Ties are shared, not broken by position — two trains arriving the same
  // minute are both the earliest, and crowning one invents a difference.
  const tied = awardSuperlatives([
    { ...scored[1], arriveAt: '13:59', durationMinutes: 50 },
    { ...scored[0], arriveAt: '13:59', durationMinutes: 50 },
  ]);
  check('a tie is shared',
    tied[0].superlatives.includes('earliest') && tied[1].superlatives.includes('earliest'));

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
