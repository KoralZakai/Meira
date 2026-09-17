/**
 * placeFromText — the place in a sentence, in either language.
 *
 * utils/hebrewPlace is Hebrew-only by construction: it opens with
 * `if (!HEB.test(text)) return empty`, because Hebrew glues its "at/in" to the
 * next word ("ביגאל אלון 94") and needs a parser built around that.
 * services/TaskParser has the English half — a preposition pattern — but it is
 * an unexported function inside a module that imports react-native, so nothing
 * outside the app can reach it and no test can drive it.
 *
 * That split did not matter while every chat message went to the server. It
 * started mattering the moment the on-device fallback became real
 * (utils/localTaskExtract), because the fallback inherited the Hebrew-only
 * parser: "יוגה מחר ב 11 בבוקר ביגאל אלון 94" kept its address and
 * "yoga tomorrow at 11 am at Yigal Alon 94" silently lost it — same task, same
 * hour, no place, so no route, no leave time and no alarm.
 *
 * Found 2026-09-17 while setting up an end-to-end test on the phone: adb
 * cannot type Hebrew, so the test had to run in English, and the English path
 * turned out to be the weaker one. Worth having anyway — the app is about to
 * be given to English-speaking friends.
 *
 * Pure. The English pattern is TaskParser's, kept character-for-character so
 * the two cannot disagree about what counts as a place.
 */
import { extractHebrewPlaceParts, HebrewPlace } from './hebrewPlace';

/**
 * "…at Yigal Alon 94", "…in Binyamina", "…to the clinic".
 *
 * Stops before the words that begin a DIFFERENT clause — "with Danny", "call
 * her", "because…" — so a place never swallows the rest of the sentence. That
 * is the same failure hebrewPlace was written to stop, in the other language.
 */
const EN_PLACE = /\b(?:in|at|to|arrive to|go to|head to)\s+([^,.;]+?)(?=\s+\b(?:with|call|text|message|number|phone|via|because|for)\b|$)/i;

/**
 * Time expressions, removed BEFORE looking for a place.
 *
 * This is the same move hebrewPlace makes when it breaks at its TIME_TOKEN,
 * and it is necessary for the same reason: English "at" introduces both an
 * hour and an address, so a single preposition pattern cannot tell
 * "at 11 am" from "at Yigal Alon 94". Matching first and cleaning afterwards
 * does not work either — "yoga tomorrow at 11 am at Yigal Alon 94" matches the
 * FIRST `at` and yields "11 am at Yigal Alon 94", which is thrown away by the
 * leading-digit guard. The address was there; the pattern simply started in
 * the wrong place.
 */
const EN_TIME = [
  /\b(?:at|from|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
  /\b\d{1,2}:\d{2}\b/g,
  /\b\d{1,2}\s*(?:am|pm)\b/gi,
  /\b(?:today|tomorrow|tonight|this morning|this afternoon|this evening|next week)\b/gi,
];

/** The sentence with its clock and calendar words taken out. */
export function withoutTimeWords(text: string): string {
  let out = String(text || '');
  for (const re of EN_TIME) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

export function extractEnglishPlace(text: string): string | null {
  // Strip the time FIRST, then look for the place in what is left.
  const match = withoutTimeWords(text).match(EN_PLACE);
  if (!match) return null;
  const place = match[1].trim().replace(/^(the)\s+/i, '').trim();
  // A place cannot BE a number. TaskParser's own guard, and what stopped the
  // English branch ever returning "11 am".
  if (!place || /^\d/.test(place)) return null;
  return place;
}

export function placePartsFrom(text: string): HebrewPlace {
  const hebrew = extractHebrewPlaceParts(text);
  if (hebrew.place) return hebrew;
  const english = extractEnglishPlace(text);
  return { place: english, activity: hebrew.activity };
}
