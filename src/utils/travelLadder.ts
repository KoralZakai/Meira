/**
 * travelLadder — how she gets there, decided the way she would decide it.
 *
 * Koral's rule, 2026-09-27, verbatim:
 *
 *   "צריך להבין אם למשתמש יש אוטו או אין אוטו! ואז אם אין לו אוטו הוא מתנייד
 *    בצורה הכי חכמה יעילה זולה מהירה, קלה, בהתאם למה שיש. אם יש רכבת ישירה זה
 *    עדיף על אוטובוס, אם אין אז אוטובוס, האוטובוס הכי מהיר הכי קצר, אם אין אז
 *    קורקינט או אופניים — שוב אם הגיוני, או מונית או טרמפ — פה צריך שיקול דעת"
 *
 * THE BUG THIS CLOSES
 *
 * The feasibility answer asked Google for exactly one vehicle — her stored
 * one. A train preference and a short hop inside Tel Aviv came back as "no
 * rail route", and the answer was "Yes… I couldn't check the travel time":
 * a confident yes with nothing behind it. The route chain had half of the
 * ladder (rail, then bus) and nothing below it, so no-train-no-bus meant no
 * plan. And nothing anywhere knew whether she owns a car, so a cyclist with
 * a 30 km trip was planned by bike.
 *
 * THE LADDER
 *
 *   has a car, drives        → car.
 *   no car (or prefers transit):
 *     a short hop (≤ 1 km)   → walk. Nobody waits for a bus to go 800 m.
 *     otherwise              → public transport, ranked by transitFallback:
 *                              in time first, then direct train › direct bus ›
 *                              mixed, then the fastest.
 *     nothing in time        → bike / scooter, if the ride is short enough to
 *                              be reasonable (≤ 5 km, ≤ 35 min).
 *     still nothing          → her own car if she has one, else a taxi or a
 *                              ride. That is the judgement step: for something
 *                              that matters (interview, doctor, a must) it is
 *                              the plan; for anything else it is offered with
 *                              "or move it", because a taxi to the gym is a
 *                              choice she makes, not one made for her.
 *   prefers walking / cycling → honoured first while the trip is reasonable
 *                              for it, then the ladder above.
 *
 * Rule 9 still holds: a preference is honoured first and then the question
 * is answered anyway, and whatever answered is said out loud when it is not
 * what she asked for. Every decision here also carries its REASONS as steps
 * — thought, action, observation — so she can read why, and correct it.
 *
 * Pure. The network is injected (`ask`), so the arithmetic of "which next" is
 * testable on its own. Consumers: services/TravelEstimator,
 * services/GoogleSync.ensureTravelChain.
 */
import { AppLanguage, TransitPlan, TransportType } from '../types/index';
import { arrivesInTime } from './transitFallback';

/** One rung: a way of getting there that the ladder may try. */
export type TravelRung = 'car' | 'transit' | 'walk' | 'bike' | 'taxi';

/** One reasoning step, ReAct-shaped: what I thought, what I did, what I saw. */
export interface ReasonStep {
  thought: string;
  action?: string;
  observation?: string;
  /** Hebrew, for the steps that reach her screen ("Why this way?"). */
  thoughtHe?: string;
  observationHe?: string;
}

export interface LadderContext {
  /** Her stored way of getting around (the profile, or what she chose for this place). */
  preferred: TransportType;
  /** Does she have a car to drive? See hasCarOf. */
  hasCar: boolean;
  /** Straight-line km between the two ends, when both have coordinates. */
  km?: number;
  /** Someone else is holding the slot: an interview, a doctor, a must. */
  highStakes: boolean;
  /**
   * She picked this vehicle for THIS trip by hand. Then it is the only rung —
   * a choice made on the card is not a preference to be second-guessed.
   */
  explicit?: TransportType;
}

