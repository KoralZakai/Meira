/**
 * run-personas — does Lumi calculate times correctly, for different people?
 *
 * Three invented users with genuinely different constraints:
 *   • Maya    — drives. Door-to-door, but parking eats the buffer.
 *   • Yonatan — bus + train from Binyamina to Tel Aviv. Timetables, not speeds.
 *   • Noa     — cycles. Short hops, no timetable, weather-independent here.
 *
 * Each gets a week that looks like a real calendar (interview, doctor, standup,
 * class, gym, a 10:00 meeting at Amazon towers). For every event the harness
 * runs the SAME code the app runs — utils/leadTime, utils/alertPlan,
 * utils/timeUtils — then prints the backward plan and every alert that would
 * fire, and asserts the arithmetic holds.
 *
 * Offline by default so the result is repeatable and reviewable: travel time
 * comes from the fixture, which is the ground truth the assertions check
 * against. `--live` swaps in the real Google Directions API instead.
 *
 * Run:  npx tsx tests/run-personas.ts
 *       npx tsx tests/run-personas.ts --persona=yonatan
 *       npx tsx tests/run-personas.ts --live
 *       npx tsx tests/run-personas.ts --json
 */
import { planTransitAlerts, planFixedTimeAlerts, PlannedAlert } from '../src/utils/alertPlan';
import { resolveLeadMinutes, DAY, DAY_BEFORE_HOUR } from '../src/utils/leadTime';
import { calculateWakeTime, timeToMinutes, minutesToTime } from '../src/utils/timeUtils';
import { Task, TaskCategory, TransitPlan, TransportType, UserProfile } from '../src/types/index';

// ── flags ────────────────────────────────────────────────────────────────────
const LIVE = process.argv.includes('--live');
const JSON_OUT = process.argv.includes('--json');
const ONLY = (process.argv.find((a) => a.startsWith('--persona=')) || '').split('=')[1];

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Event {
  text: string;
  category: TaskCategory;
  /** Day offset from the run date, so the fixture never goes stale. */
  inDays: number;
  /** HH:MM the thing actually starts. */
  at: string;
  destination: string;
  /** Ground-truth door-to-door minutes for this persona (offline mode). */
  travelMinutes: number;
  /** Explicit user-set lead times, when the persona asked for one. */
  remindMinutesBefore?: number[];
}

interface Persona {
  id: string;
  profile: UserProfile;
  /** How long parking / locking up / walking the last stretch takes. */
  arrivalFrictionMinutes: number;
  events: Event[];
}

const baseProfile = (over: Partial<UserProfile>): UserProfile => ({
  name: 'x',
  language: 'he',
  theme: 'light',
  transportType: 'bus',
  morningRoutineMinutes: 45,
  wakeBufferMinutes: 15,
  homeAddress: '',
  homeLat: 0,
  homeLng: 0,
  defaultWakeTime: '07:00',
  sleepTime: '23:00',
  googleConnected: false,
  createdAt: Date.now(),
  ...over,
});

