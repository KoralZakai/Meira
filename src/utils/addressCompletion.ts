/**
 * addressCompletion — "יגאל אלון 94" is an address. It is just not a complete one.
 *
 * Koral, 2026-09-17, adding a class for tomorrow:
 *
 *   "i added to tomorrow a task 'יוגה ב 11 בבוקר ביגאל אלון 94' — i didn't
 *    write tel aviv but Meira needs to know that, this is my gym address."
 *
 * She is right, and the parser was never the problem: extractHebrewPlaceParts
 * returns exactly "יגאל אלון 94". What happens next is the problem.
 *
 * geocodeTaskLocation calls expo-location's `geocodeAsync`, which is the
 * PLATFORM geocoder — no region, no bias, no idea where she lives. (Its own
 * doc comment claimed it used Google Geocoding. It never did.) Every other
 * Google call in this app carries `region=il`; this one, the one that decides
 * WHERE a task is, carried nothing.
 *
 * A street name with no city is not ambiguous to a person who lives in one
 * city. It is ambiguous to a geocoder that has never been told. Israel has a
 * Yigal Alon street in several towns, and the failure mode is not an error —
 * it is a confident route to the wrong one, with a leave time and an alarm
 * built on top of it.
 *
 * TWO RULES, both conservative, because appending a wrong city is worse than
 * appending none:
 *
 *   1. Only complete an address that is plainly INCOMPLETE — one segment, a
 *      short street-and-number, no city named anywhere in it.
 *   2. Only complete it from a home address that actually names a city. No
 *      home city, no completion; guessing "Tel Aviv" because most people live
 *      there is how a task lands 60 km from where she meant.
 *
 * Pure. tests/run-address-completion.ts covers every branch.
 */

/**
 * Cities common enough to appear without a comma in something she typed.
 *
 * Not a gazetteer and not trying to be. Its only job is to notice that a city
 * IS already named — "יגאל אלון 94 תל אביב" — so nothing is appended. A city
 * missing from this list means at worst that a complete address is completed
 * again with the same city, which geocoders tolerate.
 */
const CITY_WORDS = [
  'תל אביב', 'תל-אביב', 'ת"א', 'תא', 'יפו',
  'ירושלים', 'חיפה', 'באר שבע', 'ראשון לציון', 'פתח תקווה', 'פתח תקוה',
  'נתניה', 'אשדוד', 'אשקלון', 'רחובות', 'הרצליה', 'רמת גן', 'רמת-גן',
  'גבעתיים', 'בני ברק', 'חולון', 'בת ים', 'כפר סבא', 'רעננה', 'מודיעין',
  'לוד', 'רמלה', 'עפולה', 'טבריה', 'נצרת', 'אילת', 'בנימינה', 'חדרה',
  'קריית אונו', 'קרית אונו', 'ראש העין', 'יהוד', 'אור יהודה', 'גבעת שמואל',
  'tel aviv', 'tel-aviv', 'jerusalem', 'haifa', 'beer sheva', 'netanya',
  'herzliya', 'ramat gan', 'givatayim', 'rishon', 'petah tikva', 'ashdod',
  'israel', 'ישראל',
];

/** Does this text already say which town it is in? */
export function namesACity(address?: string | null): boolean {
  const s = String(address || '').toLowerCase();
  if (!s.trim()) return false;
  return CITY_WORDS.some((c) => s.includes(c.toLowerCase()));
}

/**
 * The city out of a full address, or null.
 *
 * Google formats as "street number, city, district, country", and a person
 * types "הרצל 20, תל אביב". The second segment is the part both shapes agree
 * on. A home address with no comma has no city to lend, and says so.
 */
export function cityOf(address?: string | null): string | null {
  const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    // No comma — but she may still have typed the city inline.
    const s = String(address || '').toLowerCase();
    const hit = CITY_WORDS.find((c) => s.includes(c.toLowerCase()));
    return hit ? hit : null;
  }
  // Skip a segment that is only a house number (Google sometimes leads with
  // one: "11א, Kaufmann Street, Tel Aviv") — the city is the one after.
  for (const part of parts.slice(1)) {
    if (/^\d+[a-zא-ת]?$/.test(part)) continue;
    if (namesACity(part)) return part;
    // The second real segment IS the city in both formats, even when it is a
    // town this file has never heard of.
    return part;
  }
  return null;
}

/**
 * True when this address needs a city added before anyone geocodes it.
 *
 * Deliberately narrow. A long address, a multi-part one, or one that already
 * names a town is left exactly as she wrote it.
 */
export function needsCity(address?: string | null): boolean {
  const s = String(address || '').trim();
  if (!s) return false;
  if (s.includes(',')) return false;        // already has segments
  if (namesACity(s)) return false;          // already says the town
  // A street and a number, or a short venue name. Longer than that and it is
  // prose, or an address complete enough to leave alone.
  return s.split(/\s+/).filter(Boolean).length <= 4;
}

/**
 * Her address, completed from where she lives — or unchanged.
 *
 * Returning the input untouched is the common, correct case. This only fires
 * for the specific shape that actually breaks: a bare street she typed,
 * geocoded by a device geocoder that has no idea which country she is in.
 */
export function completeAddress(address?: string | null, homeAddress?: string | null): string {
  const s = String(address || '').trim();
  if (!needsCity(s)) return s;
  const city = cityOf(homeAddress);
  if (!city) return s;
  return `${s}, ${city}`;
}