/** A short hop: walking is the smartest, cheapest and quickest way. */
export const WALK_ALWAYS_KM = 1.0;
/** How far someone who prefers walking will walk. */
export const WALK_PREFERRED_KM = 2.5;
/** How far someone who prefers a bike or scooter will ride. */
export const RIDE_PREFERRED_KM = 7;
/** How far a bike / scooter is reasonable as a stand-in for a missing bus. */
export const RIDE_FALLBACK_KM = 5;
/** Longest walk the ladder will propose, by the route's own minutes. */
export const WALK_MAX_MINUTES = 40;
/** Longest ride the ladder will propose for a cyclist, by the route's own minutes. */
export const RIDE_PREFERRED_MAX_MINUTES = 45;
/** …and as a fallback for someone who did not ask to cycle. */
export const RIDE_FALLBACK_MAX_MINUTES = 35;

/**
 * Does she have a car?
 *
 * Asked in Profile ("Do you have a car?"). Until she answers, someone whose
 * way of getting around is the car has one and everyone else does not — the
 * safe side: planning a bus for a driver costs a few minutes, planning a car
 * for someone without one costs the appointment.
 */
export function hasCarOf(profile: { hasCar?: boolean; transportType?: TransportType } | null | undefined): boolean {
  if (typeof profile?.hasCar === 'boolean') return profile.hasCar;
  return profile?.transportType === 'car';
}

const HIGH_STAKES_CATEGORIES = ['interview', 'doctor', 'conference'];

/** Is being late to this one expensive? Priority first, then the kind of thing it is. */
export function isHighStakes(task: { priority?: string; category?: string } | null | undefined): boolean {
  if (!task) return false;
  return task.priority === 'must' || HIGH_STAKES_CATEGORIES.includes(String(task.category ?? ''));
}

const fmtKm = (km?: number) => (typeof km === 'number' ? `${km.toFixed(1)} km` : 'distance unknown');
const fmtKmHe = (km?: number) => (typeof km === 'number' ? `${km.toFixed(1)} ק״מ` : 'מרחק לא ידוע');
const MODE_HE: Record<string, string> = { train: 'רכבת', bus: 'אוטובוס', car: 'רכב', walk: 'הליכה', bike: 'אופניים' };
const RUNG_HE: Record<TravelRung, string> = {
  car: 'רכב', transit: 'תחבורה ציבורית', walk: 'ברגל', bike: 'אופניים/קורקינט', taxi: 'מונית',
};

/**
 * The rungs to try, best first, with the reasoning that ordered them.
 */
