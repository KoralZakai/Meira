/**
 * pairAdvice — two events at one hour: which one should she pick, and why.
 *
 * The clash resolver says THAT two things collide and the Today row said
 * "Two places at once". She then had to weigh it herself: who is holding the
 * slot, how far each is, and — the thing a person actually weighs — where each
 * choice leaves her for the NEXT event ("pick the lecture, then the gym is
 * five minutes away"). That judgement is arithmetic over facts the app already
 * holds, so it lives in code: no model call, no cost, nothing invented, both
 * languages from one path (the chat is the only place a model is needed).
 *
 * Pure: no storage, no network, no clock. Pinned by tests/run-pair-advice.ts.
 */
import type { Task } from '../types/index';
import { timeToMinutes } from './timeUtils';

export interface Reason { en: string; he: string; weight: number }

export interface SideAdvice {
  task: Task;
  score: number;
  /** Why pick this one — best first. */
  pros: Reason[];
  /** What picking it costs — the other side's weight, plus its own travel. */
  cons: Reason[];
}

export interface PairAdvice {
  pick: 'a' | 'b';
  /** Scores within one point: say it is close, and what tips it. */
  closeCall: boolean;
  a: SideAdvice;
  b: SideAdvice;
  /** The event after the pair that the verdict took into account, if any. */
  next?: { title: string; kmFromA?: number; kmFromB?: number };
}

interface Pt { lat: number; lng: number }

const OTHERS_HOLD = ['interview', 'doctor', 'meeting', 'conference', 'class', 'course', 'call', 'zoom'];
const RANK: Record<string, number> = { interview: 3, doctor: 2, meeting: 1, conference: 1, class: 1, course: 1 };
/** Straight-line km under which two places are "next to" each other. */
export const NEAR_KM = 1.5;
/** A difference in distance that is worth mentioning. */
const FAR_DIFF_KM = 3;

