/**
 * liveParse — what the Add screen understood from the words so far.
 *
 * Runs on EVERY keystroke: local, free, no model, no network. "ראיון ביום
 * ראשון ב 13:30 ברפאל מכון דוד" becomes
 *
 *     🎯 interview · Sun 18.10 · 13:30–15:00 · 📍 רפאל מכון דוד
 *
 * as chips under the input, so she sees what will be saved BEFORE she taps Add
 * (Koral 17.10: "parsing happens while typing"). The ✨ Parse-with-Lumi button
 * it replaces was a model call she had to remember to ask for.
 *
 * Nothing here is new knowledge — it composes the parsers the save path
 * already uses, so a chip cannot promise what the save will not do:
 *
 *   time / endTime   utils/timeParser.parseTimeExpression
 *   date             utils/dateExpression (a port of server/tz.resolve_date)
 *   category         utils/categorize.inferFromText (the server's own table)
 *   place            utils/hebrewPlace first; a looser guess only for a
 *                    sentence that is plainly an appointment (below)
 *   person           her contacts, plus the family words — "dad", "אבא",
 *                    "לאבא שלי" all mean the contact called אבא or Dad
 *
 * Each recognised fact carries the SPAN of words that said it, so a chip's ✕
 * deletes exactly those words from the input. The input text stays the single
 * source of truth: removing a chip that only hid the fact would leave the save
 * path reading it from the sentence anyway — a chip that lies (CLAUDE.md,
 * silent-state rule: Lumi knew and did not say).
 *
 * Pure. Contacts and known places are PASSED IN; the screen loads them.
 */
import type { Task, TaskCategory, TaskPriority } from '../types/index';
import { isPrepBlock } from './interviewPrep';
import { parseTimeExpression } from './timeParser';
import { inferFromText } from './categorize';
import { findDateExpression, localKey, type DateSpan } from './dateExpression';
import { conceptOf, resolvePlace, type KnownPlaces } from './knownPlaces';
import { extractHebrewPlaceParts } from './hebrewPlace';
import { getNameVariants } from './fuzzyMatch';
import { CATEGORY_META } from '../constants/theme';

export type Span = DateSpan;

export interface LiveContact { id?: string; name: string; phone?: string }

export type Relation =
  'dad' | 'mom' | 'brother' | 'sister' | 'grandma' | 'grandpa' | 'wife' | 'husband' | 'partner' | 'son' | 'daughter';

export interface LivePerson {
  /** What the chip says: the contact's name when matched, else what she wrote. */
  label: string;
  relation?: Relation;
  /** The contact it resolved to — absent when none matched or several did. */
  contact?: LiveContact;
  /** Two contacts fit equally well ("דני כהן", "דני לוי"): the chip asks, it does not guess. */
  ambiguous?: boolean;
  span: Span;
}

export interface LivePlace {
  text: string;
  /** 'typed' — in the sentence; 'known' — her usual place for this activity. */
  source: 'typed' | 'known';
  /** The words that said it. Absent for a known place (nothing was typed). */
  span?: Span;
}

export type Occasion = 'birthday' | 'wedding' | 'anniversary' | 'party' | 'gift' | 'baby';

export interface LiveParse {
  /** The sentence without its date and time words — what the task is ABOUT. */
  title: string;
  category: TaskCategory;
  icon: string;
  priority: TaskPriority;
  /** Default length for the category; a time RANGE overrides it. */
  durationMinutes: number;
  /** False when nothing in the category table fired (general is a shrug, not a finding). */
  categoryMatched: boolean;
  time?: string;
  endTime?: string;
  /** YYYY-MM-DD, only when the sentence SAID a day. */
  date?: string;
  person?: LivePerson;
  place?: LivePlace;
  occasion?: Occasion;
  spans: { time?: Span; date?: Span; person?: Span; place?: Span };
}

export interface LiveParseOptions {
  now?: Date;
  contacts?: LiveContact[];
  knownPlaces?: KnownPlaces | null;
  language?: 'he' | 'en';
}

