/**
 * ScheduleQueryService — answering a question about the diary EXACTLY.
 *
 * Two questions, both of which were previously either turned into a task or
 * handed to a model that guessed:
 *
 *   "What do I have to do on Tuesday 1/9?"
 *       → the day, read back in clock order, with the leave time for anything
 *         that needs travelling to.
 *
 *   "Can I have a 2-hour meeting in Haifa on 2/9 at 14:00?"
 *       → a yes or a no, and the reason. The reason is the part that matters,
 *         and it is arithmetic, not opinion: does the block overlap something;
 *         can she GET there from wherever the previous appointment leaves her;
 *         can she get from there to whatever comes next. Travel is asked of
 *         Google for that date and hour, not assumed.
 *
 * A "no" always comes with the nearest window that WOULD work, because
 * "no" on its own sends her back to the calendar to do the search by hand.
 *
 * Her standing week counts as much as the diary does: a 16:00 school run is
 * never written down as a task, so a purely calendar-based "yes, 16:00 is
 * free" is exactly the answer that gets someone in trouble. Constrained hours
 * are removed from the windows, and a request that lands on one is refused by
 * name (utils/routines).
 *
 * When the travel legs can't be checked (no Maps key, no home address, no
 * network) the answer says so instead of quietly pretending the road is
 * clear — a confident wrong yes is how you miss a meeting.
 *
 * Dependencies: scheduleQuestion (parsing), findGaps, routines, TaskStorage,
 * UserProfileStorage, TravelEstimator. Consumed by screens/CoachChatScreen.
 */
import { AppLanguage, Task, TaskLocation, UserProfile } from '../types/index';
import { fitsInDay, findDayGaps, roundSlotStart } from '../utils/findGaps';
import { addMinutes, formatShortDate, getTodayString, timeToMinutes } from '../utils/timeUtils';
import { normalizeProfile } from '../utils/profileShape';
import {
  FeasibilityQuestion, DayAgendaQuestion, ScheduleQuestion, parseScheduleQuestion,
} from '../utils/scheduleQuestion';
import { Routine, constrainGaps, routinesForDate } from '../utils/routines';
import { loadRoutines } from './GapFillService';
import { getTasksForDate } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { TravelEstimate, TravelPoint, travelBetween } from './TravelEstimator';
import { PlaceHours, placeHours } from './LumiServer';
import { inferFromText } from '../utils/categorize';
import {
  FeasibilityOptions, Transition, feasibilityOptionsOf, isPhysical, judgeDay, marginOf, placeText, worstOf,
} from '../utils/dayFeasibility';
import { ReasonStep, isHighStakes } from '../utils/travelLadder';

/**
 * The answer, as a verdict and not only as a sentence. The sentence is what
 * she reads; the verdict is what a test, the chat and the planner can act on
 * without parsing prose.
 */
export type FeasibilityVerdict =
  | 'OK' | 'TIGHT' | 'OVERLAP' | 'INFEASIBLE_TRAVEL' | 'WAKE_CONFLICT'
  | 'ROUTINE' | 'PAST' | 'CLOSED' | 'NO_WINDOW';

export interface QueryAnswer {
  text: string;
  /** What was asked, for the caller's logs/telemetry. */
  question: Exclude<ScheduleQuestion, null>;
  /** Feasibility questions only. */
  verdict?: FeasibilityVerdict;
  /** Why — thought / action / observation, in order. */
  steps?: ReasonStep[];
  /** Opening hours, when the place has them: checked open / closed, or could not check. */
  hours?: 'open' | 'closed' | 'unknown';
  /** When the asked hour does not work: the nearest start that does, already checked. */
  alt?: string;
}

/** The id the "what if" block carries while the day is judged with it in. */
const PROPOSAL_ID = '__proposed__';

type HoursSource = (place: string, date: string, start: string, end: string) => Promise<PlaceHours>;
let hoursSource: HoursSource = placeHours;

