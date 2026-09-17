/**
 * hebrewPlace — separate WHAT KIND of place from WHICH place, in Hebrew.
 *
 * "אימון בחדר כושר ב 8 בערב ביגאל אלון 94" contains three different things:
 *
 *     חדר כושר      what kind of place   (a gym)
 *     יגאל אלון 94   which place          (an address)
 *     8 בערב         when                 (not a place at all)
 *
 * The first version of this file took everything after the first ב-word and
 * returned "חדר כושר ב 8 בערב ביגאל אלון 94" as the address — the whole
 * sentence, time included. That is worse than extracting nothing: a task with
 * no address asks; a task with a nonsense address routes her somewhere real
 * and wrong.
 *
 * Two rules earn their keep here:
 *
 *   1. A VENUE TYPE is not an address. "חדר כושר", "בית", "משרד" say what kind
 *      of place, and the actual location has to come from somewhere else —
 *      which is precisely what known_places is for ("is this your usual gym?").
 *      Returning it as `activity` is what lets Lumi ask that question once and
 *      never again.
 *
 *   2. An address must LOOK like one. A house number, an explicit lead
 *      (ברחוב/בשדרות), or a short proper name. Anything else returns null,
 *      because guessing here sends her to the wrong city.
 *
 * Pure: no geocoding. The caller resolves `place` to real coordinates and uses
 * `activity` as the known_places key.
 *
 * Consumed by services/TaskParser.extractLocation, hooks/useTasks.addManualTask.
 */

/** ב + one of these is a TIME or a quantity, never a place. */
const TIME_WORDS = [
  'ערב', 'בוקר', 'צהריים', 'צהרים', 'לילה', 'אמצע', 'סוף', 'תחילת',
  'עוד', 'שעה', 'שעות', 'שעתיים', 'דקה', 'דקות',
  'יום', 'ימים', 'יומיים', 'שבוע', 'שבועות', 'שבועיים',
  'חודש', 'חודשים', 'חודשיים', 'שנה', 'שנים',
  'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת',
  'מחר', 'מחרתיים', 'אמש', 'סביבות', 'משך', 'זמן',
  'דיוק', 'סדר', 'קלות', 'כלל', 'ערך', 'הצלחה', 'שקט', 'רגע', 'מקביל',
];

/**
 * Kinds of place, not places. Longest first so "חדר כושר" wins over "חדר".
 * These become `activity` — the key Lumi remembers an address against.
 */
const VENUE_TYPES = [
  'חדר כושר', 'בית ספר', 'בית חולים', 'תחנת רכבת', 'קניון',
  'מכון כושר', 'בריכה', 'ספרייה', 'ספריה', 'מרפאה', 'קליניקה',
  'עבודה', 'משרד', 'בית', 'גן', 'אוניברסיטה', 'מכללה', 'סטודיו',
];

/**
 * ב + one of these is an ADVERBIAL phrase, not a place: "בקשר לפרויקט"
 * (regarding), "בנוגע ל…", "במקרה ש…". They pass every structural test — two
 * short Hebrew words at the end of a sentence — so only a list catches them.
 */
const NON_PLACE_WORDS = [
  'קשר', 'נוגע', 'מקרה', 'אופן', 'כוונה', 'הקשר', 'ספק', 'טעות',
  'חינם', 'פועל', 'עיקרון', 'ניגוד', 'משותף', 'תוקף', 'מקום', 'אמת',
  'עצם', 'המשך', 'מיוחד', 'כללי', 'פרט', 'צורה', 'מידה', 'תנאי',
];

/** Words that introduce an address explicitly — what follows IS the address. */
const ADDRESS_LEADS = ['רחוב', 'רח', 'שדרות', 'שד', 'כתובת', 'סניף'];

const HEB = /[֐-׿]/;
/** A token that starts a time phrase, so the address stops before it. */
const TIME_TOKEN = /^(?:ב-?\d{1,2}(?::\d{2})?|\d{1,2}:\d{2}|ב|בשעה|בערב|בבוקר|בלילה|בצהריים|מחר|מחרתיים|היום|עד|ל)$/;

export interface HebrewPlace {
  /** The address, when the text actually names one. */
  place: string | null;
  /** The KIND of place ("חדר כושר"), when named. The known_places key. */
  activity: string | null;
}

const clean = (w: string) => w.replace(/^ב-?/, '').replace(/[.,;:!?]+$/, '');

/** Does this read like an address rather than a fragment of a sentence? */
function looksLikeAddress(candidate: string, hadLead: boolean): boolean {
  if (hadLead) return true;
  const words = candidate.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  // "יגאל אלון 94" — a house number is the strongest signal there is.
  if (/^\d{1,4}$/.test(words[words.length - 1])) return words.length <= 5;
  // "ספייס ג'ים" — a short proper name, with no leftover sentence around it.
  return words.length <= 2
    && !words.some((w) => TIME_WORDS.includes(clean(w)) || NON_PLACE_WORDS.includes(clean(w)));
}

/**
 * The place and the kind of place named in this Hebrew text.
 *
 * Both may be null. Returning null is a real answer — it makes Lumi ask
 * instead of inventing an address.
 */
export function extractHebrewPlaceParts(text: string): HebrewPlace {
  const empty: HebrewPlace = { place: null, activity: null };
  if (!text || !HEB.test(text)) return empty;

  const tokens = text.split(/\s+/).filter(Boolean);
  let activity: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    if (!/^ב-?[֐-׿]/.test(tokens[i])) continue;   // a lone "ב" is the time form
    const word = clean(tokens[i]);
    if (!word || TIME_WORDS.includes(word) || NON_PLACE_WORDS.includes(word)) continue;

    // A venue TYPE ("בחדר כושר") — remember what kind, keep looking for where.
    const twoWords = `${word} ${tokens[i + 1] ? clean(tokens[i + 1]) : ''}`.trim();
    const venue = VENUE_TYPES.find((v) => v === twoWords) ?? VENUE_TYPES.find((v) => v === word);
    if (venue) {
      activity = activity ?? venue;
      i += venue.split(' ').length - 1;
      continue;
    }

    const hadLead = ADDRESS_LEADS.includes(word.replace(/['"]/g, ''));
    // Collect forward, stopping at the first token that starts a time phrase —
    // "ביגאל אלון 94 ב 8 בערב" must not swallow its own hour.
    const parts: string[] = [];
    for (let j = hadLead ? i + 1 : i; j < tokens.length; j++) {
      const t = j === i && !hadLead ? clean(tokens[j]) : tokens[j].replace(/[.,;:!?]+$/, '');
      if (TIME_TOKEN.test(t) || TIME_WORDS.includes(clean(t))) break;
      parts.push(t);
    }
    const candidate = parts.join(' ').trim();
    if (candidate.length >= 2 && looksLikeAddress(candidate, hadLead)) {
      return { place: candidate, activity };
    }
  }
  return { place: null, activity };
}

/** Back-compat: just the address. */
export function extractHebrewPlace(text: string): string | null {
  return extractHebrewPlaceParts(text).place;
}
