/**
 * routineConsolidate — her routines, one line each, no duplicates.
 *
 * 13.10, Koral: "about the massive duplicated routines — optimize all the
 * content you have so it does not repeat, update what you already have,
 * export it clearly, no reduplications." Her two stores (the box on the phone
 * and what she told Meira) held TWELVE lines of one workout — said by voice,
 * typed, told in the chat, some glued into one comma line, three spellings of
 * Yigal Alon, 94 and 96.
 *
 * Saving no longer adds duplicates (sameRoutine replaces). This cleans what
 * is already there: lines that are one routine (utils/routines sameRoutine)
 * become the FULLEST of them — an address beats none, an hour, days, Meira's
 * "what · days · time · place" shape — and on a tie the newer one. A workout
 * with no address takes her gym's (the best-placed workout line), because
 * "you already know where the gym is". Spellings are corrected
 * (correctPlaceName). A line that is not a routine (no day, no hour — "I hate
 * mornings") is kept as it is, once.
 *
 * Pure. Consumed by services/GapFillService.loadRoutines, which writes the
 * result back to BOTH stores. Tested by tests/run-routine-consolidate.ts on
 * her real lines.
 */
import { correctPlaceName } from './fuzzyMatch';
import { Routine, addressInRoutine, parseRoutineNotes, routineConcept, sameRoutine } from './routines';

interface Candidate { routine: Routine; line: string; order: number }

const MIXED = /בערב[\s\S]*בבוקר|בבוקר[\s\S]*בערב|\d{1,2}:\d{2}\s*(?:או|or)\s*\d{1,2}:\d{2}|ובנוסף|\band also\b/i;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** How complete a telling is. A glued run-on line loses: it is several tellings at once. */
function fullness(c: Candidate): number {
  const r = c.routine;
  let score = 0;
  if (addressInRoutine(r.text)) score += 2;
  if (r.time) score += 1;
  if (r.weekdays.length && r.daysFrom === 'said') score += 1;
  if (r.text.includes(' · ')) score += 1;
  if (r.text.length > 90) score -= 3;
  // Two routines in one sentence ("Sun–Tue at 8 in the evening AND Friday at 11")
  // is no single routine's line, however full.
  if (MIXED.test(r.text)) score -= 3;
  return score;
}

export interface Consolidated {
  /** The lines to keep, in the order she first said each thing. */
  lines: string[];
  /** How many lines were folded into another. */
  merged: number;
}

export function consolidateRoutineLines(text: string): Consolidated {
  const rawLines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const groups: Candidate[][] = [];
  const context: Array<{ line: string; order: number }> = [];
  const seenContext = new Set<string>();
  let order = 0;
  let total = 0;
  for (const line of rawLines) {
    const routines = parseRoutineNotes(line);
    if (!routines.length) {
      total += 1;
      const key = norm(correctPlaceName(line));
      if (!seenContext.has(key)) { seenContext.add(key); context.push({ line: correctPlaceName(line), order: order++ }); }
      continue;
    }
    for (const routine of routines) {
      total += 1;
      const c: Candidate = { routine, line: routine.text, order: order++ };
      const g = groups.find((grp) => grp.some((x) => sameRoutine(x.routine, routine)));
      if (g) g.push(c); else groups.push([c]);
    }
  }
  // Her gym: the address her workouts name MOST often (94 typed and told five
  // times beats a 96 heard once), the fullest spelling of it.
  const workoutsAt = groups.flat().filter((c) => routineConcept(c.routine.text) === 'fitness')
    .map((c) => addressInRoutine(correctPlaceName(c.routine.text))).filter((a): a is string => Boolean(a));
  const street = (a: string) => a.split(',')[0].trim();
  const streetName = (a: string) => street(a).replace(/\s*\d+[א-ת]?$/, '');
  const votes = new Map<string, number>();
  for (const a of workoutsAt) votes.set(street(a), (votes.get(street(a)) ?? 0) + 1);
  const top = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  const gym = top ? workoutsAt.filter((a) => street(a) === top).sort((x, y) => y.length - x.length)[0] : null;

  // A workout line naming her gym's street with another number (a 96 heard
  // once) is at her gym too — the fullest telling AT the gym wins.
  const atGym = (c: Candidate) => Boolean(gym) && street(addressInRoutine(correctPlaceName(c.line)) ?? '') === street(gym!);
  const score = (c: Candidate) => fullness(c) + (atGym(c) ? 1 : 0);
  // The days she said most often for this routine (Sun–Mon–Tue five times beats
  // a Sun–Tue heard once) — a newer line must not quietly drop a day.
  const best = (grp: Candidate[]) => {
    const sig = (c: Candidate) => [...c.routine.weekdays].sort().join(',');
    const votes = new Map<string, number>();
    for (const c of grp) if (c.routine.weekdays.length) votes.set(sig(c), (votes.get(sig(c)) ?? 0) + 1);
    const usual = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const total = (c: Candidate) => score(c) + (usual !== undefined && sig(c) === usual ? 1 : 0);
    return grp.reduce((a, b) => (total(b) >= total(a) ? b : a));
  };

  const kept: Array<{ line: string; order: number }> = [...context];
  for (const grp of groups) {
    const b = best(grp);
    let line = correctPlaceName(b.line);
    if (gym && routineConcept(line) === 'fitness') {
      const said = addressInRoutine(line);
      if (!said) line = `${line} · ${gym}`;
      else if (said.split(',')[0].trim() !== street(gym) && streetName(said) === streetName(gym)) line = line.replace(said, gym);
    }
    kept.push({ line, order: Math.min(...grp.map((c) => c.order)) });
  }
  const lines = kept.sort((a, b) => a.order - b.order).map((k) => k.line);
  return { lines, merged: total - lines.length };
}

/**
 * Two stores, one list — and a line one side DROPPED must stay dropped (21.10, Koral: "the routines
 * are not updated").
 *
 * The phone's box and what Meira holds were joined by UNION. So when she told Meira "yoga on
 * Tuesday at 8, instead of the workout", Meira rewrote the old workout line to lose Tuesday — and the
 * phone, still holding the old line in its box, put it straight back, and wrote the union over
 * Meira's list. Nothing could ever be removed from one side.
 *
 * With `snapshot` — the list both sides held the last time they agreed — a line that was in the
 * snapshot and is gone from one side was removed there on purpose, and is dropped from the other
 * side too. Lines that are new on a side (not in the snapshot) are kept. No snapshot (first run):
 * plain union, as before.
 */
export function threeWayRoutineLines(
  box: string[], told: string[], snapshot: string[] | null,
): string[] {
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  const b = clean(box); const t = clean(told);
  if (!snapshot) return [...b, ...t];
  const snap = new Set(clean(snapshot));
  const bSet = new Set(b); const tSet = new Set(t);
  return [
    ...b.filter((l) => !(snap.has(l) && !tSet.has(l))),   // she / Meira dropped it on Meira's side
    ...t.filter((l) => !(snap.has(l) && !bSet.has(l))),   // …or on the phone
  ];
}