/**
 * Where opening hours come from — the server's Google Places lookup unless
 * replaced. The seam exists for the same reason RoutePlanner has
 * setDirectionsGateway: a test can answer "the clinic closes at 19:00"
 * without a network, and the code under test stays the code that ships.
 */
export function setPlaceHoursSource(source: HoursSource | null): void {
  hoursSource = source ?? placeHours;
}

const asLoc = (t?: Task): TaskLocation | undefined =>
  t && t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

/** A task's place as an address Google can route to, if it has one. */
function placeOf(task?: Task): string | undefined {
  const loc = asLoc(task);
  if (loc) return loc.address || loc.displayName || undefined;
  if (task && typeof task.location === 'string' && task.location.trim()) return task.location;
  return undefined;
}

const timeOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;

/**
 * The trip between two points, by the travel ladder (TravelEstimator): the
 * minutes, the vehicle that answered and the reasoning. Null only when it
 * cannot be established at all — the caller then SAYS it could not check.
 * Coordinates travel with the address, so a straight-line estimate is still
 * possible when Google has nothing.
 */
async function travelEstimate(
  from: TravelPoint | undefined,
  to: TravelPoint | undefined,
  arriveBy: string,
  date: string,
  profile: UserProfile | null,
  highStakes: boolean,
): Promise<TravelEstimate | null> {
  if (!from?.address || !to?.address) return null;
  const clean = (p: TravelPoint): TravelPoint => ({
    address: p.address,
    ...(typeof p.lat === 'number' && typeof p.lng === 'number' && !(p.lat === 0 && p.lng === 0)
      ? { lat: p.lat, lng: p.lng } : {}),
  });
  return travelBetween(clean(from), clean(to), arriveBy, date, profile as UserProfile, { highStakes })
    .catch((e) => {
      console.warn('[ScheduleQuery] travel estimate failed', e);
      return null;
    });
}

/** "Tue 1/9" — the date, said the way she asked it. */
function dateLabel(date: string, language: AppLanguage): string {
  return formatShortDate(date, language);
}

/** The day, read back in clock order. */
export async function answerDayAgenda(
  q: DayAgendaQuestion,
  language: AppLanguage,
): Promise<QueryAnswer> {
  const he = language === 'he';
  const tasks = (await getTasksForDate(q.date).catch(() => [] as Task[]))
    .filter((t) => t.status !== 'moved');

  if (!tasks.length) {
    return {
      question: q,
      text: he
        ? `${dateLabel(q.date, language)} פנוי לגמרי — אין כלום ביומן ✨`
        : `${dateLabel(q.date, language)} is completely clear — nothing in the diary ✨`,
    };
  }

  const timed = tasks.filter(timeOf).sort((a, b) => timeToMinutes(timeOf(a)!) - timeToMinutes(timeOf(b)!));
  const untimed = tasks.filter((t) => !timeOf(t));

  const lines = timed.map((t) => {
    const leave = asLoc(t)?.leaveHomeBy;
    const where = placeOf(t);
    return `${timeOf(t)} · ${t.text}`
      + (where ? ` 📍${where}` : '')
      + (leave ? (he ? ` (יציאה ${leave})` : ` (leave ${leave})`) : '');
  });
  for (const t of untimed) lines.push(he ? `ללא שעה · ${t.text}` : `no time set · ${t.text}`);

  const head = he
    ? `${dateLabel(q.date, language)} — ${tasks.length} דברים:`
    : `${dateLabel(q.date, language)} — ${tasks.length} thing${tasks.length === 1 ? '' : 's'}:`;

  return { question: q, text: [head, ...lines].join('\n') };
}

/** Does [start, start+minutes) collide with anything already on that day? */
function collisions(tasks: Task[], start: string, minutes: number): Task[] {
  const from = timeToMinutes(start);
  const to = from + minutes;
  return tasks.filter((t) => {
    const s = timeOf(t);
    if (!s) return false;
    const tStart = timeToMinutes(s);
    const tEnd = tStart + (t.durationMinutes || 30);
    return tStart < to && tEnd > from;
  });
}

