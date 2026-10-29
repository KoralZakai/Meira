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
  // A town this file knows, anywhere after the street, wins outright.
  const country = (part: string) => /^(israel|ישראל)$/i.test(part);
  const known = parts.slice(1).find((part) => namesACity(part) && !country(part));
  if (known) return known;
  // Google sometimes LEADS with the house number — "21, Mordei ha-Geta'ot
  // Street, Tel Aviv-Yafo" — and then the second segment is the STREET. Read
  // as the city, it was appended to an interview in Haifa as "- פארק מדעי
  // החיים, Mordei ha-Geta'ot Street" (13.10). The city is the segment after
  // the street, wherever the number stands.
  const isNumber = (part: string) => /^\d+[a-zא-ת]?$/i.test(part);
  const rest = isNumber(parts[0]) ? parts.slice(2) : parts.slice(1);
  const city = rest.find((part) => !isNumber(part) && !country(part));
  // The real segment after the street IS the city in both formats, even when
  // it is a town this file has never heard of.
  return city ?? null;
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
  // A STREET AND A NUMBER — "יגאל אלון 94" is in a dozen towns. A venue name is
  // not completed (13.10): "רפאל מכון דוד" is in Haifa, and ", תל אביב" sent
  // the geocoder looking for it in the wrong city. A name is unique enough for
  // Google, which already searches near her (the geocode carries her bounds).
  return /\d/.test(s) && s.split(/\s+/).filter(Boolean).length <= 4;
}

/**
 * Her address, completed from where she lives — or unchanged.
 *
 * Returning the input untouched is the common, correct case. This only fires
 * for the specific shape that actually breaks: a bare street she typed,
 * geocoded by a device geocoder that has no idea which country she is in.
 */
export function completeAddress(address?: string | null, homeAddress?: string | null): string {
  // " - פארק מדעי החיים " is how a calendar invite wrote its venue.
  const s = String(address || '').trim().replace(/^[\s\-–—,·:]+|[\s\-–—,·:]+$/g, '');
  if (!needsCity(s)) return s;
  const city = cityOf(homeAddress);
  if (!city) return s;
  return `${s}, ${city}`;
}

/** A town this file knows, named in free text (an event's title): "… - חיפה". */
export function cityNamedIn(text?: string | null): string | null {
  const s = String(text || '').toLowerCase();
  return CITY_WORDS.find((c) => c !== 'israel' && c !== 'ישראל' && s.includes(c.toLowerCase())) ?? null;
}

/**
 * The destination to route to: a bare venue is completed from the city the
 * EVENT names before the city she lives in. "ראיון ראשון - קורל זכאי - חיפה"
 * at " - פארק מדעי החיים " is in Haifa (13.10) — her home city would have put
 * it in Tel Aviv, and the street her home address leads with put it nowhere.
 */
export function completeDestination(address?: string | null, title?: string | null, homeAddress?: string | null): string {
  address = withoutAppendedStreet(address);
  const city = cityNamedIn(title);
  if (!city) return completeAddress(address, homeAddress);
  // The event SAID the town: that is not a guess, so a venue name gets it too.
  const clean = String(address || '').trim().replace(/^[\s\-–—,·:]+|[\s\-–—,·:]+$/g, '');
  return clean && !namesACity(clean) && !clean.includes(',') ? `${clean}, ${city}` : completeAddress(address, homeAddress);
}

/**
 * Undo what the old cityOf appended (13.10): it read the STREET of a home
 * written "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo" as the city, so
 * stored venues ended ", Mordei ha-Geta'ot Street" — "רפאל מכון דוד,
 * Mordei ha-Geta'ot Street" could not be found at all. A last segment that is
 * a bare street name (no number, a street word) is never how a place ends.
 */
export function withoutAppendedStreet(address?: string | null): string {
  const s = String(address || '').trim();
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length < 2) return s;
  const last = parts[parts.length - 1];
  if (!/\d/.test(last) && /(?:^|\s)(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|רחוב|רח')$/i.test(last)) {
    return parts.slice(0, -1).join(', ');
  }
  return s;
}