const HEB = /[֐-׿]/;
const HEB_CLASS = '\\u0590-\\u05FF';

// ── small string helpers ────────────────────────────────────────────────────

function maskSpan(s: string, sp?: Span): string {
  return sp ? s.slice(0, sp.start) + ' '.repeat(sp.end - sp.start) + s.slice(sp.end) : s;
}

/** The text with one span cut out and the seam closed. */
export function removeSpan(text: string, sp: Span): string {
  const out = (text.slice(0, sp.start) + ' ' + text.slice(sp.end)).replace(/\s{2,}/g, ' ');
  return out.replace(/^\s+/, '').replace(/\s+([,.;:!?])/g, '$1');
}

/** Lower-case, no niqqud, no quote marks — "אבא'ל" and "Dad's" compare plainly. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/['’`׳"״]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Tok { raw: string; n: string; start: number; end: number }

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[^\s,.;:!?()]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // "dad's" → "dad": the possessive is not part of the word.
    const raw = m[0].replace(/['’]s$/i, '');
    out.push({ raw: m[0], n: norm(raw), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** One Hebrew prefix letter off a long-enough word: "לאבא" → "אבא". */
const HE_PREFIX = 'בלמהוכש';
const unprefixed = (w: string): string =>
  (w.length > 3 && HE_PREFIX.includes(w[0]) && HEB.test(w[1])) ? w.slice(1) : w;

// ── family words ────────────────────────────────────────────────────────────

interface Family { key: Relation; en: string[]; he: string[]; labelEn: string; labelHe: string }

/**
 * Words that mean a relative, and what to call her on a chip. Deliberately
 * short: "אבי" and "בני" are first names, "אחות" is also a nurse, and
 * "partner" is a business partner as often as a spouse — each would put a
 * person chip on a sentence that has no person in it.
 */
export const FAMILY: Family[] = [
  { key: 'dad', en: ['dad', 'daddy', 'father', 'papa'], he: ['אבא', 'אבאל', 'אבאלה'], labelEn: 'Dad', labelHe: 'אבא' },
  { key: 'mom', en: ['mom', 'mum', 'mommy', 'mummy', 'mother', 'mama'], he: ['אמא', 'אימא', 'אמאל', 'אמאלה'], labelEn: 'Mom', labelHe: 'אמא' },
  { key: 'brother', en: ['brother'], he: ['אחי', 'אח שלי'], labelEn: 'Brother', labelHe: 'אח' },
  { key: 'sister', en: ['sister'], he: ['אחותי', 'אחות שלי'], labelEn: 'Sister', labelHe: 'אחות' },
  { key: 'grandma', en: ['grandma', 'grandmother', 'granny', 'nana'], he: ['סבתא', 'סבתי'], labelEn: 'Grandma', labelHe: 'סבתא' },
  { key: 'grandpa', en: ['grandpa', 'grandfather', 'grandad'], he: ['סבא'], labelEn: 'Grandpa', labelHe: 'סבא' },
  { key: 'wife', en: ['wife'], he: ['אשתי', 'אישתי'], labelEn: 'Wife', labelHe: 'אשתי' },
  { key: 'husband', en: ['husband'], he: ['בעלי'], labelEn: 'Husband', labelHe: 'בעלי' },
  { key: 'partner', en: ['boyfriend', 'girlfriend'], he: ['בן זוג', 'בת זוג', 'בן הזוג', 'בת הזוג'], labelEn: 'Partner', labelHe: 'בן/בת זוג' },
  { key: 'son', en: ['son'], he: ['הבן שלי'], labelEn: 'Son', labelHe: 'הבן שלי' },
  { key: 'daughter', en: ['daughter'], he: ['הבת שלי'], labelEn: 'Daughter', labelHe: 'הבת שלי' },
];

function relationOfWords(words: string[]): Relation | null {
  const joined = words.join(' ');
  for (const f of FAMILY) {
    if (f.en.includes(joined) || f.he.includes(joined) || f.he.includes(unprefixed(joined))) return f.key;
  }
  return null;
}