/**
 * Places whose door has hours — a clinic, a bank, a shop, a library. A meeting
 * at someone's office is not one: whoever invited her is holding the room.
 */
const HOURS_RE = /dentist|clinic|doctor|pharmac|bank|post office|library|municipal|city hall|store|shop|supermarket|mall|barber|salon|gym|רופא|שיניים|מרפאה|קופת חולים|בית מרקחת|בנק|דואר|ספרי|עירייה|חנות|סופר|קניון|מספרה|חדר כושר/i;

export function placeHasHours(what?: string, place?: string, category?: string): boolean {
  if (category === 'doctor' || category === 'gym') return true;
  return HOURS_RE.test(`${what ?? ''} ${place ?? ''}`);
}

/** "today" / "on Tue 13/10" — never "on Today". */
function onDate(date: string, language: AppLanguage): string {
  const label = dateLabel(date, language);
  if (language === 'he') return label === 'היום' || label === 'מחר' ? label : `ב${label}`;
  return label === 'Today' || label === 'Tomorrow' ? label.toLowerCase() : `on ${label}`;
}

const nowHHMM = (): string => new Date().toTimeString().slice(0, 5);


/** A task that has somewhere to BE — not a call, not a link, not placeless. */
const physical = (t: Task): boolean => isPhysical(t);

/** Everything one question needs, read once. */
interface AskContext {
  q: FeasibilityQuestion;
  he: boolean;
  tasks: Task[];
  profile: UserProfile | null;
  feas: FeasibilityOptions;
  homePoint?: TravelPoint;
  what: string;
  where?: string;
  category?: string;
  highStakes: boolean;
  withHours: boolean;
  obligations: Routine[];
}

/** One candidate slot, judged — the "observe" half of every step. */
interface SlotCheck {
  start: string;
  verdict: FeasibilityVerdict;
  /** Why not, in her language. Empty when it fits. */
  problem: string;
  inbound: number | null;
  outbound: number | null;
  inboundEst: TravelEstimate | null;
  originName: string;
  touching: Transition[];
  hours: PlaceHours | null;
  steps: ReasonStep[];
}

const fits = (v: FeasibilityVerdict) => v === 'OK' || v === 'TIGHT';

/**
 * Judge ONE start time: overlap, her standing week, the trips in and out, her
 * margin, her earliest wake, and — for a place with a door — its hours. The
 * same rule the day view uses (utils/dayFeasibility), with the new block in.
 */
