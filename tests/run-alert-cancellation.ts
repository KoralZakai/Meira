/**
 * run-alert-cancellation — "time to start getting ready" arrives ONCE.
 *
 * The reported bug: that notification showing up four times over. The alert
 * plan was never the problem (tests/run-alert-integrity proves planning twice
 * yields the identical set) — the cancel was. It cancelled exactly the ids
 * carried on the in-memory task object handed to it, and four different paths
 * schedule travel alerts for the same task, each persisting its own ids. A
 * caller holding an object loaded before another path wrote its ids cancelled
 * nothing, then scheduled a full second set. Four paths, four copies.
 *
 * The invariants of the fix:
 *   1. a stale (or empty) id list still cancels what is really outstanding
 *   2. re-planning N times leaves ONE set, not N
 *   3. alerts belonging to other tasks are never cancelled
 *   4. ids just scheduled are cancelled even if the OS list has not caught up
 *
 * Run:  npx tsx tests/run-alert-cancellation.ts
 */
import { identifiersToCancel, ScheduledLike } from '../src/utils/alertCancellation';
import { planTransitAlerts } from '../src/utils/alertPlan';
import { Task, TransitPlan } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return iso(d); })();

const task: Task = {
  id: 'yoga-1', text: 'יוגה', category: 'gym', priority: 'need_to',
  isFixed: true, fixedTime: '11:00', durationMinutes: 60, date: tomorrow,
  status: 'pending', createdAt: Date.now(), historicalDurations: [],
  location: { address: 'יגאל אלון 94', lat: 0, lng: 0, confirmed: true, wakeUpBy: '09:20' },
} as Task;

const plan: TransitPlan = {
  totalDurationMinutes: 17, leaveHomeAt: '10:43', arriveAt: '11:00',
  firstBusDeparture: '10:51', firstBusStop: 'ארלוזורוב', walkToStopMinutes: 4,
  legs: [
    { type: 'walk', from: 'home', to: 'ארלוזורוב', durationMinutes: 4, departureTime: '10:43', arrivalTime: '10:47' },
    { type: 'bus', from: 'ארלוזורוב', to: 'יגאל אלון', durationMinutes: 9, departureTime: '10:51', arrivalTime: '11:00', lineNumber: '189' },
  ],
  source: 'google', fetchedAt: Date.now(),
} as TransitPlan;

/**
 * A stand-in for the OS's scheduled list. `schedule` mirrors what
 * NotificationService does per alert; `cancel` mirrors the fixed cancel path.
 */
class FakeOS {
  private next = 0;
  items: ScheduledLike[] = [];

  schedule(taskId: string, kind: string): string {
    const identifier = `n${this.next += 1}`;
    this.items.push({ identifier, content: { data: { taskId, notificationType: kind } } });
    return identifier;
  }

  cancel(ids: string[]): void {
    const gone = new Set(ids);
    this.items = this.items.filter((i) => !gone.has(i.identifier));
  }

  kindsFor(taskId: string): string[] {
    return this.items
      .filter((i) => String((i.content?.data as any)?.taskId) === taskId)
      .map((i) => String((i.content?.data as any)?.notificationType));
  }
}

/** One scheduler run: cancel what is outstanding, then schedule a fresh set. */
function replan(os: FakeOS, staleIds: string[] | undefined): string[] {
  os.cancel(identifiersToCancel(os.items, task.id, staleIds));
  const alerts = planTransitAlerts(task, plan, 'he', '07:00') as any[];
  return alerts.map((a) => os.schedule(task.id, a.kind));
}

