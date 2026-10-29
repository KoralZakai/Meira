/**
 * gymCheck — her gym's address, checked against the map, not against what
 * the microphone heard.
 *
 * 13.10, Koral: "I am not sure! Check where Space Gym is, or Meira should
 * search and check where the gym is!" Her routines said Yigal Alon 94 in some
 * lines and 96 in others; Space's own site lists ONE Yigal Alon branch, at 76.
 * "שבעים ושש" heard as "תשעים ושש" — and a majority vote over mis-hearings
 * only picks the most common mistake.
 *
 * Pure: lines + Places hits in, the settled lines out. GapFillService runs the
 * search (RoutePlanner.placeTextSearch) and writes both stores; the test is
 * tests/run-gym-check.ts.
 */
import { addressInRoutine, routineConcept } from './routines';
import { correctPlaceName } from './fuzzyMatch';

export interface PlaceHitLike { name: string; address: string; lat?: number; lng?: number }

const BRANDS: Array<[RegExp, string]> = [
  [/space|ספייס/i, 'Space'],
  [/holmes|הולמס/i, 'Holmes Place'],
  [/gold'?s|גולדס/i, "Gold's Gym"],
  [/great shape|גרייט שייפ/i, 'Great Shape'],
];
const GYM_NAME = /gym|fitness|כושר|ספייס|space|holmes|הולמס|studio|סטודיו|crossfit|קרוספיט/i;

/** "יגאל אלון 94, תל אביב" → "יגאל אלון 94". */
const streetPart = (a: string) => a.split(',')[0].trim();
/** "יגאל אלון 94" → "יגאל אלון". */
const streetName = (a: string) => streetPart(a).replace(/\s*\d+[א-ת]?$/, '').trim();
const numberOf = (a: string) => /(\d+[א-ת]?)\s*$/.exec(streetPart(a))?.[1];
const cityPart = (a: string) => a.split(',').slice(1).map((x) => x.trim()).find((x) => x && !/ישראל|israel/i.test(x));

export interface GymFacts { address: string; brand?: string; street: string; number?: string; city?: string }

/** The gym her workout lines name, and the brand when one is said. */
export function gymOf(lines: string[]): GymFacts | null {
  for (const raw of lines) {
    const line = correctPlaceName(raw);
    if (routineConcept(line) !== 'fitness') continue;
    const address = addressInRoutine(line);
    if (!address || !numberOf(address)) continue;
    const brand = BRANDS.find(([re]) => re.test(line))?.[1];
    return { address, brand, street: streetName(address), number: numberOf(address), city: cityPart(address) };
  }
  return null;
}

/** What to ask the map: the name and the STREET, never the number we doubt. */
export function gymQuery(g: GymFacts, homeCity?: string): string {
  return [g.brand ?? 'חדר כושר', g.street, g.city ?? homeCity ?? ''].filter(Boolean).join(' ');
}

export interface GymVerdict {
  lines: string[];
  /** The address the map gave, when it settled the question. */
  found?: string;
  /** True when a line changed. */
  changed: boolean;
  /** Why nothing changed — said, not swallowed (rule 1). */
  reason?: 'matches' | 'not-found' | 'ambiguous';
}

/**
 * Settle the number from the map. Only a hit on the SAME street counts, and
 * with a brand said, only that brand; two different gyms on her street is a
 * question for her, not a guess.
 */
export function settleGym(lines: string[], g: GymFacts, hits: PlaceHitLike[]): GymVerdict {
  const onStreet = hits.filter((h) => h && h.address && h.address.includes(g.street));
  const ours = onStreet.filter((h) => (g.brand
    ? BRANDS.find(([, name]) => name === g.brand)![0].test(`${h.name} ${h.address}`)
    : GYM_NAME.test(h.name)));
  const numbers = [...new Set(ours.map((h) => numberOf(h.address)).filter(Boolean))] as string[];
  if (!numbers.length) return { lines, changed: false, reason: 'not-found' };
  if (numbers.length > 1) return { lines, changed: false, reason: 'ambiguous' };
  const real = numbers[0];
  const found = `${g.street} ${real}`;
  if (real === g.number) return { lines, changed: false, found, reason: 'matches' };
  // Every telling of that street with another number is the same gym, heard wrong.
  const wrong = streetWithAnyNumber(g.street, 'g');
  const out = lines.map((l) => {
    const line = correctPlaceName(l);
    return routineConcept(line) === 'fitness' ? line.replace(wrong, found) : l;
  });
  return { lines: out, changed: out.some((l, i) => l !== lines[i]), found };
}

/** "יגאל אלון" followed by any house number — the street as she said it, any number. */
export function streetWithAnyNumber(street: string, flags = ''): RegExp {
  return new RegExp(`${street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+[א-ת]?`, flags);
}