async function checkSlot(ctx: AskContext, startTime: string): Promise<SlotCheck> {
  const { q, he, tasks, profile, feas, homePoint, what, where } = ctx;
  const steps: ReasonStep[] = [];
  const end = addMinutes(startTime, q.minutes);
  const ordered = [...tasks]
    .filter((t) => timeOf(t))
    .sort((a, b) => timeToMinutes(timeOf(a)!) - timeToMinutes(timeOf(b)!));
  // Where she will be coming FROM: the last place she is physically at before
  // this — a video call in between does not move her, so it is not an origin.
  const origin = ordered.filter((t) => physical(t) && timeToMinutes(timeOf(t)!) < timeToMinutes(startTime)).pop();
  const nextPlace = ordered.find((t) => physical(t) && timeToMinutes(timeOf(t)!) >= timeToMinutes(startTime));
  const originName = origin ? `"${origin.text}"` : (he ? 'הבית' : 'home');
  steps.push({
    thought: `${startTime}: she comes from ${origin ? `"${origin.text}" (${placeText(origin)})` : 'home'}`
      + `${nextPlace ? `; next place: "${nextPlace.text}" at ${timeOf(nextPlace)}` : '; nothing in person after'}.`,
  });

  const originPoint: TravelPoint | undefined = origin
    ? { address: placeText(origin), lat: asLoc(origin)?.lat, lng: asLoc(origin)?.lng }
    : homePoint;
  const [inboundEst, outboundEst] = await Promise.all([
    where ? travelEstimate(originPoint, { address: where }, startTime, q.date, profile, ctx.highStakes) : Promise.resolve(null),
    where && nextPlace
      ? travelEstimate({ address: where }, { address: placeText(nextPlace), lat: asLoc(nextPlace)?.lat, lng: asLoc(nextPlace)?.lng },
        timeOf(nextPlace)!, q.date, profile, isHighStakes(nextPlace))
      : Promise.resolve(null),
  ]);
  const inbound = inboundEst?.minutes ?? null;
  const outbound = outboundEst?.minutes ?? null;
  if (where) {
    steps.push({
      thought: `Trip in from ${origin ? `"${origin.text}"` : 'home'}`,
      action: `travel(${origin ? placeText(origin) : 'home'} → ${where}, arrive ${startTime})`,
      observation: inbound === null ? 'could not be checked'
        : `${inbound} min${inboundEst?.mode ? ` by ${inboundEst.rung === 'taxi' ? 'taxi' : inboundEst.mode}` : ''}${inboundEst?.noteEn ? ` (${inboundEst.noteEn})` : ''}`,
    });
    if (nextPlace) {
      steps.push({
        thought: `Trip on to "${nextPlace.text}"`,
        action: `travel(${where} → ${placeText(nextPlace)}, arrive ${timeOf(nextPlace)})`,
        observation: outbound === null ? 'could not be checked' : `${outbound} min`,
      });
    }
  }

  const proposal = {
    id: PROPOSAL_ID, text: what, category: ctx.category ?? 'general', fixedTime: startTime,
    durationMinutes: q.minutes, status: 'pending', date: q.date,
    location: where ? { address: where, lat: 0, lng: 0, confirmed: false } : undefined,
  } as unknown as Task;
  const travelInto = new Map<string, number>();
  if (where && inbound !== null) travelInto.set(PROPOSAL_ID, inbound);
  if (where && nextPlace && outbound !== null) travelInto.set(nextPlace.id, outbound);
  const judged = judgeDay([...tasks, proposal], feas, travelInto);
  const touching = judged.filter((t) => t.taskId === PROPOSAL_ID
    || (where && t.fromTaskId === PROPOSAL_ID)
    || (t.prevTaskId === PROPOSAL_ID && t.status === 'OVERLAP'));
  for (const t of touching) {
    const last = t.steps[t.steps.length - 1];
    if (last) steps.push({ thought: `Judge "${t.text}": ${last.thought}`, observation: last.observation });
  }

  const clash = collisions(tasks, startTime, q.minutes);
  const standing = ctx.obligations.find((r) =>
    timeToMinutes(r.time!) < timeToMinutes(end)
    && timeToMinutes(addMinutes(r.time!, r.durationMinutes)) > timeToMinutes(startTime));

  let verdict: FeasibilityVerdict = worstOf(touching.map((t) => t.status));
  let problem = '';
  if (standing) {
    verdict = 'ROUTINE';
    problem = he ? `זה נופל על "${standing.text}" (${standing.time})` : `that's your "${standing.text}" (${standing.time})`;
  } else if (clash.length) {
    verdict = 'OVERLAP';
    problem = he
      ? `זה מתנגש עם "${clash[0].text}" ב-${timeOf(clash[0])}`
      : `it clashes with "${clash[0].text}" at ${timeOf(clash[0])}`;
  } else if (verdict === 'OVERLAP') {
    const t = touching.find((x) => x.status === 'OVERLAP')!;
    const other = t.taskId === PROPOSAL_ID ? t.prevText : t.text;
    problem = he ? `זה מתנגש עם "${other}"` : `it clashes with "${other}"`;
  } else if (verdict === 'INFEASIBLE_TRAVEL') {
    const t = touching.find((x) => x.status === 'INFEASIBLE_TRAVEL')!;
    if (t.taskId === PROPOSAL_ID) {
      const freeFrom = addMinutes(startTime, -(t.gap ?? 0));
      problem = he
        ? `"${t.prevText}" נגמר ב-${freeFrom} ו-${inbound} דק׳ נסיעה לא מספיקים`
        : `"${t.prevText}" ends at ${freeFrom} and the ${inbound}-min trip won't make it`;
    } else {
      const nextT = tasks.find((x) => x.id === t.taskId);
      problem = he
        ? `לא תגיעי מ${where} ל"${t.text}" ב-${nextT ? timeOf(nextT) : ''} (${t.travel} דק׳ נסיעה)`
        : `you wouldn't get from ${where} to "${t.text}" at ${nextT ? timeOf(nextT) : ''} (${t.travel} min away)`;
    }
  } else if (verdict === 'WAKE_CONFLICT') {
    const t = touching.find((x) => x.status === 'WAKE_CONFLICT')!;
    problem = he
      ? `צריך לקום ב-${t.wake}, לפני ${t.earliestWake} שלך`
      : `you'd have to be up at ${t.wake}, before your ${t.earliestWake}`;
  }

  let hours: PlaceHours | null = null;
  if (fits(verdict) && ctx.withHours && where) {
    hours = await hoursFor(where, q.date, startTime, end);
    steps.push({
      thought: `"${what}" is somewhere with opening hours — check them.`,
      action: `placeHours(${where}, ${q.date}, ${startTime}–${end})`,
      observation: hours.known
        ? (hours.open ? `open (${hours.opens}–${hours.closes})` : `closed then${hours.opens ? ` (hours ${hours.opens}–${hours.closes})` : ''}`)
        : `unknown — ${hours.reason}`,
    });
    if (hours.known && !hours.open) {
      verdict = 'CLOSED';
      const name = hours.name || where;
      problem = hours.permanentlyClosed
        ? (he ? `נראה ש${name} נסגר לצמיתות` : `${name} looks permanently closed`)
        : hours.opens
          ? (he ? `${name} סגור אז (פתוח ${hours.opens}–${hours.closes})` : `${name} is closed then (open ${hours.opens}–${hours.closes})`)
          : (he ? `${name} סגור באותו יום` : `${name} is closed that day`);
    }
  }
  steps.push({ thought: `${startTime} → ${verdict}${problem ? ` (${problem})` : ''}.` });
  return { start: startTime, verdict, problem, inbound, outbound, inboundEst, originName, touching, hours, steps };
}

