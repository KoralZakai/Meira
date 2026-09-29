/**
 * run-task-shape — an appointment, or work parked in a slot?
 *
 * The reported shape of the problem: "Submit CV" and "Prepare Lean Canvas"
 * were sitting on the timeline as five-hour blocks, colliding with a party and
 * a call, when they are not commitments at all — they are things to do today.
 *
 * Run:  npx tsx tests/run-task-shape.ts
 */
import {
  classifyShape, isTimeBound, isFlexibleTask, splitDayTasks, sortFlexible,
  isStandingTask,
} from '../src/utils/taskShape';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', text: 'thing', category: 'general', priority: 'need_to',
  isFixed: false, durationMinutes: 60, date: '2026-09-09', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as unknown as Task);

function main() {
  console.log('\nTask shape\n');

  console.log('1. The two from her screen');
  const cv = task({ id: 'cv', text: 'להגיש קורות חיים', scheduledTime: '16:00', durationMinutes: 300 });
  const canvas = task({ id: 'canvas', text: 'לעשות lean canvas model', category: 'work', scheduledTime: '13:10' });
  check('"Submit CV" is flexible, not a 5-hour commitment', isFlexibleTask(cv));
  check('…because nothing anchors it', classifyShape(cv).reason === 'no-anchor');
  check('"Prepare lean canvas" is flexible too', isFlexibleTask(canvas));

  console.log('\n2. What stays on the timeline');
  const trip = task({
    id: 'trip', text: 'נהריה', fixedTime: '11:30', isFixed: true,
    location: { address: '28, Gaaton, Nahariyya', lat: 33, lng: 35, confirmed: true },
  });
  check('a trip with a place is time-bound', isTimeBound(trip));
  check('…because she has to BE there', classifyShape(trip).reason === 'has-place');

  const call = task({ id: 'call', text: 'Your R&D Bottleneck', category: 'zoom', scheduledTime: '17:00' });
  check('a zoom call is time-bound even with no place', isTimeBound(call));
  check('…on the kind of thing it is', classifyShape(call).reason === 'appointment-kind');

  const fromCal = task({ id: 'g', text: 'standup', source: 'calendar', fixedTime: '09:30' });
  check('anything off the calendar is time-bound', isTimeBound(fromCal));
  check('…because someone else booked it', classifyShape(fromCal).reason === 'external');

  console.log('\n3. An hour on a task is not a commitment — whoever wrote it');
  /**
   * There used to be a fourth rule here: `isFixed && fixedTime` → time-bound,
   * with the reason 'fixed-time'. It reads as common sense and was wrong on
   * her real data — "להגיש קורות חיים" and "לעשות תכנית עסקית" both carry a
   * fixedTime, so both were classified as commitments and the flexible card,
   * built for exactly those two tasks, came back holding nothing.
   *
   * Why the field cannot carry that weight: half the creation paths set
   * isFixed, and Lumi's own optimiser writes an hour into fixedTime when it
   * parks a job in a slot. So it records "something put this here", not "this
   * is agreed with anybody". Three things mean a commitment — somewhere to
   * BE, a kind of thing that is an appointment, or a diary entry someone else
   * made — and an hour is not one of them.
   */
  const pinned = task({ id: 'p', text: 'gym', category: 'gym', isFixed: true, fixedTime: '19:00' });
  check('an hour she pinned herself does NOT anchor it',
    isFlexibleTask(pinned), classifyShape(pinned).reason);
  check('…nothing holds it to that hour', classifyShape(pinned).reason === 'no-anchor');

  // …and the guard that makes dropping that rule safe: the same session with
  // any ONE of the three real anchors is still a commitment. Without this the
  // test above would happily pass an implementation that called everything
  // flexible.
  const pinnedAtAPlace = task({
    id: 'pp', text: 'gym', category: 'gym', isFixed: true, fixedTime: '19:00',
    location: { address: 'Space Gym', lat: 32, lng: 34, confirmed: true },
  });
  check('the same session AT A PLACE stays on the timeline', isTimeBound(pinnedAtAPlace));
  check('…because she has to be there', classifyShape(pinnedAtAPlace).reason === 'has-place');

  const pinnedAppointment = task({
    id: 'pa', text: 'yoga', category: 'hobby_class', isFixed: true, fixedTime: '19:00',
  });
  check('…and an appointment KIND stays too', isTimeBound(pinnedAppointment));

  console.log('\n3b. Lumi\'s own guess is not a commitment either');
  const guessed = task({ id: 'g2', text: 'write the deck', scheduledTime: '13:00', isFixed: true });
  check('isFixed with only a scheduledTime does NOT anchor it',
    isFlexibleTask(guessed), classifyShape(guessed).reason);
  const alsoGuessed = task({ id: 'g3', text: 'emails', scheduledTime: '10:00' });
  check('a slot the optimiser chose stays moveable', isFlexibleTask(alsoGuessed));

  console.log('\n4. A place beats everything');
  const placedWork = task({
    id: 'pw', text: 'work', category: 'general',
    location: { address: 'the library', lat: 1, lng: 1, confirmed: true },
  });
  check('work you must do somewhere is time-bound', isTimeBound(placedWork));
  const emptyLoc = task({ id: 'el', text: 'work', location: { address: '   ', lat: 0, lng: 0, confirmed: false } as any });
  check('a blank address is not a place', isFlexibleTask(emptyLoc));
  const stringLoc = task({ id: 'sl', text: 'work', location: 'תל אביב' as any });
  check('a location stored as plain text still counts', isTimeBound(stringLoc));

  console.log('\n5. Splitting the day');
  const { timed, flexible } = splitDayTasks([cv, trip, canvas, call, fromCal]);
  check('three commitments go to the timeline', timed.length === 3, timed.map((t) => t.id).join(','));
  check('two pieces of work go to the flexible list',
    flexible.length === 2, flexible.map((t) => t.id).join(','));
  check('nothing is lost', timed.length + flexible.length === 5);
  check('nothing is duplicated',
    new Set([...timed, ...flexible].map((t) => t.id)).size === 5);

  console.log('\n6. The flexible list has a stable order');
  const must = task({ id: 'must', priority: 'must', scheduledTime: '18:00' });
  const nice = task({ id: 'nice', priority: 'nice_to_do', scheduledTime: '09:00' });
  const doneMust = task({ id: 'done', priority: 'must', status: 'complete', scheduledTime: '08:00' });
  const order = sortFlexible([nice, doneMust, must]).map((t) => t.id);
  check('unfinished before finished', order.indexOf('done') === 2, order.join(','));
  check('must before nice-to-do', order.indexOf('must') < order.indexOf('nice'));
  check('completed work is kept, not hidden',
    sortFlexible([nice, doneMust, must]).length === 3);
  check('the order does not change when re-sorted',
    sortFlexible(sortFlexible([nice, doneMust, must])).map((t) => t.id).join(',') === order.join(','));

  console.log('\n7. Standing work stays on the list until it is ticked');
  /*
   * Koral, 2026-09-22: "flexible tasks like 'להגיש קורות חיים' or 'create lean
   * canvas' supposed to go into the tasks. be there until they are signed with
   * V, no need to reschedule every day."
   *
   * getOverdueTasks was pure `date < today`, and the date on one of these is
   * the day she WROTE IT DOWN, not a day anybody agreed to. So the next
   * morning it appeared in the missed card being asked "did you do this? move
   * it? let it go?" — the same three questions, every morning. Rule 6: the
   * question has to fit the thing. You cannot be late for work nobody
   * scheduled.
   */
  const cvAgain = task({ id: 'cv2', text: 'להגיש קורות חיים' });
  const canvasAgain = task({ id: 'canvas2', text: 'create lean canvas', scheduledTime: '13:00' });
  check('her first example is standing work', isStandingTask(cvAgain), cvAgain.text);
  check('and so is her second', isStandingTask(canvasAgain), canvasAgain.text);
  check('an hour LUMI parked it in changes nothing — that is a guess, not a promise',
    isStandingTask(task({ id: 'cv3', text: 'להגיש קורות חיים', scheduledTime: '10:00' })));
  // The counterexample that pins the boundary: an hour SHE pinned.
  check('but an hour she pinned herself is a commitment she can miss',
    !isStandingTask(task({
      id: 'show', text: 'הופעה בערב של ברי סחרוף', fixedTime: '21:00', isFixed: true,
    })), 'and "did you go?" is the right question for it');

  // The three things that make it NOT standing, each for its own reason.
  check('a DEADLINE is an agreement, so passing one is a real miss',
    !isStandingTask(task({ id: 'd', deadline: '2026-09-20' })));
  check('...and so is a deadline with an hour on it',
    !isStandingTask(task({ id: 'dt', deadlineTime: '23:59' })));
  check('something already done is not waiting for anything',
    !isStandingTask(task({ id: 'c', status: 'complete' })));
  check('a place to be is a commitment, not a to-do',
    !isStandingTask(task({ id: 'p', location: { address: 'Ra\'anana' } as any })));
  check('an appointment category is one too',
    !isStandingTask(task({ id: 'i', category: 'interview' })));
  check('and a row somebody else put in her diary',
    !isStandingTask(task({ id: 'g', source: 'calendar' } as Partial<Task>)));

  // What it is for: it survives the day it was written on.
  const yesterday = task({ id: 'y', text: 'create lean canvas', date: '2026-09-21' });
  check('it is still standing the next morning', isStandingTask(yesterday));
  check('...and the next week', isStandingTask({ ...yesterday, date: '2026-09-01' } as Task));
  check('ticking it is the only thing that stops it',
    !isStandingTask({ ...yesterday, status: 'complete' } as Task));

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