export function haversineKm(p: Pt, q: Pt): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(q.lat - p.lat); const dLng = r(q.lng - p.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(p.lat)) * Math.cos(r(q.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

const ptOf = (t: Task): Pt | undefined => {
  const l: any = t.location;
  return l && typeof l === 'object' && Number.isFinite(l.lat) && Number.isFinite(l.lng) && !(l.lat === 0 && l.lng === 0)
    ? { lat: l.lat, lng: l.lng } : undefined; // 0,0 is "unknown", not a place in the Atlantic
};
const startOf = (t: Task): number => timeToMinutes(t.fixedTime || t.scheduledTime || '00:00');
const endOf = (t: Task): number => startOf(t) + (t.durationMinutes || 30);
const online = (t: Task): boolean => Boolean((t as any).meetingUrl) && !ptOf(t);
const invited = (t: Task): number => (((t as any).attendees as string[] | undefined) || []).length;
const km1 = (n: number): string => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const title = (t: Task): string => String(t.text || '').split('\n')[0].trim();

function sideAdvice(t: Task, other: Task, ctx: { from?: Pt; next?: Task; nextKm?: number; otherNextKm?: number }): SideAdvice {
  const pros: Reason[] = []; const cons: Reason[] = [];
  const cat = String(t.category);
  const heldBy = OTHERS_HOLD.includes(cat);
  if (RANK[cat] === 3 || t.priority === 'must') {
    pros.push({ en: cat === 'interview' ? 'it is an interview — hard to get back' : 'you marked it must-do', he: cat === 'interview' ? 'זה ראיון — קשה להחזיר' : 'סימנת אותו כחובה', weight: 3 });
  }
  if (heldBy && invited(t) > 1) {
    pros.push({ en: `${invited(t)} people are counting on you`, he: `${invited(t)} אנשים מחכים לך`, weight: 1.5 });
  } else if (heldBy) {
    pros.push({ en: 'someone else holds this time', he: 'מישהו אחר מחזיק בשעה הזו', weight: 1 });
  }
  if ((t as any).deadline) pros.push({ en: `it has a deadline (${(t as any).deadline})`, he: `יש לזה דדליין (${(t as any).deadline})`, weight: 1 });
  if (RANK[cat] === 2) pros.push({ en: 'appointments like this are hard to rebook', he: 'קשה לקבוע תור כזה מחדש', weight: 1.5 });
  if (online(t)) pros.push({ en: 'it is online — no travel at all', he: 'זה אונליין — בלי נסיעה', weight: 1 });

  // Where she is coming FROM.
  const here = ptOf(t);
  const otherHere = ptOf(other);
  if (ctx.from && here && otherHere) {
    const mine = haversineKm(ctx.from, here); const theirs = haversineKm(ctx.from, otherHere);
    if (theirs - mine >= FAR_DIFF_KM) pros.push({ en: `it is ${km1(mine)} km from where you will be, the other ${km1(theirs)} km`, he: `זה ${km1(mine)} ק״מ ממקום הימצאך, השני ${km1(theirs)} ק״מ`, weight: 1 });
    if (mine - theirs >= FAR_DIFF_KM) cons.push({ en: `it is ${km1(mine)} km away`, he: `זה ${km1(mine)} ק״מ`, weight: 1 });
  }

  // Where it leaves her for the NEXT event — the part she weighs by hand.
  if (ctx.next && ctx.nextKm !== undefined) {
    const nt = title(ctx.next);
    if (ctx.nextKm <= NEAR_KM) {
      pros.push({ en: `afterwards ${nt} is right nearby (${km1(ctx.nextKm)} km)`, he: `אחרי זה "${nt}" ממש קרוב (${km1(ctx.nextKm)} ק״מ)`, weight: 1.5 });
    } else if (ctx.otherNextKm !== undefined && ctx.nextKm - ctx.otherNextKm >= FAR_DIFF_KM) {
      cons.push({ en: `it leaves you ${km1(ctx.nextKm)} km from ${nt}`, he: `זה משאיר אותך ${km1(ctx.nextKm)} ק״מ מ"${nt}"`, weight: 1.5 });
    }
  }

  // What it costs: the other side's weight, said plainly.
  const od = title(other);
  if (OTHERS_HOLD.includes(String(other.category))) cons.push({ en: `you let go of "${od}", which other people hold`, he: `מוותרים על "${od}", שאחרים תלויים בו`, weight: 1 });
  else cons.push({ en: `"${od}" moves — it is yours to move`, he: `"${od}" זז — הוא שלך להזיז`, weight: 0.5 });

  pros.sort((x, y) => y.weight - x.weight); cons.sort((x, y) => y.weight - x.weight);
  const score = pros.reduce((s, r) => s + r.weight, 0) - cons.filter((c) => c.weight >= 1.5).reduce((s, r) => s + r.weight, 0) * 0.5;
  return { task: t, score, pros, cons };
}

/**
 * `dayTasks` is the whole day (to find what comes before and after);
 * `home` is where the day starts when nothing earlier has a place.
 */
export function adviseOverlap(a: Task, b: Task, dayTasks: Task[], home?: Pt): PairAdvice {
  const others = dayTasks
    .filter((t) => t.id !== a.id && t.id !== b.id && t.status !== 'complete' && (t.fixedTime || t.scheduledTime))
    .sort((x, y) => startOf(x) - startOf(y));
  const begin = Math.min(startOf(a), startOf(b));
  const prev = [...others].reverse().find((t) => endOf(t) <= begin && ptOf(t));
  const from = prev ? ptOf(prev) : (home && home.lat && home.lng ? home : undefined);

  const nextFor = (t: Task): { task?: Task; km?: number } => {
    const n = others.find((o) => startOf(o) >= endOf(t) && ptOf(o));
    const p = ptOf(t);
    return n && p ? { task: n, km: haversineKm(p, ptOf(n)!) } : { task: n };
  };
  const na = nextFor(a); const nb = nextFor(b);
  const next = na.task ?? nb.task;
  const sa = sideAdvice(a, b, { from, next, nextKm: na.km, otherNextKm: nb.km });
  const sb = sideAdvice(b, a, { from, next, nextKm: nb.km, otherNextKm: na.km });
  const diff = sa.score - sb.score;
  const closeCall = Math.abs(diff) < 1;
  // A tie is broken by what comes next, then by the one that starts first.
  const pick: 'a' | 'b' = diff !== 0 ? (diff > 0 ? 'a' : 'b')
    : (na.km ?? 99) !== (nb.km ?? 99) ? ((na.km ?? 99) < (nb.km ?? 99) ? 'a' : 'b')
      : (startOf(a) <= startOf(b) ? 'a' : 'b');
  return {
    pick, closeCall, a: sa, b: sb,
    next: next ? { title: title(next), kmFromA: na.km, kmFromB: nb.km } : undefined,
  };
}