function main() {
  console.log('\nAlert cancellation\n');

  // The PREP alert, whichever channel it arrives on. This counted 'get_ready'
  // alone until 2026-09-17, when a morning commitment started raising a
  // 'wake_up' instead (Koral: "a clock alarm must be every day according the
  // schedule! in the AM hours") — and every count here silently became 0,
  // which is a passing-looking zero in three of the four checks below.
  //
  // This file is about DEDUPLICATION: one outstanding plan, not four. Which
  // kind the prep alert is has nothing to do with that, so it no longer
  // decides whether these checks can see anything.
  const prepCount = (os: FakeOS) =>
    os.kindsFor(task.id).filter((k) => k === 'get_ready' || k === 'wake_up').length;

  // ── 1. the bug, reproduced against the OLD rule ─────────────────────────
  console.log('1. The reported bug, reproduced');
  // The old cancel: stored ids only. Each path arrives with an empty/stale
  // list, so it cancels nothing and stacks another full set.
  const oldOS = new FakeOS();
  for (let path = 0; path < 4; path += 1) {
    oldOS.cancel([]); // what cancelling a stale id list actually achieved
    for (const a of planTransitAlerts(task, plan, 'he', '07:00') as any[]) {
      oldOS.schedule(task.id, a.kind);
    }
  }
  check('four paths with stale ids produced four prep alerts',
    prepCount(oldOS) === 4, `${prepCount(oldOS)}`);

  // ── 2. the fix: a stale list still cancels what is outstanding ──────────
  console.log('\n2. A stale id list no longer misses anything');
  const os = new FakeOS();
  replan(os, undefined);
  const afterFirst = prepCount(os);
  for (let path = 0; path < 3; path += 1) replan(os, undefined); // every caller stale
  check('one prep alert after the first run', afterFirst === 1, `${afterFirst}`);
  check('...still exactly one after four stale re-plans',
    prepCount(os) === 1, `${prepCount(os)}`);
  // Not "every kind is unique" — leave_nag legitimately repeats at several
  // offsets. The invariant is that what is outstanding equals ONE plan.
  const oneplan = (planTransitAlerts(task, plan, 'he', '07:00') as any[]).map((a) => a.kind);
  check('what is outstanding is exactly one plan, no more',
    os.kindsFor(task.id).sort().join() === oneplan.sort().join(),
    `${os.kindsFor(task.id).length} scheduled vs ${oneplan.length} planned`);

  // ── 3. other tasks are left alone ───────────────────────────────────────
  console.log('\n3. Another task\'s alerts are never touched');
  const shared = new FakeOS();
  const otherIds = [shared.schedule('interview-9', 'get_ready'), shared.schedule('interview-9', 'leave_home')];
  replan(shared, undefined);
  replan(shared, undefined);
  check('the other task keeps both of its alerts',
    shared.kindsFor('interview-9').length === 2, shared.kindsFor('interview-9').join(', '));
  check('...and they are the same rows, not rescheduled copies',
    otherIds.every((id) => shared.items.some((i) => i.identifier === id)));
  check('the re-planned task still has exactly one prep alert',
    prepCount(shared) === 1, `${prepCount(shared)}`);

  // ── 4. ids the OS list has not caught up with ───────────────────────────
  console.log('\n4. Freshly scheduled ids are cancelled even if the list lags');
  // A read taken before the schedule landed: the id is known to the caller but
  // absent from the OS list. Dropping it would leak an uncancellable alert.
  const lagging: ScheduledLike[] = [];
  check('an id missing from the list is still cancelled',
    identifiersToCancel(lagging, task.id, ['fresh-1']).includes('fresh-1'));
  check('an untagged alert is not swept up by accident',
    !identifiersToCancel([{ identifier: 'x', content: { data: {} } }], task.id).includes('x'));
  check('a numeric taskId still matches its string form',
    identifiersToCancel(
      [{ identifier: 'x', content: { data: { taskId: 42 as any } } }], '42').includes('x'));
  check('an empty task id sweeps nothing from the OS list',
    identifiersToCancel([{ identifier: 'x', content: { data: { taskId: 'a' } } }], '').length === 0);
  check('the union never repeats an identifier',
    identifiersToCancel(
      [{ identifier: 'dup', content: { data: { taskId: task.id } } }], task.id, ['dup'],
    ).length === 1);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