/** Which relative does this CONTACT NAME say it is ("Dad 🏠", "אבא נייד")? */
function relationOfContact(name: string): Relation | null {
  const toks = norm(name).split(' ').filter(Boolean);
  for (let i = 0; i < toks.length; i += 1) {
    const one = relationOfWords([toks[i]]);
    if (one) return one;
    if (toks[i + 1]) {
      const two = relationOfWords([toks[i], toks[i + 1]]);
      if (two) return two;
    }
  }
  return null;
}

// Hebrew words that look like a first name and are not one.
const NOT_A_NAME = new Set(['עם', 'את', 'של', 'על', 'אל', 'מה', 'לי', 'לו', 'לה', 'כל', 'גם', 'אם', 'או', 'זה']);

function findPerson(text: string, contacts: LiveContact[], he: boolean): LivePerson | undefined {
  const toks = tokenize(text);
  if (!toks.length) return undefined;

  // 1. A relative, by the family words.
  for (let i = 0; i < toks.length; i += 1) {
    let rel = relationOfWords([toks[i].n]);
    let last = i;
    if (!rel && toks[i + 1]) {
      rel = relationOfWords([toks[i].n, toks[i + 1].n]);
      if (rel) last = i + 1;
    }
    if (!rel) continue;
    // "אבא שלי" — take the "mine" with it, so a ✕ leaves no stray word behind.
    if (toks[last + 1] && /^(שלי|שלו|שלה)$/.test(toks[last + 1].n)) last += 1;
    const span = { start: toks[i].start, end: toks[last].end };
    const fam = FAMILY.find((f) => f.key === rel)!;
    const named = contacts.filter((c) => relationOfContact(c.name) === rel);
    if (named.length === 1) {
      return { label: named[0].name, relation: rel, contact: named[0], span };
    }
    return {
      label: he ? fam.labelHe : fam.labelEn,
      relation: rel,
      ...(named.length > 1 ? { ambiguous: true } : {}),
      span,
    };
  }

  // 2. A contact, by name — the whole name outranks a first name.
  type Cand = { c: LiveContact; score: number; span: Span };
  const cands: Cand[] = [];
  for (const c of contacts) {
    const ctoks = norm(c.name).split(' ').filter((w) => w.length >= 2);
    if (!ctoks.length || relationOfContact(c.name)) continue;
    // Whole name: consecutive tokens.
    if (ctoks.length > 1) {
      for (let i = 0; i + ctoks.length <= toks.length; i += 1) {
        const ok = ctoks.every((w, k) => toks[i + k].n === w || unprefixed(toks[i + k].n) === w);
        if (ok) { cands.push({ c, score: 3, span: { start: toks[i].start, end: toks[i + ctoks.length - 1].end } }); break; }
      }
    }
    // First name (and its Hebrew/English spellings).
    const variants = new Set(getNameVariants(ctoks[0]).map((v) => norm(v)));
    variants.add(ctoks[0]);
    for (let i = 0; i < toks.length; i += 1) {
      const w = toks[i].n;
      const hit = variants.has(w) || variants.has(unprefixed(w));
      if (!hit || NOT_A_NAME.has(w)) continue;
      const bare = unprefixed(w);
      const cue = i > 0 && /^(עם|את|ל|with|call|text|to|for|meet)$/.test(toks[i - 1].n);
      // A two-letter name ("גל", "דן") is also a word: only after a cue.
      if (bare.length < 3 && !cue) continue;
      cands.push({ c, score: 2, span: { start: toks[i].start, end: toks[i].end } });
      break;
    }
  }
  if (cands.length) {
    const best = Math.max(...cands.map((x) => x.score));
    const top = cands.filter((x) => x.score === best);
    const same = top.filter((x) => x.span.start === top[0].span.start);
    if (same.length === 1) {
      return { label: same[0].c.name, contact: same[0].c, span: same[0].span };
    }
    // Several contacts answer to the same word — say so, do not pick one.
    const raw = text.slice(top[0].span.start, top[0].span.end);
    return { label: raw, ambiguous: true, span: top[0].span };
  }

  // 3. A capitalised name after "with / call / text / meet" — a person we have
  //    no contact for. Hebrew needs a contact (a name has no capital letter).
  const m = text.match(/\b(?:with|call|text|ping|meet(?:ing)?(?:\s+with)?)\s+([A-Z][a-z]{2,})\b/);
  if (m && m.index != null) {
    const name = m[1];
    if (!/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|The|Meeting|Lunch|Dinner)$/.test(name)) {
      const start = m.index + m[0].length - name.length;
      return { label: name, span: { start, end: start + name.length } };
    }
  }
  return undefined;
}

