/**
 * Two things at the same hour: what each one IS and what choosing it COSTS.
 *
 * The clash card named the pair and offered options, but nothing said what she
 * would be giving up — so "which one?" still needed her to remember who the
 * recruiter was. This writes, per side, a short summary (when, where, who, how
 * far) and the consequence of dropping the OTHER one. Facts from the tasks
 * only, so there is no model call, nothing to hallucinate, and both languages
 * come from the same code path.
 *
 * Pure. Node-testable (tests/run-clash-tradeoffs.ts).
 */
import type { Task } from '../types/index';

export interface SideBrief {
  /** One line: what this is. */
  summary: { en: string; he: string };
  /** What picking this side keeps. */
  gains: { en: string; he: string }[];
  /** What picking this side gives up (the other side's weight). */
  costs: { en: string; he: string }[];
}

const HELD_BY_OTHERS = ['interview', 'doctor', 'meeting', 'conference', 'class', 'course', 'call', 'zoom'];
const CAT: Record<string, { en: string; he: string }> = {
  interview: { en: 'interview', he: 'ראיון' }, doctor: { en: 'doctor', he: 'רופא' },
  meeting: { en: 'meeting', he: 'פגישה' }, conference: { en: 'conference', he: 'כנס' },
  class: { en: 'class', he: 'שיעור' }, course: { en: 'course', he: 'קורס' },
  call: { en: 'call', he: 'שיחה' }, zoom: { en: 'video call', he: 'שיחת וידאו' },
  gym: { en: 'workout', he: 'אימון' }, work: { en: 'work', he: 'עבודה' },
};

const placeOf = (t: Task): string => {
  const l: any = t.location;
  return (typeof l === 'string' ? l : l?.displayName || l?.address || '') || '';
};
const travelOf = (t: Task): number | undefined => {
  const l: any = t.location;
  const m = typeof l === 'object' ? (l?.travelMinutes ?? l?.transitPlan?.totalDurationMinutes) : undefined;
  return typeof m === 'number' && m > 0 ? m : undefined;
};
const isCalendar = (t: Task): boolean =>
  ['calendar', 'gcal'].includes(String((t as any).source ?? '')) || /^(gcal|dcal|ocal)-/.test(String(t.id));
const remote = (t: Task): boolean => Boolean((t as any).meetingUrl) && !placeOf(t);
const people = (t: Task): number => (((t as any).attendees as string[] | undefined) || []).length;

function summarise(t: Task) {
  const cat = CAT[String(t.category)] || { en: String(t.category || 'task'), he: String(t.category || 'משימה') };
  const at = t.fixedTime || t.scheduledTime || '—';
  const mins = t.durationMinutes || 30;
  const place = placeOf(t);
  const trip = travelOf(t);
  const en = [`${cat.en} at ${at}, ${mins} min`,
    remote(t) ? 'online' : place ? `at ${place}` : '',
    trip && !remote(t) ? `${trip} min to get there` : '',
    people(t) ? `${people(t)} invited` : ''].filter(Boolean).join(' · ');
  const he = [`${cat.he} ב-${at}, ${mins} דק׳`,
    remote(t) ? 'אונליין' : place ? `ב${place}` : '',
    trip && !remote(t) ? `${trip} דק׳ נסיעה` : '',
    people(t) ? `${people(t)} מוזמנים` : ''].filter(Boolean).join(' · ');
  return { en, he };
}

/** What dropping `t` costs her. */
function costOfDropping(t: Task): { en: string; he: string }[] {
  const out: { en: string; he: string }[] = [];
  const name = `"${t.text}"`;
  if (HELD_BY_OTHERS.includes(String(t.category))) {
    out.push({
      en: `${name} is held by other people — dropping it means telling them`,
      he: `${name} תלויה באנשים אחרים — לוותר עליה אומר להודיע להם`,
    });
  }
  if (people(t) > 1) {
    out.push({ en: `${people(t)} people are invited`, he: `${people(t)} מוזמנים` });
  }
  if (t.priority === 'must') {
    out.push({ en: `${name} is marked must-do`, he: `${name} מסומנת כחובה` });
  }
  if ((t as any).deadline) {
    out.push({ en: `${name} has a deadline (${(t as any).deadline})`, he: `${name} עם דדליין (${(t as any).deadline})` });
  }
  if (!isCalendar(t) && !out.length) {
    out.push({ en: `${name} is yours — it can move to another day`, he: `${name} שלך — אפשר להעביר ליום אחר` });
  }
  if (remote(t)) {
    out.push({ en: `${name} is online — you could join from anywhere`, he: `${name} אונליין — אפשר להצטרף מכל מקום` });
  }
  return out;
}

/** Brief for picking `keep` and letting go of `drop`. */
export function briefFor(keep: Task, drop: Task): SideBrief {
  const gains: SideBrief['gains'] = [{ en: `You keep ${'"' + keep.text + '"'}`, he: `נשארת עם "${keep.text}"` }];
  const trip = travelOf(keep);
  if (trip && !remote(keep)) gains.push({ en: `${trip} min trip you'll actually take`, he: `נסיעה של ${trip} דק׳` });
  const costs = costOfDropping(drop);
  if (!costs.length) costs.push({ en: `"${drop.text}" goes unattended`, he: `"${drop.text}" לא תתקיים` });
  return { summary: summarise(keep), gains, costs };
}