/** One lookup per place, date and slot while a question is being answered. */
const hoursMemo = new Map<string, Promise<PlaceHours>>();
function hoursFor(place: string, date: string, start: string, end: string): Promise<PlaceHours> {
  const key = `${place}|${date}|${start}|${end}`;
  if (!hoursMemo.has(key)) {
    hoursMemo.set(key, hoursSource(place, date, start, end)
      .catch(() => ({ known: false, reason: 'unreachable' } as PlaceHours)));
  }
  return hoursMemo.get(key)!;
}

/**
 * The nearest start that WORKS — proposed, then checked with the same rule,
 * and only then offered. A window opens when she is free; she can start once
 * she has got there from wherever that window finds her, with her margin in
 * hand. "14:30 works" while refusing 14:30 for want of a 43-minute trip was
 * the old version offering the window instead of the arrival.
 */
async function findWorkingSlot(
  ctx: AskContext,
  gaps: Array<{ start: string; end: string }>,
  near: string,
  steps: ReasonStep[],
  maxTries = 4,
): Promise<SlotCheck | null> {
  const margin = ctx.where ? Math.ceil(marginOf(ctx.feas)) : 0;
  const ordered = [...gaps]
    .filter((g) => timeToMinutes(g.end) - timeToMinutes(g.start) >= ctx.q.minutes)
    .sort((a, b) => Math.abs(timeToMinutes(a.start) - timeToMinutes(near))
      - Math.abs(timeToMinutes(b.start) - timeToMinutes(near)));
  let tries = 0;
  for (const g of ordered) {
    if (tries >= maxTries) break;
    tries += 1;
    // Where does this window find her, and how long to get from there?
    const probe = ctx.where ? await checkSlot(ctx, g.start) : null;
    const lead = (probe?.inbound ?? 0) + (probe?.inbound ? margin : 0);
    const start = roundSlotStart(addMinutes(g.start, lead));
    if (timeToMinutes(start) + ctx.q.minutes > timeToMinutes(g.end)) {
      steps.push({ thought: `Window ${g.start}–${g.end}: after a ${lead}-min trip and margin it no longer holds ${ctx.q.minutes} min → skip.` });
      continue;
    }
    const check = await checkSlot(ctx, start);
    steps.push({
      thought: `Try the window ${g.start}–${g.end}: start ${start} (trip ${probe?.inbound ?? 0} + margin ${probe?.inbound ? margin : 0}).`,
      action: `checkSlot(${start})`,
      observation: check.verdict,
    });
    if (fits(check.verdict)) return check;
  }
  return null;
}