// ── occasion (a hint, not a category) ───────────────────────────────────────

const OCCASIONS: Array<[Occasion, RegExp]> = [
  ['birthday', new RegExp(`\\bb-?day\\b|birthday|יום\\s*הולדת|ימי\\s*הולדת`, 'i')],
  ['wedding', new RegExp(`\\bwedding\\b|\\bengagement\\b|(?<![${HEB_CLASS}])[בלה]?(?:חתונה|אירוסין)`, 'i')],
  ['anniversary', new RegExp(`anniversary|יום\\s*נישואי?ן|יום\\s*נישואים|יום\\s*שנה`, 'i')],
  ['baby', new RegExp(`baby\\s*shower|bar\\s*mitzvah|bat\\s*mitzvah|בר\\s*מצווה|בת\\s*מצווה|ברית|בריתה|שבע\\s*ברכות`, 'i')],
  ['gift', new RegExp(`\\bgift\\b|(?<![${HEB_CLASS}])[בלה]?מתנה`, 'i')],
  ['party', new RegExp(`\\bparty\\b|housewarming|\\bgraduation\\b|(?<![${HEB_CLASS}])[בלה]?מסיבה|חנוכת\\s*בית|טקס\\s*סיום`, 'i')],
];

function findOccasion(text: string): Occasion | undefined {
  return OCCASIONS.find(([, re]) => re.test(text))?.[0];
}

// ── time ────────────────────────────────────────────────────────────────────

const DAYPART = 'am|pm|a\\.m\\.|p\\.m\\.|בערב|בבוקר|בלילה|בצהריים|אחה["״]?צ';
// The words that said the time. Colon times first (unambiguous), then an hour
// that needs its preposition ("ב 8", "at 5") — a bare number is a count.
const TIME_SPAN_RES: RegExp[] = [
  new RegExp(
    `(?<![${HEB_CLASS}\\d])(?:(?:from|between|at|by|בין|בשעה|מ-?|ב-?)\\s*)?\\d{1,2}:\\d{2}\\s*(?:${DAYPART})?`
    + `(?:\\s*(?:-|–|—|to|until|till|and|עד|ל-?)\\s*\\d{1,2}:\\d{2}\\s*(?:${DAYPART})?)?`, 'i'),
  new RegExp(
    `(?<![${HEB_CLASS}\\d])(?:from|between|at|by|בין|בשעה|מ-?|ב-?)\\s*\\d{1,2}\\s*(?:${DAYPART})?`
    + `(?:\\s*(?:-|–|—|to|until|till|and|עד|ל-?)\\s*\\d{1,2}\\s*(?:${DAYPART})?)?(?:\\s*ו?(?:חצי|רבע))?`, 'i'),
  new RegExp(`(?<![${HEB_CLASS}\\d])\\d{1,2}\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)`, 'i'),
];

function findTimeSpan(text: string, wantStart: string): Span | undefined {
  for (const re of TIME_SPAN_RES) {
    const m = text.match(re);
    if (!m || m.index == null) continue;
    // The words must read back as the very time we parsed — otherwise this is a
    // different number and a ✕ would cut the wrong thing out of the sentence.
    const back = parseTimeExpression(m[0].trim());
    if (back.fixedTime === wantStart) {
      return { start: m.index, end: m.index + m[0].replace(/\s+$/, '').length };
    }
  }
  return undefined;
}

// ── place ───────────────────────────────────────────────────────────────────

