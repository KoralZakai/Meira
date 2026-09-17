/**
 * knownPlaces — "this is my gym address", said once.
 *
 * Koral, 2026-09-17: "i added to tomorrow a task 'יוגה ב 11 בבוקר ביגאל אלון
 * 94' — i didn't write tel aviv but Meira needs to know that, THIS IS MY GYM
 * ADDRESS."
 *
 * Two different asks live in that sentence. Completing the city is
 * utils/addressCompletion. This file is the other one: next time she writes
 * "יוגה ב-11" and no address at all, the app should already know where that is.
 *
 * THE SERVER HAS DONE THIS SINCE 2026-09-08. server/known_places.py opens by
 * quoting her own brief — "enough for me to write once 'yoga class' in יגאל
 * אלון 94, next time 'yoga class on 11:00' automatically location known and
 * bike" — and it works: concept_of("יוגה ביגאל אלון 94") returns "fitness",
 * and bare "יוגה" returns the same key.
 *
 * But it only ever ran on the WhatsApp path. A task typed into the app goes
 * through hooks/useTasks.addManualTask, which is entirely local, and the one
 * field that could have carried this — `Task.activityKey` — is written there
 * and READ NOWHERE. Write-only, since the day it was added.
 *
 * So this is a port, not a new idea, and deliberately a faithful one: the same
 * concept table, the same stop words, the same key rule, the same overlap
 * threshold. Two implementations of one rule are only safe while they agree,
 * which is why tests/run-known-places.ts checks this against the Python's own
 * answers rather than against my memory of them.
 *
 * WHY A CONCEPT TABLE AND NOT SIMILARITY. gym / yoga / workout / training are
 * ONE key on purpose — her brief says so directly, and in her data they are
 * all יגאל אלון 94. The table is small and hand-written because a wrong merge
 * here does not produce a bad suggestion, it sends her to the wrong address.
 *
 * Pure. Storage is services/KnownPlacesStore.
 */

/**
 * One key per real-world activity, in both languages.
 *
 * "class" is a CONTAINER, not an activity, and is only consulted when nothing
 * specific matched — otherwise "שיעור יוגה" resolves as "שיעור" (the longer
 * match) and a yoga session lands wherever the last unrelated course was.
 */
const CONCEPTS: Record<string, string[]> = {
  fitness: ['gym', 'workout', 'training', 'fitness', 'yoga', 'pilates',
    'חדר כושר', 'כושר', 'אימון', 'אימונים', 'התעמלות', 'יוגה', 'פילאטיס'],
  pool: ['pool', 'swim', 'swimming', 'בריכה', 'שחייה'],
  work: ['work', 'office', 'עבודה', 'משרד'],
  doctor: ['doctor', 'clinic', 'dentist', 'רופא', 'מרפאה', 'שיניים', 'רופאה'],
  therapy: ['therapy', 'therapist', 'psychologist', 'טיפול', 'פסיכולוג', 'מטפלת'],
  class: ['class', 'course', 'lecture', 'שיעור', 'קורס', 'הרצאה', 'חוג'],
};

/** Concepts that describe the container, not the activity. */
const GENERIC = new Set(['class']);

/** Words carrying no identity — dropped so "שיעור יוגה בערב" and "יוגה" line up. */
const STOP = new Set([
  'the', 'a', 'an', 'at', 'in', 'on', 'to', 'with', 'my', 'for', 'and',
  'evening', 'morning', 'afternoon', 'night', 'today', 'tomorrow', 'class',
  'של', 'עם', 'את', 'אל', 'לי', 'לה', 'לו', 'ב', 'ל', 'מ', 'ה', 'ו',
  'בערב', 'בבוקר', 'בצהריים', 'בלילה', 'היום', 'מחר', 'אחהצ',
]);

const TIME_RE = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}[./]\d{1,2}\b/g;

export interface KnownPlace {
  address: string;
  lat?: number;
  lng?: number;
  /** Confidence in the ACTIVITY, not in the string — a new address still counts. */
  count: number;
  /** Her actual wording, so an unknown concept can still match by overlap. */
  words: string[];
}

export type KnownPlaces = Record<string, KnownPlace>;

/**
 * Meaningful words, lowercased, with times and stop words removed.
 *
 * `\p{L}`, not `[^\W\d_]`. The Python this is ported from uses the latter
 * under `re.UNICODE`, where `\w` covers every letter in every script — so it
 * reads "a letter, not a digit". In JavaScript `\w` is ASCII-only even with
 * the `u` flag, so the same characters mean "an ASCII letter", and the whole
 * function returned an EMPTY SET for every Hebrew phrase. Silently: no
 * exception, no empty-input check, just a fallback matcher that could never
 * match anything she actually types.
 *
 * Caught by tests/run-known-places.ts on its first run — 16 of 26 phrases
 * disagreed with the Python — which is the entire reason that parity fixture
 * is generated from known_places.py rather than written by hand.
 */