/** Yes/no, with the arithmetic behind it — and the reasoning, step by step. */
export async function answerFeasibility(
  q: FeasibilityQuestion,
  language: AppLanguage,
): Promise<QueryAnswer> {
  const he = language === 'he';
  const today = getTodayString();
  const steps: ReasonStep[] = [];
  hoursMemo.clear();
  const profile = normalizeProfile(await loadProfile().catch(() => null));
  const tasks = (await getTasksForDate(q.date).catch(() => [] as Task[]))
    .filter((t) => t.status !== 'moved' && t.status !== 'complete' && t.status !== 'missed' && t.id !== q.ignoreId);
  const now = q.date === today ? nowHHMM() : undefined;
  // Nobody starts something this very minute: the soonest offer is five
  // minutes out, on a round number.
  const soonest = now ? roundSlotStart(addMinutes(now, 5)) : undefined;

  const dayStart = profile?.defaultWakeTime || '08:00';
  const dayEnd = (profile as any)?.sleepTime || '22:00';
  const routines: Routine[] = await loadRoutines().catch(() => []);
  const gaps = constrainGaps(
    findDayGaps(tasks, { dayStart, dayEnd, now: soonest, minMinutes: 15 }),
    routines,
    q.date,
  );
  const home = profile?.homeAddress;
  const category = q.what ? inferFromText(q.what).category : undefined;
  const ctx: AskContext = {
    q, he, tasks, profile,
    feas: feasibilityOptionsOf(profile),
    homePoint: home ? { address: home, lat: (profile as any)?.homeLat, lng: (profile as any)?.homeLng } : undefined,
    what: q.what || (he ? 'זה' : 'that'),
    where: q.place,
    category,
    highStakes: isHighStakes({ category }),
    withHours: Boolean(q.place) && placeHasHours(q.what, q.place, category),
    // The obligations that own part of THIS date — the pickup, the standing
    // shift. They are not tasks, so nothing else in this file would see them.
    obligations: routinesForDate(routines, q.date).filter((r) => r.kind === 'constraint' && r.time),
  };
  const { what, where } = ctx;
  const hoursTag = (h: PlaceHours | null): QueryAnswer['hours'] =>
    (h ? (h.known ? (h.open ? 'open' : 'closed') : 'unknown') : undefined);

  steps.push({
    thought: `Asked: ${q.minutes} min "${what}"${where ? ` at ${where}` : ''} on ${q.date}`
      + `${q.startTime ? ` at ${q.startTime}` : ' (no hour — find one)'}. `
      + `${tasks.length} thing(s) already that day; margin ${marginOf(ctx.feas)} min, earliest wake ${ctx.feas.earliestWake}`
      + `${now ? `; it is ${now} now` : ''}.`,
  });

  // ── A day that is already over. ──────────────────────────────────────────
  if (q.date < today) {
    steps.push({ thought: `${q.date} is before today (${today}) → it has passed.` });
    return {
      question: q, verdict: 'PAST', steps,
      text: he ? `${dateLabel(q.date, language)} כבר עבר.` : `${dateLabel(q.date, language)} has already passed.`,
    };
  }

  // ── An hour was named: check THAT block. ───────────────────────────────────
  if (q.startTime) {
    const startTime = q.startTime;
    const end = addMinutes(startTime, q.minutes);

    // "Now". A slot that has already gone is not free, however empty it was.
    if (now && startTime < now) {
      steps.push({ thought: `It is ${now} now and ${startTime} has passed → look for the nearest slot that works.` });
      const alt = await findWorkingSlot(ctx, gaps, soonest ?? now, steps);
      return {
        question: q, verdict: 'PAST', steps, alt: alt?.start,
        text: (he ? `לא ב-${startTime} — השעה כבר ${now}.` : `Not at ${startTime} — it's already ${now}.`)
          + (alt ? (he ? ` ${alt.start} כן עובד.` : ` ${alt.start} works.`) : (he ? ' אין חלון מתאים היום.' : ' No window left today.')),
      };
    }

    const slot = await checkSlot(ctx, startTime);
    steps.push(...slot.steps);
    const { verdict, inbound, inboundEst, hours, originName } = slot;

    if (fits(verdict)) {
      const modeNote = inboundEst?.noteEn ? (he ? ` (${inboundEst.noteHe})` : ` (${inboundEst.noteEn})`) : '';
      const travelNote = where
        ? (inbound === 0
          ? (he ? ` באותו מקום כמו ${originName} — בלי נסיעה.` : ` Same place as ${originName} — no trip.`)
          : inbound !== null
            ? (he ? ` נסיעה ${inbound} דק׳ מ${originName}${modeNote}.` : ` ${inbound} min from ${originName}${modeNote}.`)
            : (he ? ' לא הצלחתי לבדוק את זמן הנסיעה.' : " I couldn't check the travel time."))
        : '';
      const unknownHours = hours && !hours.known;
      const hoursNote = hours?.known && hours.open && hours.closes
        ? (he ? ` פתוח עד ${hours.closes}.` : ` Open till ${hours.closes}.`)
        : unknownHours ? (he ? ' לא הצלחתי לבדוק שעות פתיחה.' : " I couldn't check the opening hours.") : '';
      const lead = verdict === 'TIGHT'
        ? (he ? 'כן, אבל צפוף' : "Yes, but it's tight")
        : unknownHours ? (he ? 'כנראה' : 'Probably') : (he ? 'כן' : 'Yes');
      const tight = slot.touching.find((t) => t.status === 'TIGHT');
      const tightNote = tight
        ? (he
          ? ` רק ${(tight.gap ?? 0) - tight.travel} דק׳ רזרבה לפני "${tight.text}" — את צריכה ${Math.ceil(tight.margin)}.`
          : ` Only ${(tight.gap ?? 0) - tight.travel} min spare before "${tight.text}" — you want ${Math.ceil(tight.margin)}.`)
        : '';
      return {
        question: q, verdict, steps, hours: hoursTag(hours),
        text: he
          ? `${lead} — ${startTime}–${end} פנוי${where ? ` ב${where}` : ''}.${travelNote}${tightNote}${hoursNote}`
          : `${lead} — ${startTime}–${end} is free${where ? ` in ${where}` : ''}.${travelNote}${tightNote}${hoursNote}`,
      };
    }

    // No. Offer the nearest slot that does work — checked, not guessed.
    const alt = await findWorkingSlot(ctx, gaps, startTime, steps);
    return {
      question: q, verdict, steps, hours: hoursTag(hours), alt: alt?.start,
      text: (he
        ? `לא ב-${startTime} — ${slot.problem}.`
        : `Not at ${startTime} — ${slot.problem}.`)
        + (alt
          ? (he ? ` ${alt.start} כן עובד.` : ` ${alt.start} works.`)
          : (he ? ' אין חלון מתאים באותו יום.' : ' No window that day fits.')),
    };
  }

  // ── No hour named: find her one — the earliest that works. ─────────────────
  steps.push({
    thought: `Free windows${now ? ` from now (${now})` : ''}: ${gaps.map((g) => `${g.start}–${g.end}`).join(', ') || 'none'}.`,
  });
  const best = await findWorkingSlot(ctx, gaps, soonest ?? dayStart, steps);
  if (!best) {
    steps.push({ thought: 'No window holds it → say so.' });
    return {
      question: q, verdict: 'NO_WINDOW', steps,
      text: he
        ? `${dateLabel(q.date, language)} אין חלון של ${q.minutes} דק׳ ל${what}.`
        : `No ${q.minutes}-min window for ${what} ${onDate(q.date, language)}.`,
    };
  }
  steps.push(...best.steps);
  const bestEnd = addMinutes(best.start, q.minutes);
  const travelNote = best.inbound !== null && where
    ? (best.inbound === 0
      ? (he ? ` (באותו מקום כמו ${best.originName})` : ` (same place as ${best.originName})`)
      : (he ? ` (${best.inbound} דק׳ נסיעה מ${best.originName})` : ` (${best.inbound} min from ${best.originName})`))
    : '';
  const unknownHours = best.hours && !best.hours.known;
  const lead = best.verdict === 'TIGHT'
    ? (he ? 'כן, אבל צפוף' : "Yes, but it's tight")
    : unknownHours ? (he ? 'כנראה' : 'Probably') : (he ? 'כן' : 'Yes');
  return {
    question: q, verdict: best.verdict, steps, hours: hoursTag(best.hours), alt: best.start,
    text: he
      ? `${lead} — ${best.start}–${bestEnd} ${onDate(q.date, language)}${where ? ` ב${where}` : ''}.${travelNote}`
        + (unknownHours ? ' לא הצלחתי לבדוק שעות פתיחה.' : '')
      : `${lead} — ${best.start}–${bestEnd} ${onDate(q.date, language)}${where ? ` at ${where}` : ''}.${travelNote}`
        + (unknownHours ? " I couldn't check the opening hours." : ''),
  };
}