export function travelRungs(ctx: LadderContext): { rungs: TravelRung[]; steps: ReasonStep[] } {
  const steps: ReasonStep[] = [];
  const { preferred, hasCar, km } = ctx;
  const known = typeof km === 'number';

  if (ctx.explicit) {
    const rung = toRung(ctx.explicit);
    steps.push({
      thought: `She chose ${ctx.explicit} for this trip herself — that is the plan, no second-guessing.`,
      thoughtHe: `בחרת ${MODE_HE[ctx.explicit] ?? ctx.explicit} לנסיעה הזו בעצמך — זו התוכנית.`,
    });
    return { rungs: [rung], steps };
  }

  if (preferred === 'car' && hasCar) {
    steps.push({
      thought: `She has a car and drives (${fmtKm(km)}) → drive.`,
      thoughtHe: `יש לך רכב ואת נוהגת (${fmtKmHe(km)}) → ברכב.`,
    });
    return { rungs: ['car'], steps };
  }

  const rungs: TravelRung[] = [];
  steps.push({
    thought: hasCar
      ? `She has a car but prefers ${preferred}; ${fmtKm(km)}.`
      : `No car${preferred === 'car' ? ' (marked "car", but she said she has none)' : ''} — prefers ${preferred}; ${fmtKm(km)}.`,
    thoughtHe: hasCar
      ? `יש רכב, אבל את מעדיפה ${MODE_HE[preferred] ?? preferred}; ${fmtKmHe(km)}.`
      : `אין רכב${preferred === 'car' ? ' (מסומן "רכב", אבל אמרת שאין)' : ''} — מעדיפה ${MODE_HE[preferred] ?? preferred}; ${fmtKmHe(km)}.`,
  });

  if (preferred === 'walk') {
    if (!known || km! <= WALK_PREFERRED_KM) {
      rungs.push('walk');
      steps.push(known
        ? { thought: `She walks, and ${fmtKm(km)} is walkable → walk first.`, thoughtHe: `את הולכת ברגל, ו-${fmtKmHe(km)} זה במרחק הליכה → ברגל קודם.` }
        : { thought: 'She walks; distance unknown → try walking, the route decides if it is reasonable.', thoughtHe: 'את הולכת ברגל; המרחק לא ידוע → מנסה ברגל, המסלול יכריע.' });
    } else {
      steps.push({ thought: `She walks, but ${fmtKm(km)} is too far to walk → public transport.`, thoughtHe: `את הולכת ברגל, אבל ${fmtKmHe(km)} רחוק מדי → תחבורה ציבורית.` });
    }
  } else if (preferred === 'bike') {
    if (!known || km! <= RIDE_PREFERRED_KM) {
      rungs.push('bike');
      steps.push(known
        ? { thought: `She rides, and ${fmtKm(km)} is a reasonable ride → bike/scooter first.`, thoughtHe: `את רוכבת, ו-${fmtKmHe(km)} זו רכיבה סבירה → אופניים/קורקינט קודם.` }
        : { thought: 'She rides; distance unknown → try the bike, the route decides if it is reasonable.', thoughtHe: 'את רוכבת; המרחק לא ידוע → מנסה אופניים, המסלול יכריע.' });
    } else {
      steps.push({ thought: `She rides, but ${fmtKm(km)} is too far to ride → public transport.`, thoughtHe: `את רוכבת, אבל ${fmtKmHe(km)} רחוק מדי לרכיבה → תחבורה ציבורית.` });
    }
  } else if (known && km! <= WALK_ALWAYS_KM) {
    rungs.push('walk');
    steps.push({
      thought: `Only ${fmtKm(km)} → walking is quickest and free; no point waiting for a bus.`,
      thoughtHe: `רק ${fmtKmHe(km)} → ברגל זה הכי מהיר וחינם; אין טעם לחכות לאוטובוס.`,
    });
  }

  rungs.push('transit');
  steps.push({
    thought: 'Public transport: direct train beats bus; otherwise the fastest bus that arrives in time.',
    thoughtHe: 'תחבורה ציבורית: רכבת ישירה עדיפה על אוטובוס; אחרת האוטובוס המהיר שמגיע בזמן.',
  });

  if (!rungs.includes('bike') && (!known || km! <= RIDE_FALLBACK_KM)) {
    rungs.push('bike');
    steps.push(known
      ? { thought: `If no bus makes it: ${fmtKm(km)} is short enough for a bike or scooter.`, thoughtHe: `אם אין אוטובוס בזמן: ${fmtKmHe(km)} מספיק קצר לאופניים או קורקינט.` }
      : { thought: 'If no bus makes it: a bike or scooter, if the ride turns out short.', thoughtHe: 'אם אין אוטובוס בזמן: אופניים או קורקינט, אם הרכיבה קצרה.' });
  }

  if (hasCar) {
    rungs.push('car');
    steps.push({ thought: 'Last resort: she has a car → drive.', thoughtHe: 'מוצא אחרון: יש לך רכב → ברכב.' });
  } else {
    rungs.push('taxi');
    steps.push({
      thought: ctx.highStakes
        ? 'Last resort: a taxi or a ride — this one matters, so it is a real option.'
        : 'Last resort: a taxi or a ride — offered, not decided: for this kind of thing she may prefer to move it.',
      thoughtHe: ctx.highStakes
        ? 'מוצא אחרון: מונית או טרמפ — זה חשוב, אז זו אפשרות אמיתית.'
        : 'מוצא אחרון: מונית או טרמפ — מוצע, לא מוחלט: אולי עדיף להזיז.',
    });
  }
  return { rungs, steps };
}

function toRung(mode: TransportType): TravelRung {
  if (mode === 'train' || mode === 'bus') return 'transit';
  return mode as TravelRung;
}

/** The TransportType a rung is routed and stored as. A taxi drives. */
export function rungMode(rung: TravelRung, preferred: TransportType): TransportType {
  if (rung === 'transit') return preferred === 'bus' ? 'bus' : 'train';
  if (rung === 'taxi') return 'car';
  return rung;
}

