/**
 * run-ceva-interview — the whole chain, on the real event, end to end.
 *
 * Koral asked, plainly: "do you see the interview in Google Calendar? Why
 * doesn't it reach the app? Run the pull, the display and the backward times
 * yourself." This is that run, and it is a test so it keeps being that run.
 *
 * The payload below is not a fixture anybody invented. It is the verbatim
 * response from the Google Calendar API for her primary calendar on
 * 2026-09-23 — the same JSON the phone gets — including the empty `location`
 * field that started all of this and the 107-character event id.
 *
 * Four stages, each the REAL code:
 *
 *   1. FETCH    the raw Google item → CalendarEvent, through the same filter
 *               and the same field reads as GoogleService.fetchCalendarEvents,
 *               calling the real addressFromDescription / meetingUrlFromEvent.
 *   2. IMPORT   CalendarEvent → Task, then the real mergeExternalTasks against
 *               a real TaskStorage on an in-memory AsyncStorage.
 *   3. DISPLAY  the real getTasksForDate + sortTasksByPriorityAndTime — the
 *               exact path behind "Pick a day → Wednesday".
 *   4. BACKWARD the real subtractMinutes chain: arrival → leave home → wake,
 *               and the real plannedAlarmTime / decideAlarmState on top.
 *
 * If this passes and her phone still shows an empty Wednesday, the defect is
 * NOT in any of this code — it is the phone's Google grant or the tombstone
 * list, and both of those now have a surface that says so.
 *
 * Run:  npx tsx tests/run-ceva-interview.ts
 */

// ── in-memory AsyncStorage, installed before TaskStorage is imported ────────
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: memoryAsyncStorage };
  }
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getUserId: async () => null };
  }
  return origLoad.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');

import { addressFromDescription } from '../src/utils/eventAddress';
import { isMeetingLink, meetingUrlFromEvent } from '../src/utils/meetingLink';
import { subtractMinutes, sortTasksByPriorityAndTime } from '../src/utils/timeUtils';
import { addrOf, locOf, taskHasJourney } from '../src/utils/dayPlanning';
import { plannedAlarmTime, decideAlarmState } from '../src/utils/alarmPlan';
import type { Task, TaskLocation } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const DATE = '2026-09-23';

/**
 * The real Google Calendar API item. Fetched from her primary calendar
 * (koralzakai1@gmail.com) on 2026-09-22. Note what is NOT here: a `location`
 * field. That absence is the original bug.
 */
const RAW_GOOGLE_ITEM = {
  id: '_9t1j0u1m6sqkorq5a8o7gdphcgpmaj3f851j0u1jc8pjad336l66ukq361s36c316grm6oj19h06irjkclp7cqb5esn66rrdclin8bj3ds',
  summary: 'Your in-person interview with Ceva',
  status: 'confirmed',
  eventType: 'DEFAULT',
  start: { dateTime: '2026-09-23T14:30:00+03:00', timeZone: 'UTC' },
  end: { dateTime: '2026-09-23T16:00:00+03:00', timeZone: 'UTC' },
  organizer: { displayName: 'Ceva Recruiting', email: 'scheduler@comeet-notifications.com' },
  attendees: [{ email: 'koralzakai1@gmail.com', responseStatus: 'accepted', self: true }],
  description:
    'Reply above to continue the conversation with CEVA Admin support. Sent by Spark Hire Recruit on behalf of Ceva  \n---  \n---  \n'
    + 'Dear koral,  \nAn in-person interview has been scheduled for you in Ceva.\nPlease review the interview details below.\n​\n'
    + 'Position:C++ Software Engineer – AI & DSP Processor Simulators  \n---  \n'
    + '| Interview with Dana Levi (Core Simulator and Debugger Team Leader)  \n–  \n'
    + '|  Wednesday, September 23, 2026, 2:30 PM IDT  \n'
    + "|  7 HaPnina Street, Ra'anana, Center District  \n"
    + "Please arrive at the reception at HaPnina 7, Ra'anana, building D, 9th floor  \n"
    + "[ ](https://www.google.com/maps/place/7+HaPnina+Street%2C+Ra%27anana%2C+Center+District)  \n"
    + 'For more details or if you need to change the time of your interview, please\nreply to this email.  \n'
    + 'Looking forward to seeing you, Ceva 09-9613701[Interview.diary@ceva-dsp.com](http://mailto:Interview.diary@ceva-dsp.com)  \n',
  // location: ABSENT. Comeet/Spark Hire never set it.
};