/**
 * The single entry point: is this message one of the two questions, and if so
 * what is the answer? Returns null when it is not — the caller then handles
 * the message exactly as it did before.
 */
export async function tryAnswerScheduleQuestion(
  text: string,
  language: AppLanguage,
  today = getTodayString(),
): Promise<QueryAnswer | null> {
  const question = parseScheduleQuestion(text, today);
  if (!question) return null;
  return question.kind === 'day_agenda'
    ? answerDayAgenda(question, language)
    : answerFeasibility(question, language);
}

export interface SaveCheck {
  /** true → it does not fit: warn and let her choose before anything is saved. */
  stop: boolean;
  verdict?: FeasibilityVerdict;
  /** The sentence to show her ("Not at 14:00 — …. 15:30 works."). */
  text: string;
  /** The nearest start that does work that day, checked with the same rule. */
  alt?: string;
  /** The check itself could not run — say so, never pretend it passed (rule 1). */
  error?: string;
}

/**
 * Before a task WITH an hour is saved (Koral, 28.10: "warn that it's impossible
 * and ask: save anyway, or find a new time"): the same travel-aware judgement
 * as "does X fit?" — the trip in from wherever the day finds her, the trip on
 * to the next place, her margin, her earliest wake, standing obligations,
 * opening hours. Only a verdict that does NOT fit stops the save; TIGHT is
 * still a yes (the answer says so).
 */
export async function checkBeforeSave(
  task: { text: string; date: string; fixedTime: string; durationMinutes?: number; place?: string; id?: string },
  language: AppLanguage,
): Promise<SaveCheck> {
  try {
    const a = await answerFeasibility({
      kind: 'feasibility', date: task.date, minutes: task.durationMinutes || 60,
      startTime: task.fixedTime, place: task.place || undefined, what: task.text, ignoreId: task.id,
    } as FeasibilityQuestion, language);
    const v = a.verdict;
    return { stop: !!v && !fits(v), verdict: v, text: a.text, alt: a.alt };
  } catch (e) {
    const error = String((e as Error)?.message || e).slice(0, 160);
    console.warn('[checkBeforeSave] could not check', error);
    return { stop: false, text: '', error };
  }
}