export interface LadderChoice {
  plan: TransitPlan;
  rung: TravelRung;
  /** What she should hear when this is not simply her own vehicle. */
  noteEn?: string;
  noteHe?: string;
  /** True when this plan gets her there by the time asked. */
  inTime: boolean;
  steps: ReasonStep[];
}

/** Is this rung's plan a reasonable way to make this trip? Why not, in both languages. */
function reasonable(rung: TravelRung, plan: TransitPlan, ctx: LadderContext): { en: string; he: string } | null {
  const mins = plan.totalDurationMinutes;
  if (rung === 'walk' && mins > WALK_MAX_MINUTES) {
    return { en: `${mins} min on foot is too long`, he: `${mins} דק׳ ברגל זה יותר מדי` };
  }
  if (rung === 'bike') {
    const cap = ctx.preferred === 'bike' ? RIDE_PREFERRED_MAX_MINUTES : RIDE_FALLBACK_MAX_MINUTES;
    if (mins > cap) return { en: `${mins} min by bike is too long`, he: `${mins} דק׳ באופניים זה יותר מדי` };
  }
  return null;
}

/**
 * Walk the ladder and keep the first reasonable plan that arrives in time.
 *
 * `ask` answers one rung (the caller keeps its own caching, ranking of
 * transit alternatives and error handling). A rung that throws is "no route
 * that way", never the end of the search. When nothing arrives in time, the
 * least-late plan is still returned — a late plan still says when to leave,
 * and `inTime: false` makes sure nobody reads it as fine.
 */
export async function walkLadder(
  ctx: LadderContext,
  arriveBy: string,
  ask: (rung: TravelRung) => Promise<TransitPlan | null>,
): Promise<LadderChoice | null> {
  const { rungs, steps } = travelRungs(ctx);
  let late: { plan: TransitPlan; rung: TravelRung } | null = null;
  for (const rung of rungs) {
    let plan: TransitPlan | null = null;
    try {
      plan = await ask(rung);
    } catch (e) {
      console.warn('[travelLadder] route request failed', rung, e);
    }
    const tryIt = { thought: `Try ${rung}.`, thoughtHe: `מנסה ${RUNG_HE[rung]}.`, action: `route(${rung}, arrive by ${arriveBy})` };
    if (!plan) {
      steps.push({ ...tryIt, observation: 'no route', observationHe: 'אין מסלול' });
      continue;
    }
    const why = reasonable(rung, plan, ctx);
    if (why) {
      steps.push({
        ...tryIt,
        observation: `${plan.totalDurationMinutes} min — ${why.en}; skip`,
        observationHe: `${why.he}; מדלגת`,
      });
      continue;
    }
    const inTime = arrivesInTime(plan, arriveBy);
    steps.push({
      ...tryIt,
      observation: `${plan.totalDurationMinutes} min, leave ${plan.leaveHomeAt}, arrive ${plan.arriveAt}${inTime ? '' : ' — LATE'}`,
      observationHe: `${plan.totalDurationMinutes} דק׳, יציאה ${plan.leaveHomeAt}, הגעה ${plan.arriveAt}${inTime ? '' : ' — באיחור'}`,
    });
    if (inTime) {
      steps.push({ thought: `${rung} gets her there in time → choose it.`, thoughtHe: `${RUNG_HE[rung]} מגיע בזמן → בוחרת בזה.` });
      return { plan, rung, inTime, steps, ...noteFor(rung, ctx, plan) };
    }
    if (!late || (plan.arriveAt && late.plan.arriveAt && plan.arriveAt < late.plan.arriveAt)) late = { plan, rung };
  }
  if (!late) {
    steps.push({
      thought: 'Nothing answered at all → say so; do not pretend the road is clear.',
      thoughtHe: 'שום דרך לא ענתה → אומרת את זה; לא מעמידה פנים שהדרך פנויה.',
    });
    return null;
  }
  steps.push({
    thought: `Nothing arrives in time; the least-late is ${late.rung} (arrive ${late.plan.arriveAt}) → keep it, flagged late.`,
    thoughtHe: `שום דבר לא מגיע בזמן; הכי פחות מאחר: ${RUNG_HE[late.rung]} (הגעה ${late.plan.arriveAt}) → שומרת, מסומן כאיחור.`,
  });
  return { plan: late.plan, rung: late.rung, inTime: false, steps, ...noteFor(late.rung, ctx, late.plan) };
}