const EN_NOT_A_PLACE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Noon|Midnight|Home|Work|School|The|A|My|Our|Your|Night|Dawn|Lunch|Dinner)$/;
// "at Rafael David Institute," — a capitalised run (or one with a house number)
// after at / in. Lower-case "at noon" and "in the morning" are not places.
const EN_PLACE = /\b(?:at|in|@)\s+((?:[A-Z0-9][\w'’.&-]*)(?:\s+(?:[A-Z0-9][\w'’.&-]*|of|the|de|and|&))*)/g;

function englishPlace(masked: string): { text: string; span: Span } | undefined {
  EN_PLACE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EN_PLACE.exec(masked)) !== null) {
    const words = m[1].replace(/[\s.,;:]+$/, '').split(/\s+/);
    while (words.length && /^(?:of|the|de|and|&)$/i.test(words[words.length - 1])) words.pop();
    if (!words.length || EN_NOT_A_PLACE.test(words[0])) continue;
    const text = words.join(' ');
    // A bare number is an hour or a count, not a place.
    if (/^\d+$/.test(text)) continue;
    const start = m.index;
    const end = m.index + m[0].indexOf(m[1]) + text.length;
    return { text, span: { start, end } };
  }
  return undefined;
}

// A sentence that happens SOMEWHERE: the loose Hebrew guess is only made for
// these, as hebrewPlace.looksLikeAddress is (a name needs a reason to be one).
const HE_APPOINTMENT = /ראיון|פגישה|פגישת|תור(?![֐-׿])|רופא|מרפאה|הרצאה|כנס|שיעור|סדנה|אירוע|ביקור/;
const HE_TIME_WORD = /^(?:יום|ימים|יומיים|ערב|בוקר|צהריים|צהרים|לילה|שבוע|שבועות|חודש|שנה|שעה|שעות|דקות|עוד|סביבות|מחר|מחרתיים|היום|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|קשר|נוגע|מקרה|אופן)$/;
const HE_STOP = /^(?:ב|בשעה|עד|ל|מ|עם|ו|בערב|בבוקר|בלילה|בצהריים|מחר|היום|על|את)$/;
const HE_VENUE = new Set(['חדר כושר', 'בית', 'עבודה', 'משרד', 'מרפאה', 'בריכה', 'קניון', 'סטודיו', 'גן', 'אוניברסיטה', 'מכללה', 'בית ספר', 'בית חולים']);

function hebrewPlace(masked: string): { text: string; span: Span } | undefined {
  // 1. The save path's own extractor — what it finds is what will be saved.
  const strict = extractHebrewPlaceParts(masked).place;
  const toks = tokenize(masked);
  const locate = (placeText: string): { text: string; span: Span } | undefined => {
    const idx = masked.indexOf(placeText);
    if (idx < 0) return undefined;
    let start = idx;
    if (masked[start - 1] === '-' && masked[start - 2] === 'ב') start -= 2;
    else if (masked[start - 1] === 'ב') start -= 1;
    return { text: placeText, span: { start, end: idx + placeText.length } };
  };
  if (strict) {
    const found = locate(strict);
    if (found) return found;
  }
  // 2. A looser guess, for a sentence that is plainly an appointment.
  if (!HE_APPOINTMENT.test(masked)) return undefined;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (!/^ב-?[֐-׿]/.test(t.raw)) continue;
    const first = t.raw.replace(/^ב-?/, '').replace(/[.,;:!?]+$/, '');
    if (!first || HE_TIME_WORD.test(first)) continue;
    const words: Tok[] = [t];
    const parts = [first];
    let ended = /[,;.]$/.test(t.raw);
    for (let j = i + 1; j < toks.length && parts.length < 4 && !ended; j += 1) {
      const w = toks[j].raw.replace(/[.,;:!?]+$/, '');
      if (!w || HE_STOP.test(w) || HE_TIME_WORD.test(w)) break;
      words.push(toks[j]);
      parts.push(w);
      ended = /[,;.]$/.test(toks[j].raw);
    }
    const text = parts.join(' ');
    if (HE_VENUE.has(text) || text.length < 2) continue;      // a KIND of place is not a place
    return { text, span: { start: t.start, end: words[words.length - 1].end - (ended ? 1 : 0) } };
  }
  return undefined;
}