const PERSONAS: Persona[] = [
  {
    id: 'maya',
    arrivalFrictionMinutes: 10, // parking
    profile: baseProfile({
      name: 'Maya',
      transportType: 'car',
      homeAddress: 'רמת גן, ביאליק 20',
      homeLat: 32.0823, homeLng: 34.8113,
      morningRoutineMinutes: 50,
      wakeBufferMinutes: 15,
      defaultWakeTime: '06:45',
      sleepTime: '23:30',
    }),
    events: [
      { text: 'ראיון עבודה', category: 'interview', inDays: 1, at: '10:00',
        destination: 'מגדלי אמזון, תל אביב', travelMinutes: 35 },
      { text: 'תור לרופא שיניים', category: 'doctor', inDays: 2, at: '08:30',
        destination: 'אבן גבירול 30, תל אביב', travelMinutes: 25 },
      { text: 'סטנדאפ צוות', category: 'meeting', inDays: 2, at: '11:00',
        destination: 'יגאל אלון 98, תל אביב', travelMinutes: 20 },
      { text: 'אימון ערב', category: 'gym', inDays: 3, at: '19:00',
        destination: 'Space Gym', travelMinutes: 12 },
    ],
  },
  {
    id: 'yonatan',
    arrivalFrictionMinutes: 8, // walk from the station
    profile: baseProfile({
      name: 'Yonatan',
      transportType: 'bus',
      homeAddress: 'בנימינה, הרצל 5',
      homeLat: 32.5182, homeLng: 34.9483,
      morningRoutineMinutes: 40,
      wakeBufferMinutes: 20,
      defaultWakeTime: '05:30',
      sleepTime: '23:00',
    }),
    events: [
      // The long commute: the one where an "in 1 hour" ping is useless because
      // he is already on the train.
      { text: 'כנס מפתחים', category: 'conference', inDays: 1, at: '09:00',
        destination: 'אקספו תל אביב', travelMinutes: 95 },
      { text: 'ראיון', category: 'interview', inDays: 3, at: '14:00',
        destination: 'מגדלי אמזון, תל אביב', travelMinutes: 105 },
      { text: 'שיעור אנגלית', category: 'class', inDays: 2, at: '16:30',
        destination: 'בנימינה מרכז', travelMinutes: 10,
        remindMinutesBefore: [30] }, // the exact case from the bug report
      { text: 'שיחה עם HR', category: 'call', inDays: 1, at: '17:00',
        destination: '', travelMinutes: 0 },
      // The genuine alarm case: normally up at 05:30, this forces ~04:00.
      { text: 'רכבת מוקדמת לירושלים', category: 'work', inDays: 4, at: '07:00',
        destination: 'ירושלים', travelMinutes: 120 },
    ],
  },
  {
    id: 'noa',
    arrivalFrictionMinutes: 5, // locking the bike
    profile: baseProfile({
      name: 'Noa',
      transportType: 'bike',
      homeAddress: 'דיזנגוף 100, תל אביב',
      homeLat: 32.0797, homeLng: 34.7738,
      morningRoutineMinutes: 30,
      wakeBufferMinutes: 10,
      defaultWakeTime: '07:15',
      sleepTime: '00:00',
    }),
    events: [
      { text: 'משמרת בוקר', category: 'work', inDays: 1, at: '09:00',
        destination: 'רוטשילד 22, תל אביב', travelMinutes: 14 },
      { text: 'חוג קרמיקה', category: 'hobby_class', inDays: 2, at: '18:00',
        destination: 'פלורנטין', travelMinutes: 18 },
      // Early start: the lead times cross back over midnight.
      { text: 'טיסה מוקדמת', category: 'general', inDays: 4, at: '00:40',
        destination: 'נתב"ג', travelMinutes: 40, remindMinutesBefore: [DAY, 180, 60] },
    ],
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const RUN_DATE = new Date();
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateIn = (days: number) => {
  const d = new Date(RUN_DATE);
  d.setDate(d.getDate() + days);
  return iso(d);
};

/** Interviews aim to be standing there 30 min early — see commit b2525ea. */
const EARLY_ARRIVAL: Partial<Record<TaskCategory, number>> = { interview: 30, conference: 15 };

/**
 * A TransitPlan for offline runs, built from the fixture's ground-truth travel
 * time. Legs are shaped like the real thing so planTransitAlerts has something
 * honest to render.
 */
function offlinePlan(ev: Event, persona: Persona, arriveBy: string): TransitPlan {
  const total = ev.travelMinutes + persona.arrivalFrictionMinutes;
  const leaveHomeAt = minutesToTime(timeToMinutes(arriveBy) - total);
  const mode = persona.profile.transportType;
  const isTransit = mode === 'bus';
  const walkToStop = isTransit ? 7 : 0;
  const rideStart = minutesToTime(timeToMinutes(leaveHomeAt) + walkToStop);
  return {
    totalDurationMinutes: total,
    leaveHomeAt,
    arriveAt: arriveBy,
    firstBusDeparture: rideStart,
    firstBusStop: isTransit ? 'תחנת הרכבת בנימינה' : persona.profile.homeAddress,
    walkToStopMinutes: walkToStop,
    legs: isTransit
      ? [
          { type: 'walk', from: 'בית', to: 'תחנה', durationMinutes: walkToStop,
            departureTime: leaveHomeAt, arrivalTime: rideStart },
          { type: 'train', from: 'תחנה', to: ev.destination, durationMinutes: total - walkToStop,
            departureTime: rideStart, arrivalTime: arriveBy, lineNumber: 'רכבת' },
        ]
      : [
          { type: mode === 'car' ? 'walk' : 'walk', from: 'בית', to: ev.destination,
            durationMinutes: total, departureTime: leaveHomeAt, arrivalTime: arriveBy },
        ],
    source: 'manual',
    fetchedAt: Date.now(),
  };
}

async function livePlan(ev: Event, persona: Persona, arriveBy: string, date: string): Promise<TransitPlan | null> {
  const { getPlanForMode } = await import('../src/services/RoutePlanner');
  return getPlanForMode(persona.profile.transportType, ev.destination, arriveBy, persona.profile, date);
}

// ── the run ──────────────────────────────────────────────────────────────────
interface Failure { persona: string; event: string; check: string; detail: string }
const failures: Failure[] = [];
const report: any[] = [];

function check(ok: boolean, persona: string, event: string, name: string, detail: string) {
  if (!ok) failures.push({ persona, event, check: name, detail });
}

async function runPersona(persona: Persona) {
  const lines: string[] = [];
  const evJson: any[] = [];
  lines.push('');
  lines.push('═'.repeat(78));
  lines.push(`  ${persona.profile.name}  ·  ${persona.profile.transportType.toUpperCase()}  ·  ${persona.profile.homeAddress}`);
  lines.push(`  routine ${persona.profile.morningRoutineMinutes}m · buffer ${persona.profile.wakeBufferMinutes}m · wake ${persona.profile.defaultWakeTime} · sleep ${persona.profile.sleepTime}`);
  lines.push('═'.repeat(78));

  for (const ev of persona.events) {
    const date = dateIn(ev.inDays);
    // Being "on time" for an interview means being early for it.
    const early = EARLY_ARRIVAL[ev.category] ?? 0;
    const arriveBy = minutesToTime(timeToMinutes(ev.at) - early);

    const hasTravel = ev.travelMinutes > 0 && Boolean(ev.destination);
    const plan = hasTravel
      ? (LIVE ? await livePlan(ev, persona, arriveBy, date) : offlinePlan(ev, persona, arriveBy))
      : null;

    const travelTotal = plan?.totalDurationMinutes ?? 0;
    const { wakeBy, leaveHomeBy } = calculateWakeTime(
      arriveBy,
      travelTotal,
      persona.profile.morningRoutineMinutes,
      persona.profile.wakeBufferMinutes,
    );

    const task: Task = {
      id: `${persona.id}-${ev.text}`,
      text: ev.text,
      category: ev.category,
      priority: 'must',
      isFixed: true,
      fixedTime: ev.at,
      durationMinutes: 60,
      date,
      status: 'pending',
      createdAt: Date.now(),
      historicalDurations: [],
      remindMinutesBefore: ev.remindMinutesBefore,
      location: hasTravel
        ? {
            address: ev.destination,
            lat: 0, lng: 0,
            travelMinutes: travelTotal,
            wakeUpBy: wakeBy,
            leaveHomeBy: plan?.leaveHomeAt ?? leaveHomeBy,
            confirmed: true,
            transitPlan: plan ?? undefined,
          }
        : undefined,
    };

    const leadAlerts = planFixedTimeAlerts(task, 'he', plan?.leaveHomeAt);
    const travelAlerts = plan
      ? planTransitAlerts(task, plan, 'he', persona.profile.defaultWakeTime)
      : [];
    const all = [...leadAlerts, ...travelAlerts];

    // ── report ──
    lines.push('');
    lines.push(`  ▸ ${ev.text}   [${ev.category}]   ${date}  ${ev.at}`);
    if (hasTravel) {
      lines.push(`     → ${ev.destination}`);
      lines.push(`     travel ${travelTotal}m${early ? `   · aiming to arrive ${early}m early (${arriveBy})` : ''}`);
      lines.push(`     wake ${wakeBy}  →  leave ${plan?.leaveHomeAt ?? leaveHomeBy}  →  arrive ${arriveBy}  →  starts ${ev.at}`);
    } else {
      lines.push(`     no travel`);
    }
    const leads = resolveLeadMinutes(task);
    lines.push(`     lead times: ${leads.map((m) => (m >= DAY ? `${m / DAY}d` : `${m}m`)).join(', ')}${ev.remindMinutesBefore ? '  (user-set)' : '  (default)'}`);
    for (const a of sortAlerts(all, date)) {
      lines.push(`       ${absolute(date, a).padEnd(17)} ${a.kind.padEnd(15)} ${a.title}`);
    }

    // ── assertions ──
    const startAbs = abs(date, ev.at, 0);
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

    // Every clock string that reaches a notification must be a real HH:MM.
    // A 00:40 flight used to produce "-2:-45" here and silently poison the
    // trigger, the alert body and the leave-now screen.
    for (const [label, value] of [['wakeBy', wakeBy], ['leaveHomeBy', plan?.leaveHomeAt ?? leaveHomeBy]] as const) {
      if (value) {
        check(HHMM.test(value), persona.id, ev.text, 'valid-clock-time',
          `${label} = "${value}" is not a valid HH:MM`);
      }
    }
    for (const a of all) {
      check(HHMM.test(a.at), persona.id, ev.text, 'valid-clock-time',
        `${a.kind} at = "${a.at}" is not a valid HH:MM`);
      const at = absMs(date, a);
      check(at < startAbs, persona.id, ev.text, 'alert-before-start',
        `${a.kind} at ${absolute(date, a)} is not before ${date} ${ev.at}`);
    }

    // A wake-from-sleep alarm and a "start getting ready" nudge are different
    // things. "קום!" at 17:33 for an evening gym session is the single loudest
    // way for an assistant to feel stupid.
    //
    // The bound is the MORNING WINDOW, not "earlier than usual". This harness
    // asserted the latter until 2026-09-17, when Koral replaced the rule:
    // "a clock alarm must be every day according the schedule! in the AM
    // hours." So a 10:14 alarm for an 11:00 class is now correct and a 17:33
    // one is still not — which is the failure this check was really written to
    // catch, and it still catches it.
    for (const a of all.filter((x) => x.kind === 'wake_up')) {
      const mins = timeToMinutes(a.at);
      check(mins <= 11 * 60 || mins < 2 * 60, persona.id, ev.text, 'alarm-only-wakes-from-sleep',
        `wake alarm at ${a.at} — outside the morning window, so it is a nudge, not an alarm`);
      check(a.urgent === true, persona.id, ev.text, 'alarm-is-alarm-grade',
        'wake_up must be urgent (MAX-importance channel)');
    }
    // …and when it is not an alarm, the prep nudge must still exist.
    if (plan && typeof task.location === 'object' && task.location?.wakeUpBy) {
      const prep = all.filter((x) => x.kind === 'wake_up' || x.kind === 'get_ready');
      check(prep.length === 1, persona.id, ev.text, 'exactly-one-prep-alert',
        `expected one wake_up OR get_ready, got ${prep.map((p) => p.kind).join(',') || 'none'}`);
      check(!prep.some((p) => p.kind === 'get_ready' && p.urgent), persona.id, ev.text,
        'get-ready-is-not-an-alarm', 'get_ready must not use the alarm channel');
    }
    if (plan) {
      // Wrap the comparison: a 23:55 departure legitimately arrives at 00:40.
      const wrap = (n: number) => ((n % 1440) + 1440) % 1440;
      const rideEnd = wrap(timeToMinutes(plan.leaveHomeAt) + plan.totalDurationMinutes);
      const slack = wrap(timeToMinutes(arriveBy) - rideEnd);
      check(slack <= 1 || slack > 1440 - 2, persona.id, ev.text, 'leave+travel<=arrive',
        `leave ${plan.leaveHomeAt} + ${plan.totalDurationMinutes}m lands ${minutesToTime(rideEnd)}, not ${arriveBy}`);
      const wakeGap = wrap(timeToMinutes(plan.leaveHomeAt) - timeToMinutes(wakeBy));
      check(wakeGap >= persona.profile.morningRoutineMinutes,
        persona.id, ev.text, 'wake-allows-routine',
        `only ${wakeGap}m between wake ${wakeBy} and leave ${plan.leaveHomeAt}, routine needs ${persona.profile.morningRoutineMinutes}m`);
    }
    // The day-before heads-up must land the previous evening, not 24h sharp.
    for (const a of all.filter((x) => x.kind === 'day_before')) {
      check(a.at === `${String(DAY_BEFORE_HOUR).padStart(2, '0')}:00` && (a.dayOffset ?? 0) <= -1,
        persona.id, ev.text, 'day-before-lands-evening',
        `day_before at ${a.at} dayOffset ${a.dayOffset}`);
    }
    // No two alerts on the same minute — that is just a double buzz.
    const stamps = all.map((a) => absolute(date, a));
    check(new Set(stamps).size === stamps.length, persona.id, ev.text, 'no-duplicate-alert-times',
      `duplicates in ${stamps.join(' | ')}`);
    // A long commute must not get an "in 1 hour" ping he cannot act on.
    if (plan && timeToMinutes(plan.leaveHomeAt) <= timeToMinutes(arriveBy) - 60) {
      check(!all.some((a) => a.kind === 'hour_before'), persona.id, ev.text, 'no-useless-hour-ping',
        'hour_before fired even though he had already left');
    }

    evJson.push({
      event: ev.text, date, startsAt: ev.at, category: ev.category,
      arriveBy, travelMinutes: travelTotal,
      wakeBy, leaveHomeBy: plan?.leaveHomeAt ?? leaveHomeBy,
      leadMinutes: leads,
      alerts: sortAlerts(all, date).map((a) => ({ kind: a.kind, at: absolute(date, a), title: a.title })),
    });
  }

  report.push({ persona: persona.profile.name, transport: persona.profile.transportType, events: evJson });
  if (!JSON_OUT) console.log(lines.join('\n'));
}

// Absolute-time helpers: an alert's dayOffset shifts it off the task's date.
function abs(date: string, hhmm: string, dayOffset: number): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d + dayOffset, h, m).getTime();
}
const absMs = (date: string, a: PlannedAlert) => abs(date, a.at, a.dayOffset ?? 0);
function absolute(date: string, a: PlannedAlert): string {
  const t = new Date(absMs(date, a));
  return `${iso(t)} ${a.at}`;
}
const sortAlerts = (list: PlannedAlert[], date: string) =>
  [...list].sort((x, y) => absMs(date, x) - absMs(date, y));

async function main() {
  const chosen = ONLY ? PERSONAS.filter((p) => p.id === ONLY) : PERSONAS;
  if (!chosen.length) {
    console.error(`no persona "${ONLY}". try: ${PERSONAS.map((p) => p.id).join(', ')}`);
    process.exit(2);
  }
  if (!JSON_OUT) {
    console.log(`\nLumi time-calculation evaluation — ${LIVE ? 'LIVE Google Directions' : 'offline (fixture travel times)'}`);
    console.log(`run date ${iso(RUN_DATE)}`);
  }
  for (const p of chosen) await runPersona(p);

  if (JSON_OUT) {
    console.log(JSON.stringify({ runDate: iso(RUN_DATE), live: LIVE, report, failures }, null, 2));
  } else {
    console.log('');
    console.log('─'.repeat(78));
    if (failures.length === 0) {
      const events = report.reduce((n, r) => n + r.events.length, 0);
      console.log(`✅ all time checks passed — ${chosen.length} personas, ${events} events`);
    } else {
      console.log(`❌ ${failures.length} check(s) failed:`);
      for (const f of failures) console.log(`   [${f.persona}] ${f.event} — ${f.check}: ${f.detail}`);
    }
    console.log('─'.repeat(78));
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
