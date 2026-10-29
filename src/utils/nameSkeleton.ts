/**
 * nameSkeleton — "סגית" and "Sagit" are one person.
 *
 * 1.10: "שיחה עם סגית" (typed by her, Hebrew) and "Sagit/Koral- intro" (from
 * Google) sat side by side at 20:30 — one call, two cards — because the only
 * test for "the same meeting" was the same WORDS. A name crosses scripts; its
 * consonants survive the trip: ס-ג-ת and s-g-t.
 *
 * Deliberately narrow. It is only ever asked about two things on the same day
 * at the same minute, and it ignores the words every meeting shares
 * ("call", "שיחה", "zoom", "intro"…), so two different meetings at 10:00 stay two.
 *
 * Server twin: server/name_skeleton.py — parity pinned by
 * tests/fixtures/same-name.json (tests/run-same-name.ts + test_same_name.py).
 */

const HE: Record<string, string> = {
  'א': '', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': '', 'ו': '', 'ז': 'z', 'ח': 'K',
  'ט': 't', 'י': '', 'כ': 'K', 'ך': 'K', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n',
  'ן': 'n', 'ס': 's', 'ע': '', 'פ': 'p', 'ף': 'p', 'צ': 'ts', 'ץ': 'ts', 'ק': 'K',
  'ר': 'r', 'ש': 'S', 'ת': 't',
};
/** Hebrew glues these to the front of a word: "לסגית" is "סגית". */
const HE_PREFIX = new Set(['ב', 'ה', 'ו', 'כ', 'ל', 'מ', 'ש']);
const LATIN_PAIRS: Array<[RegExp, string]> = [
  [/sh/g, 'S'], [/ch|kh|ck/g, 'K'], [/tz/g, 'ts'], [/th/g, 't'], [/ph/g, 'p'],
];
const LATIN: Record<string, string> = {
  c: 'K', k: 'K', q: 'K', f: 'p', v: 'b', w: 'b', x: 'Ks',
  a: '', e: '', i: '', o: '', u: '', y: '',
};

function latinSkeleton(word: string): string {
  let w = word.toLowerCase();
  const initialH = w.startsWith('h') && !w.startsWith('sh') ? 'h' : '';
  for (const [re, to] of LATIN_PAIRS) w = w.replace(re, to);
  const body = [...w].map((ch) => (ch === 'h' ? '' : (ch in LATIN ? LATIN[ch] : ch))).join('');
  return initialH + body.replace(/^h/, '');
}

function hebrewSkeleton(word: string): string {
  const initialH = word.startsWith('ה') ? 'h' : '';
  return initialH + [...word].map((ch) => HE[ch] ?? '').join('');
}

const isHebrew = (w: string) => /[א-ת]/.test(w);

/** Every reading of one word: Hebrew with and without a glued prefix letter. */
export function skeletonsOf(word: string): string[] {
  if (isHebrew(word)) {
    const out = [hebrewSkeleton(word)];
    if (word.length >= 4 && HE_PREFIX.has(word[0])) out.push(hebrewSkeleton(word.slice(1)));
    return out;
  }
  return [latinSkeleton(word)];
}

/** The words every meeting shares — never evidence that two are the same one. */
const COMMON = [
  'meeting', 'meet', 'call', 'intro', 'sync', 'zoom', 'teams', 'chat', 'interview', 'lunch',
  'coffee', 'with', 'and', 'the', 'for', 'catch', 'up', 'online', 'video', 'phone', 'review',
  'שיחה', 'שיחת', 'עם', 'פגישה', 'פגישת', 'זום', 'ראיון', 'קפה', 'צהריים', 'טלפון', 'וידאו',
  'אונליין', 'סינק', 'היכרות', 'של', 'את',
];
const COMMON_SKELETONS = new Set(COMMON.flatMap(skeletonsOf));

/** The name-like words of a title, as skeletons. */
function nameSkeletons(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of String(text || '').split(/[^\p{L}]+/u).filter(Boolean)) {
    if (word.length < 2) continue;
    // Two consonants are enough for a NAME — "Dana", "חן", "טל" — so a Latin
    // word must be capitalised to count with two, and Hebrew (no capitals) may
    // always; anything else needs three, so "to", "it" and the like never match.
    const proper = /^[A-Z]/.test(word) || isHebrew(word);
    if (!proper && word.length < 3) continue;
    for (const sk of skeletonsOf(word)) {
      if (COMMON_SKELETONS.has(sk)) continue;
      if (sk.length >= 3 || (proper && sk.length === 2)) out.add(sk);
    }
  }
  return out;
}

/** Do two titles name the same person or thing, across Hebrew and English? */
export function sharesAName(a: string, b: string): boolean {
  const left = nameSkeletons(a);
  if (!left.size) return false;
  for (const sk of nameSkeletons(b)) if (left.has(sk)) return true;
  return false;
}