export function tokensOf(text: string): Set<string> {
  const t = String(text || '').toLowerCase().replace(TIME_RE, ' ');
  const words = t.match(/\p{L}+/gu) || [];
  return new Set(words.filter((w) => w.length > 1 && !STOP.has(w)));
}

/**
 * The activity this text names, if it is one we know in both languages.
 *
 * Longest term first, so "חדר כושר" beats the bare "כושר" and a two-word
 * English term is not beaten by one of its halves.
 */
export function conceptOf(text: string): string | null {
  const t = String(text || '').toLowerCase();
  const match = (names: string[]): string | null => {
    let best: string | null = null;
    let bestLen = 0;
    for (const concept of names) {
      for (const term of CONCEPTS[concept]) {
        if (t.includes(term) && term.length > bestLen) {
          best = concept;
          bestLen = term.length;
        }
      }
    }
    return best;
  };
  const specific = Object.keys(CONCEPTS).filter((c) => !GENERIC.has(c));
  return match(specific) || match([...GENERIC]);
}

/**
 * The stable key for an activity: its concept when known, else its meaningful
 * words sorted — so word order never forks one place into two.
 *
 * A GENERIC concept is qualified by what makes it specific. "class" says only
 * that something is a lesson, so "חוג קרמיקה של נועה" and "שיעור גיטרה" both
 * collapsed to @class, and the ceramics studio on Shenkin then answered for a
 * guitar lesson. known_places.py's own comment warns that "a wrong merge here
 * sends her to the wrong address"; that was one, and it lived in the fallback
 * where nothing specific matched — which is most hobbies.
 *
 * A real activity key is still shared on purpose: gym / yoga / workout are one
 * place and are meant to be.
 *
 * Fixed in BOTH implementations on 2026-09-17, so the parity fixture still
 * holds. Entries already stored under a bare @class stop resolving — they
 * degrade to asking once more, which is the right direction to fail in.
 */
export function activityKeyOf(text: string): string {
  const concept = conceptOf(text);
  if (concept) {
    if (!GENERIC.has(concept)) return `@${concept}`;
    const own = new Set<string>();
    CONCEPTS[concept].forEach((term) => tokensOf(term).forEach((w) => own.add(w)));
    const rest = [...tokensOf(text)].filter((w) => !own.has(w)).sort();
    return rest.length ? `@${concept}:${rest.join(' ')}`.slice(0, 60) : `@${concept}`;
  }
  return [...tokensOf(text)].sort().join(' ').slice(0, 60);
}

/** Record that this activity happens at this address. */
export function rememberPlace(
  places: KnownPlaces | null | undefined,
  activity: string,
  address: string,
  coords?: { lat?: number; lng?: number },
): KnownPlaces {
  const next: KnownPlaces = { ...(places || {}) };
  const key = activityKeyOf(activity);
  if (!key || !address) return next;
  const entry = next[key] || { address, count: 0, words: [] };
  // A later address WINS — she moved gyms, or gave a better one. The count
  // still rises, because it is confidence in the activity, not in the string.
  const words = new Set([...(entry.words || []), ...tokensOf(activity)]);
  next[key] = {
    address,
    lat: coords?.lat ?? entry.lat,
    lng: coords?.lng ?? entry.lng,
    count: (entry.count || 0) + 1,
    words: [...words].sort().slice(0, 24),
  };
  return next;
}

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((w) => { if (b.has(w)) shared += 1; });
  return shared / Math.min(a.size, b.size);
};

export interface ResolvedPlace {
  address: string;
  lat?: number;
  lng?: number;
  key: string;
  /** 'concept' crosses languages; 'overlap' is a same-language near-match. */
  via: 'concept' | 'overlap';
}

/**
 * The address this activity happens at, or null to ask.
 *
 * Concept match first — it is the one that crosses languages, so "yoga class"
 * finds what "אימון בחדר כושר" saved. Word overlap is the fallback for
 * same-language variants the table has no concept for.
 */
export function resolvePlace(
  places: KnownPlaces | null | undefined, activity: string, threshold = 0.6,
): ResolvedPlace | null {
  if (!places || !Object.keys(places).length) return null;
  const key = activityKeyOf(activity);
  const hit = places[key];
  if (hit?.address) {
    return { address: hit.address, lat: hit.lat, lng: hit.lng, key, via: 'concept' };
  }
  const wanted = tokensOf(activity);
  let best: { entry: KnownPlace; key: string; score: number } | null = null;
  for (const [k, entry] of Object.entries(places)) {
    if (!entry?.address) continue;
    const score = overlap(wanted, new Set(entry.words || []));
    if (score >= threshold && (!best || score > best.score)) best = { entry, key: k, score };
  }
  return best
    ? { address: best.entry.address, lat: best.entry.lat, lng: best.entry.lng, key: best.key, via: 'overlap' }
    : null;
}
