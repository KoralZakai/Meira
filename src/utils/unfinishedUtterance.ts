/**
 * unfinishedUtterance — did she stop mid-sentence? (29.10, Koral)
 *
 * The recorder only hears loudness, so a thinking pause looks like the end:
 * "זה לא הגיוני, אני ביום שני בזומבה, ב..." was sent cut. The TRANSCRIPT
 * knows better — a sentence that ends on "and", "ב", "ש", a comma or "אממ"
 * is not finished. ChatMic then keeps listening and joins the two parts.
 * Pure (tests/run-unfinished-utterance.ts).
 */

const HE_TAIL = new Set([
  'ב', 'ל', 'ו', 'ש', 'של', 'עם', 'את', 'על', 'אל', 'מ', 'אבל', 'כי', 'אז', 'או', 'גם', 'רק',
  'אם', 'כש', 'לפני', 'אחרי', 'בין', 'עד', 'מאז', 'וגם', 'ואז', 'ביום', 'בשעה', 'אממ', 'אמ', 'אה',
  'אהה', 'אההה', 'אמממ', 'כאילו', 'רגע', 'בעצם',
]);
const EN_TAIL = new Set([
  'and', 'but', 'or', 'so', 'because', 'to', 'at', 'on', 'in', 'with', 'for', 'of', 'the', 'a', 'an',
  'then', 'um', 'uh', 'hmm', 'like', 'actually', 'if', 'when', 'before', 'after', 'from', 'my',
]);

/** True when the words stop where a sentence cannot. */
export function looksUnfinished(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/(\.\.\.|…|,|-|–)$/.test(t)) return true;
  const last = t.replace(/[.!?؟。]+$/u, '').split(/\s+/).pop()?.toLowerCase() ?? '';
  if (/[?!]$/.test(t)) return false;
  return HE_TAIL.has(last) || EN_TAIL.has(last);
}

/** Two parts of one sentence, without the dangling "..." between them. */
export function joinParts(first: string, second: string): string {
  const a = String(first ?? '').trim().replace(/(\.\.\.|…)$/u, '').trim();
  const b = String(second ?? '').trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

/** How many times one utterance may be continued before it is sent anyway. */
export const MAX_CONTINUATIONS = 2;