/** The one line she sees when the ladder had to step down. */
function noteFor(rung: TravelRung, ctx: LadderContext, plan: TransitPlan): { noteEn?: string; noteHe?: string } {
  if (ctx.explicit) return {};
  const mins = plan.totalDurationMinutes;
  if (rung === 'walk' && ctx.preferred !== 'walk') {
    return { noteEn: `Short hop — walk (${mins} min)`, noteHe: `קרוב — ברגל (${mins} דק׳)` };
  }
  if (rung === 'bike' && ctx.preferred !== 'bike') {
    return { noteEn: `No bus in time — bike/scooter (${mins} min)`, noteHe: `אין אוטובוס בזמן — אופניים/קורקינט (${mins} דק׳)` };
  }
  if (rung === 'transit' && (ctx.preferred === 'walk' || ctx.preferred === 'bike')) {
    return { noteEn: 'Too far to walk or ride — public transport', noteHe: 'רחוק מדי ברגל/באופניים — תחבורה ציבורית' };
  }
  if (rung === 'car' && ctx.preferred !== 'car') {
    return { noteEn: `No public transport in time — drive (${mins} min)`, noteHe: `אין תחבורה ציבורית בזמן — ברכב (${mins} דק׳)` };
  }
  if (rung === 'taxi') {
    return ctx.highStakes
      ? { noteEn: `No bus gets you there in time — taxi or a ride (${mins} min)`, noteHe: `אין תחבורה ציבורית שמגיעה בזמן — מונית או טרמפ (${mins} דק׳)` }
      : { noteEn: `No bus in time — taxi/ride (${mins} min), or move it?`, noteHe: `אין תחבורה ציבורית בזמן — מונית/טרמפ (${mins} דק׳), או להזיז?` };
  }
  return {};
}

/** Straight-line km between two points, or undefined when either is missing. */
export function straightKm(
  a?: { lat?: number; lng?: number } | null,
  b?: { lat?: number; lng?: number } | null,
): number | undefined {
  const ok = (p?: { lat?: number; lng?: number } | null) =>
    typeof p?.lat === 'number' && typeof p?.lng === 'number'
    && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
  if (!ok(a) || !ok(b)) return undefined;
  const R = 6371;
  const dLat = ((b!.lat! - a!.lat!) * Math.PI) / 180;
  const dLng = ((b!.lng! - a!.lng!) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a!.lat! * Math.PI) / 180) * Math.cos((b!.lat! * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** The note in her language. */
export function ladderNote(choice: LadderChoice | null, lang: AppLanguage): string | undefined {
  if (!choice) return undefined;
  return lang === 'he' ? choice.noteHe : choice.noteEn;
}

/** Steps as readable lines — for logs, tests and the "why?" view. */
export function formatSteps(steps: ReasonStep[]): string[] {
  return steps.map((s) => [
    `Thought: ${s.thought}`,
    s.action ? `  Action: ${s.action}` : '',
    s.observation ? `  Observation: ${s.observation}` : '',
  ].filter(Boolean).join('\n'));
}

/** One short line per step, in her language — stored on the trip and shown under "Why this way?". */
export function compactSteps(steps: ReasonStep[], lang: AppLanguage = 'en', max = 12): string[] {
  const he = lang === 'he';
  return steps.slice(0, max).map((s) => [
    he ? (s.thoughtHe ?? s.thought) : s.thought,
    s.observation ? `→ ${he ? (s.observationHe ?? s.observation) : s.observation}` : '',
  ].filter(Boolean).join(' '));
}

/**
 * Is her own bike / car left somewhere else? (13.10: "5 minutes by bike" from a
 * Haifa interview she had reached by train — the bike was in Tel Aviv.) After
 * a leg by bus, train, foot or taxi, the vehicle stayed behind; at the start of
 * the day (`prev` undefined) it is with her. Her own choice on the card wins.
 */
export function vehicleLeftBehind(prev: TransportType | undefined, explicit?: TransportType): boolean {
  return !explicit && prev !== undefined && prev !== 'bike' && prev !== 'car';
}