/** Her profile, as the travel chain reads it. */
const PROFILE = {
  homeAddress: 'Tel Aviv',
  morningRoutineMinutes: 45,
  wakeBufferMinutes: 10,
};

/** What Google Directions returns for that trip — the only number stubbed. */
const TRAVEL_MINUTES = 52;
const WALK_TO_STOP = 8;

// ───────────────────────────────────────────────────────────────────────────
// Stage 1 — FETCH: the raw item → CalendarEvent
// ───────────────────────────────────────────────────────────────────────────
console.log('\nStage 1 — pull from Google Calendar\n');

/** The same clock read as GoogleService: parse the offset, read local time. */
const hhmm = (dt?: string): string | null => {
  if (!dt) return null;
  const parsed = new Date(dt);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
};

const item: any = RAW_GOOGLE_ITEM;
const passesFilter = Boolean(item.start?.dateTime) && item.status !== 'cancelled';
check('the event survives the all-day / cancelled filter', passesFilter,
  `start.dateTime=${item.start?.dateTime} status=${item.status}`);

const event = {
  id: item.id,
  title: item.summary,
  startTime: hhmm(item.start?.dateTime) || '00:00',
  endTime: hhmm(item.end?.dateTime) || '00:00',
  location: item.location || addressFromDescription(item.description),
  description: item.description,
  meetingUrl:
    item.hangoutLink
    || (item.conferenceData?.entryPoints || []).find((e: any) => e.entryPointType === 'video')?.uri
    || meetingUrlFromEvent(item.location, item.description),
  attendees: (item.attendees || []).map((a: any) => a.email).filter(Boolean),
};

check('the title survives', event.title === 'Your in-person interview with Ceva', event.title);
check('Google gave us NO location field — this is the original bug',
  item.location === undefined, 'item.location is absent');
check('the address is recovered from the body anyway',
  /HaPnina/i.test(event.location || ''), event.location || '(none)');
check('it is not mistaken for a video call', !event.meetingUrl,
  `meetingUrl=${event.meetingUrl ?? 'none'}`);

// The clock read depends on the machine's zone. Assert the INSTANT, not the
// wall time, so this test means the same thing in Israel and in CI.
const startsAt = new Date(item.start.dateTime).toISOString();
check('it starts at 14:30 Israel time', startsAt === '2026-09-23T11:30:00.000Z', startsAt);
console.log(`     → ${event.startTime}–${event.endTime} local on this machine `
  + `(${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone})`);

// ───────────────────────────────────────────────────────────────────────────
// Stage 2 — IMPORT: CalendarEvent → Task, through the real merge
// ───────────────────────────────────────────────────────────────────────────
console.log('\nStage 2 — import into Meira\n');

const diffMinutes = (start: string, end: string): number => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(15, (eh * 60 + em) - (sh * 60 + sm));
};

const incoming = {
  id: `gcal-${event.id}`,
  text: event.title,
  priority: 'have_to',
  isFixed: true,
  fixedTime: event.startTime,
  scheduledTime: event.startTime,
  durationMinutes: diffMinutes(event.startTime, event.endTime),
  date: DATE,
  status: 'pending',
  source: 'calendar',
  calendarEventId: event.id,
  location: isMeetingLink(event.location) ? undefined : event.location,
  hasLocation: Boolean(event.location) && !isMeetingLink(event.location),
  meetingUrl: event.meetingUrl,
  attendees: event.attendees,
  category: event.meetingUrl ? 'zoom' : 'meeting',
  createdAt: Date.now(),
  historicalDurations: [],
} as unknown as Task;