// ── the whole sentence ──────────────────────────────────────────────────────

/** Read a sentence. Safe on any string, including empty. */
export function liveParse(text: string, opts: LiveParseOptions = {}): LiveParse {
  const raw = String(text || '');
  const now = opts.now ?? new Date();
  const he = opts.language ? opts.language === 'he' : HEB.test(raw);
  const inferred = inferFromText(raw);
  // "Prep for the Rafael interview" is preparation — studying — not another
  // interview. Without this a suggestion's own prefill drew a 🎯 chip and asked
  // the server for "prep blocks" of a prep block (the same runaway
  // utils/interviewPrep.isPrepBlock exists to stop on the calendar side).
  if (inferred.category === 'interview' && isPrepBlock({ id: '', text: raw } as Task)) {
    inferred.category = 'course'; inferred.priority = 'have_to'; inferred.durationMinutes = 60;
  }
  const meta = CATEGORY_META[inferred.category] ?? CATEGORY_META.general;

  const out: LiveParse = {
    title: raw.trim(),
    category: inferred.category,
    icon: meta.icon,
    priority: inferred.priority,
    durationMinutes: inferred.durationMinutes,
    categoryMatched: inferred.matched,
    spans: {},
  };
  if (!raw.trim()) return out;

  // Date first, then blank its words: "ב-20.10" must not also be read as the
  // hour 20 (timeParser takes any "ב" + digits for a clock).
  const dateHit = findDateExpression(raw, now);
  let work = raw;
  if (dateHit) {
    out.date = dateHit.key;
    out.spans.date = dateHit.span;
    work = maskSpan(work, dateHit.span);
  }

  // Time.
  const te = parseTimeExpression(work, localKey(now));
  if (te.fixedTime) {
    out.time = te.fixedTime;
    if (te.endTime) out.endTime = te.endTime;
    const sp = findTimeSpan(work, te.fixedTime);
    if (sp) out.spans.time = sp;
  }
  if (te.durationMinutes) out.durationMinutes = te.durationMinutes;
  work = maskSpan(work, out.spans.time);

  // Occasion and person.
  out.occasion = findOccasion(raw);
  if (!out.occasion) delete out.occasion;
  const person = findPerson(work, opts.contacts ?? [], he);
  if (person) { out.person = person; out.spans.person = person.span; }

  // Place: typed first; her usual one only when she typed none.
  const typed = HEB.test(work) ? hebrewPlace(work) : englishPlace(work);
  const typed2 = typed ?? (HEB.test(work) ? englishPlace(work) : undefined);
  if (typed2) {
    out.place = { text: typed2.text, source: 'typed', span: typed2.span };
    out.spans.place = typed2.span;
  } else if (opts.knownPlaces && conceptOf(raw)) {
    const known = resolvePlace(opts.knownPlaces, raw);
    if (known?.address) out.place = { text: known.address, source: 'known' };
  }

  // Title: the sentence minus its when-words.
  let title = raw;
  const cuts = [out.spans.date, out.spans.time].filter(Boolean) as Span[];
  for (const sp of cuts.sort((a, b) => b.start - a.start)) title = removeSpan(title, sp);
  out.title = title
    .replace(/\s+(?:at|on|by|in|ב|ל)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}

/**
 * A string that changes exactly when the SENSE of the sentence changes — not
 * when she types another letter of a word. The conclusions call is gated on it:
 * a new model call for "dad" → "dad's" would be money spent on nothing.
 */
export function parseSignature(p: LiveParse): string {
  return [
    p.category, p.time ?? '', p.endTime ?? '', p.date ?? '',
    p.person ? `${p.person.relation ?? ''}:${p.person.contact?.name ?? p.person.label}` : '',
    p.place?.text ?? '', p.occasion ?? '',
  ].join('|');
}
