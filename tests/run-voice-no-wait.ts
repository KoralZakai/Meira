/**
 * run-voice-no-wait — the mic turn asks Meira without waiting for the street
 * name, and a slow calendar does not hold the plan for 5 s.
 *
 * 19.10, "super slow": runVoicePlan started the reverse-geocode only after the
 * transcript was in and waited up to 3 s for it before calling the server —
 * for a label, when the coordinates were already known. Then it waited up to
 * 5 s for the calendar before planning. The street name is now looked up while
 * she talks (beginVoiceContext) and taken only if it is already there.
 *
 *   npx tsx tests/run-voice-no-wait.ts
 */
const calls: Array<{ at: number; here: any }> = [];
let geocodeMs = 3000;
let calendarMs = 0;

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  const is = (name: string) => request === `./${name}` || request.endsWith(`/${name}`);
  if (is('CalendarAutoSync')) {
    return { __esModule: true, syncCalendarNow: () => new Promise((r) =>
      setTimeout(() => r({ added: 0, error: null, newTasks: [], ran: true }), calendarMs)) };
  }
  if (is('LocationService')) {
    return {
      __esModule: true,
      getHereDetailed: async () => ({ ok: true, lat: 32.08, lng: 34.78, fresh: false }),
      getAddressFromCoordinates: () => new Promise((r) => setTimeout(() => r('Ibn Gabirol 30'), geocodeMs)),
    };
  }
  if (is('LumiBrain')) {
    return { __esModule: true, brainTurn: async (_t: string, opts: any) => {
      calls.push({ at: Date.now(), here: opts.here });
      return { text: 'Saved', tasks: [] };
    } };
  }
  if (is('LumiServer')) return { __esModule: true, planDay: async () => ({ placed: [], unplaced: [] }) };
  if (is('TaskStorage')) {
    return {
      __esModule: true, getAllTasks: async () => [], getTasksForDate: async () => [],
      loadProfile: async () => null, toDateKey: () => '2026-10-19', updateTaskFields: async () => {},
    };
  }
  if (is('KnownPlacesStore')) return { __esModule: true, loadKnownPlaces: async () => ({}) };
  if (is('DayEvents')) return { __esModule: true, emitDayPlanned: () => {} };
  return origLoad.call(this, request, ...rest);
};

// Release-build-quiet: the flow's own step marks are console.warn.
console.warn = () => {};
const { beginVoiceContext, runVoicePlan } = require('../src/services/VoicePlanFlow');

let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\nThe mic turn does not wait for niceties\n');

  console.log('1. Street name slower than the transcript');
  geocodeMs = 3000; calendarMs = 0;
  let ctx = beginVoiceContext('he');
  let t0 = Date.now();
  await runVoicePlan('לקנות חלב', ctx, 'he');
  const waited = calls[0].at - t0;
  ok(waited < 300, 'Meira is asked at once, not after the lookup', `${waited} ms`);
  ok(calls[0].here?.lat === 32.08 && calls[0].here?.lng === 34.78, 'the coordinates go with it');
  ok(!('label' in calls[0].here), 'no street name yet → none sent (never a guess)');

  console.log('\n2. Street name already looked up while she talked');
  geocodeMs = 50;
  ctx = beginVoiceContext('he');
  await sleep(120);                        // she is still talking
  await runVoicePlan('לקנות חלב', ctx, 'he');
  ok(calls[1].here?.label === 'Ibn Gabirol 30', 'the label rides along when it is ready', String(calls[1].here?.label));

  console.log('\n3. A slow calendar holds the plan one second, not five');
  geocodeMs = 0; calendarMs = 8000;
  ctx = beginVoiceContext('he');
  t0 = Date.now();
  const report = await runVoicePlan('לקנות חלב', ctx, 'he');
  const total = Date.now() - t0;
  ok(total < 1600, 'the turn finishes without the calendar', `${total} ms`);
  ok(report.calendarError === null, '"not finished" is not reported as a Google error', String(report.calendarError));

  console.log(fail ? `\n❌ ${fail} failed\n` : '\n✅ all passed\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