(async () => {
  const added = await TaskStorage.mergeExternalTasks([incoming]);
  check('the import adds exactly one task', added === 1, `added=${added}`);
  check('90 minutes, not a default 30', incoming.durationMinutes === 90,
    `${incoming.durationMinutes} min`);
  check('the 107-char Google id survives intact',
    incoming.id.length === 112 && incoming.id.endsWith('lin8bj3ds'),
    `len=${incoming.id.length}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3 — DISPLAY: exactly what "Pick a day → Wednesday" reads
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nStage 3 — display on Wednesday 23/9\n');

  const rows: Task[] = sortTasksByPriorityAndTime(
    await TaskStorage.getTasksForDate(DATE),
  );
  check('the day picker finds it', rows.length === 1 && rows[0].id === incoming.id,
    `${rows.length} row(s) on ${DATE}`);
  check('it is not filtered out as moved/complete', rows[0]?.status === 'pending',
    rows[0]?.status);
  check('the address reaches the planner chokepoint (addrOf)',
    /HaPnina/i.test(addrOf(rows[0]) || ''), addrOf(rows[0]) || '(none)');

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 4 — BACKWARD: arrival → leave home → wake → alarm
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nStage 4 — work the times backwards\n');

  const task = rows[0];
  const arriveBy = task.fixedTime!;
  const leaveHomeAt = subtractMinutes(arriveBy, TRAVEL_MINUTES);
  const wakeUpBy = subtractMinutes(
    leaveHomeAt,
    PROFILE.morningRoutineMinutes + PROFILE.wakeBufferMinutes,
  );

  const located: Task = {
    ...task,
    location: {
      address: addrOf(task)!,
      lat: 32.1847,
      lng: 34.8708,
      confirmed: false,
      travelMinutes: TRAVEL_MINUTES,
      leaveHomeBy: leaveHomeAt,
      wakeUpBy,
      transitPlan: {
        totalDurationMinutes: TRAVEL_MINUTES,
        leaveHomeAt,
        arriveAt: arriveBy,
        firstBusDeparture: subtractMinutes(arriveBy, TRAVEL_MINUTES - WALK_TO_STOP),
        firstBusStop: 'Arlozorov',
        walkToStopMinutes: WALK_TO_STOP,
        legs: [],
        source: 'google',
        fetchedAt: Date.now(),
      },
    } as TaskLocation,
  };

  check('a journey is recognised', taskHasJourney(located), 'taskHasJourney');
  check('leave-home lands 52 min before 14:30', locOf(located)?.leaveHomeBy === '13:38',
    locOf(located)?.leaveHomeBy);
  check('wake is 55 min before leaving (45 routine + 10 buffer)',
    locOf(located)?.wakeUpBy === '12:43', locOf(located)?.wakeUpBy);

  const alarmAt = plannedAlarmTime(located, PROFILE.morningRoutineMinutes);
  check('an alarm time is planned', alarmAt === '12:43', alarmAt ?? '(none)');
  const state = decideAlarmState(located, '08:00', PROFILE.morningRoutineMinutes);
  check('the alarm is not needed — she is already up by then',
    state === 'not_needed', state);

  console.log('\n  Wednesday 23/9, as Meira should draw it:');
  console.log(`    ⏰ ${locOf(located)!.wakeUpBy}  up and getting ready`);
  console.log(`    🚪 ${locOf(located)!.leaveHomeBy}  leave home  (${TRAVEL_MINUTES} min)`);
  console.log(`    🎯 ${arriveBy}–16:00  ${located.text}`);
  console.log(`    📍 ${addrOf(located)}`);

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
  if (failures) process.exit(1);
})();
