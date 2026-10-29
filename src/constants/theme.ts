/**
 * Lumi brand system — warm "sunny claymorphism".
 * BRAND holds the canonical design tokens; COLORS keeps legacy keys (mapped to
 * the new palette) so existing screens keep working while we migrate.
 */
import { FALLBACK_PLACE, skyFor, sunTimes } from '../utils/skyGradient';

/**
 * Day or night for THIS run of the app (Koral, 28.10: "all the cards and all
 * the screens need to change into night mode, it cannot be half dark half
 * bright"). Every StyleSheet in the app reads BRAND once, when it is created,
 * so the palette is chosen here, at load, from the real sky over Israel
 * (Tel Aviv's sunset — the app's place; a home elsewhere shifts it by minutes).
 * ThemeWatcher (components/ui/SkyBackdrop) reloads the bundle when the sky
 * crosses dusk or dawn, so every screen switches together. Node (tests) always
 * gets the day palette, which the contrast tests were written against.
 */
export function nightNow(at: Date = new Date()): boolean {
  const m = at.getHours() * 60 + at.getMinutes();
  return skyFor(m, sunTimes(at, FALLBACK_PLACE.lat, FALLBACK_PLACE.lng)).dark;
}
// In the app (Hermes / RN), never in node tests. Two signals, so a release build that
// drops one cannot leave the palette stuck on day (and reload on every return).
const IN_APP = (typeof navigator !== 'undefined' && (navigator as any).product === 'ReactNative')
  || typeof (globalThis as any).HermesInternal !== 'undefined';
export const THEME_NIGHT: boolean = IN_APP && nightNow();

/** Option A (her pick, 28.10): WhatsApp's dark — #0B141A ground, #111B21 surfaces. */
const NIGHT_BRAND = {
  honey: '#3A3220',
  cream: '#0B141A',
  creamCard: '#111B21',
  line: '#1F2C34',
  timeChipBg: '#1A252C',
  warmInk: '#E9EDEF',
  inkSoft: '#AEBAC1',
  inkFaint: '#8696A0',
  timeChipText: '#FFD166',
  success: '#3DD68C',
  danger: '#F2667F',
  warnInk: '#FFB454',
  goldInk: '#FFD166',
  goldSoft: '#2A2618',
  lateInk: '#FF8FA3',
  /** A white CARD by day (text on violet / red keeps BRAND.white). */
  surface: '#111B21',
} as const;

const DAY_BRAND = {

  // ── Fills. The identity lives here and is UNCHANGED: the gold, honey and
  // cream are exactly as they were. Yellow is a high-luminance hue, so it can
  // never be readable *as text* on a light ground — it earns its place as a
  // surface with warmInk on top, which measures 5.62:1.
  sunGold: '#F1C24E',   // primary brand, buttons, accents
  amber: '#E5A93A',     // gradient end, pressed states
  honey: '#FBE6A0',     // soft fills, focus cards
  peach: '#F6B98C',     // secondary accent
  cream: '#FCF7EC',     // app background
  creamCard: '#FFFDF7', // cards / surfaces
  line: '#F1E8D6',      // borders / dividers
  white: '#FFFFFF',
  timeChipBg: '#FCF1D6',

  // ── Text. Every one of these was below WCAG AA on the surface it actually
  // sits on — the worst pair in the app was 2.24:1, and the two worst offenders
  // were the clock time and the "done" state, i.e. the two things Lumi exists
  // to tell you. Each is the SAME hue as before (39–43°, the warm family),
  // deepened until it clears 4.5:1. Nothing was greyed out.
  //
  // Tiers get different targets so the hierarchy survives: forcing every tier
  // to the same 4.5 floor collapsed inkSoft and inkFaint onto one value.
  warmInk: '#574326',      // headings / primary       9.23:1 on card
  inkSoft: '#645843',      // secondary text           6.84:1  (was 4.11)
  inkFaint: '#807252',     // tertiary text            4.64:1  (was 2.70)
  timeChipText: '#8B6721', // clock times on chips     4.60:1  (was 2.39)
  success: '#458052',      // done / arrived on time   4.63:1  (was 2.24)
  danger: '#B9526B',       // late / urgent            4.61:1
  warnInk: '#8A5306',      // a possible disruption    ~6:1 on cream (warning orange as TEXT)

  // ── The two halves of "accent". Yellow cannot be both at once, and the
  // terracotta set that used to cover this (CLAUDE.accent) had ONE colour
  // doing both jobs — which is why swapping it for sunGold naively produces
  // gold text on cream at 1.9:1.
  //
  //   goldInk  the gold accent AS TEXT or BORDER, on cream / card  4.79:1
  //   onGold   ink ON a sunGold fill — buttons, chips, ticks       6.96:1
  //
  // Rule: sunGold is a SURFACE, goldInk is the ink of that same accent, and
  // anything sitting on sunGold uses onGold. Never white on gold (1.7:1).
  goldInk: '#8B6721',
  onGold: '#4A3512',
  goldSoft: '#FCF1D6',   // pressed / selected tint (replaces CLAUDE.accentSoft)

  // Late / over-budget AS TEXT on a pale rose or cream ground. `danger` is the
  // fill and border colour (4.61:1 on card); this is its text-weight sibling,
  // used by the late pill, the clash title and the 'N min late' tail so the
  // word 'late' never has to be read at 4.6:1 when it can be 7:1.
  lateInk: '#9C3F57',
  surface: '#FFFFFF',
} as const;

/** A white card by day stays exactly as drawn; at night it is the night surface. */
export const surf = (day: string): string => (THEME_NIGHT ? NIGHT_BRAND.surface : day);

function mixToward(hex: string, to: string, t: number): string {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return `#${[16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('')}`;
}
/** A dark hand-picked text colour (purple, brown, green…) keeps its hue at night, lifted to read on dark. */
export const nink = (day: string): string => (THEME_NIGHT && /^#[0-9a-fA-F]{6}$/.test(day) ? mixToward(day, '#FFFFFF', 0.62) : day);
/** A light hand-picked border keeps its day look; at night it is the night hairline. */
export const nline = (day: string): string => (THEME_NIGHT ? '#26343D' : day);

export const BRAND: { [K in keyof typeof DAY_BRAND]: string } = THEME_NIGHT ? { ...DAY_BRAND, ...NIGHT_BRAND } : DAY_BRAND;

/**
 * CLAUDE — DEPRECATED alias, kept only so a stray import cannot resurrect the
 * terracotta palette.
 *
 * This was an Anthropic-style token set (warm paper, hairline surfaces, one
 * clay accent at #C96442) used by the Today and Schedule screens. The brand is
 * yellow, and running two accent systems meant one screen showed clay chips
 * stacked above gold ones. Every key now resolves to its BRAND equivalent,
 * with `accent` split in two: this maps it to the FILL (sunGold), because a
 * caller that used the accent as TEXT needs BRAND.goldInk instead — which is
 * why every consumer was migrated by hand rather than left pointing here.
 *
 * Do not add new usages. `grep -rn "CLAUDE\." src/` should stay empty.
 */
export const CLAUDE = {
  bg: BRAND.cream,
  card: BRAND.creamCard,
  border: BRAND.line,
  accent: BRAND.sunGold,
  accentSoft: BRAND.goldSoft,
  ink: BRAND.warmInk,
  inkSoft: BRAND.inkSoft,
  inkFaint: BRAND.inkFaint,
  success: BRAND.success,
  white: BRAND.white,
} as const;

/** Category tint helpers — soft fill + border from a category hex. */
export const tint = (hex: string) => `${hex}14`;
export const tintBorder = (hex: string) => `${hex}55`;

/**
 * NOTE_PALETTE — pastel "sticky note" backgrounds used to group tasks by
 * subject on the Tasks screen (mobile) and tasks board (web). Cycles by
 * group index so any number of categories gets a warm, varied look without
 * hand-picking a color per category. Alternating rotation gives the
 * hand-placed sticky-note feel.
 */
const NOTE_PALETTE_DAY = [
  { tint: '#FDEFD9', border: '#F1E0B8', tape: '#F6CF67' },
  { tint: '#FCEADC', border: '#F3D3B8', tape: '#F6B98C' },
  { tint: '#FEF3DC', border: '#F3E1B4', tape: '#FBE6A0' },
  { tint: '#FBEFE3', border: '#F0DFC7', tape: '#F1C24E' },
  { tint: '#FDF1E6', border: '#F2DFC3', tape: '#EAB23F' },
] as const;
// At night the sticky notes are the night surface with a coloured tape — a
// pastel note with light ink was unreadable (28.10, Tasks).
const NOTE_PALETTE_NIGHT = NOTE_PALETTE_DAY.map((n) => ({ tint: '#111B21', border: '#1F2C34', tape: n.tape }));
export const NOTE_PALETTE = THEME_NIGHT ? NOTE_PALETTE_NIGHT : NOTE_PALETTE_DAY;

export function getNoteStyle(index: number) {
  const p = NOTE_PALETTE[index % NOTE_PALETTE.length];
  const rotate = index % 2 === 0 ? '-0.6deg' : '0.5deg';
  const tapeRotate = index % 2 === 0 ? '-3deg' : '2deg';
  return { ...p, rotate, tapeRotate };
}

export const GRADIENTS = {
  // Primary button / accent gradient.
  primary: ['#F6CF67', '#E9AE3C'] as const,
  primaryAngle: 160,
  // Sunny app/splash background (approximated as a vertical stack for RN).
  sunny: ['#FFF4CE', '#FBE6A6', '#F6CF6E'] as const,
  gold: ['#FFF3C4', '#F7D069', '#EAB23F'] as const, // wordmark puff fill
} as const;

/**
 * MIN_TOUCH — the smallest tappable height, in dp. Material and WCAG 2.5.5 both
 * ask for 44-48; a 40 dp pill or a 36 dp text link is one she misses with a
 * thumb. Every button-like Style reaches for this instead of a literal.
 */
export const MIN_TOUCH = 44;

export const RADIUS = {
  card: 20,
  pill: 20,
  button: 20,
  screen: 44,
  icon: 34,
  chip: 12,
} as const;

export const SHADOWS = {
  // Soft, gold-tinted elevation.
  card: {
    shadowColor: '#D6A537',
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  button: {
    shadowColor: '#B47814',
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  orb: {
    shadowColor: '#EAB23F',
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
} as const;

/**
 * FONTS — one modern grotesque, Inter, across the whole app.
 *
 * It replaces three families that were doing three different jobs badly
 * together: Fredoka (a rounded display face) for headings, Nunito for body,
 * and Fraunces (a serif) on the Schedule screen only — so the same app wore a
 * serif title on one tab and a rounded one on the next, and paid for three
 * font payloads before first paint.
 *
 * Inter is the right single answer here: it was drawn for UI at small sizes,
 * its digits are even-width so a rail of clock times lines up instead of
 * shimmering, and this app is Hebrew-first — Fredoka has no Hebrew at all, so
 * every Hebrew heading was already silently falling back to a system face.
 *
 * The KEY NAMES ARE UNCHANGED, `serif` included, so no caller had to be
 * touched. `serif`/`serifBold` now mean "heading", not "serif".
 */
export const FONTS = {
  display: 'Inter_800ExtraBold',
  displaySemi: 'Inter_700Bold',
  body: 'Inter_400Regular',
  // One step lighter than the Nunito weights they replace: Inter's 500/600
  // sit optically where Nunito's 600/700 did, so keeping the old numbers
  // would have made every card heavier than it was before.
  bodySemi: 'Inter_500Medium',
  bodyBold: 'Inter_600SemiBold',
  bodyHeavy: 'Inter_700Bold',
  // Headings. Was Fraunces — kept under the same keys so the Schedule title
  // and the card titles that ask for `serif` keep working untouched.
  serif: 'Inter_600SemiBold',
  serifBold: 'Inter_700Bold',
} as const;

export const COLORS = {
  yellow: '#F1C24E',
  purple: '#6C63FF',
  purpleLight: '#A89CFF',

  // Light mode (remapped to the warm brand)
  lightBg: '#FCF7EC',
  lightCard: '#FFFDF7',
  lightText: '#574326',
  lightTextSecondary: '#8A7A5C',
  lightBorder: '#F1E8D6',

  // Dark mode
  darkBg: '#1A1A2E',
  darkCard: '#252542',
  darkText: '#F0F0F0',
  darkTextSecondary: '#9090AA',
  darkBorder: '#333355',

  // Status
  success: '#06D6A0',
  danger: '#EF476F',
  warning: '#FF9F1C',
  info: '#118AB2',
};

export const CATEGORY_META: Record<string, { color: string; icon: string; labelEn: string; labelHe: string }> = {
  interview:   { color: '#9B5DE5', icon: '🎯', labelEn: 'Interview',   labelHe: 'ראיון' },
  course:      { color: '#4361EE', icon: '📚', labelEn: 'Course',      labelHe: 'קורס' },
  conference:  { color: '#F77F00', icon: '🎪', labelEn: 'Conference',  labelHe: 'כנס' },
  class:       { color: '#FFD166', icon: '✏️', labelEn: 'Class',       labelHe: 'שיעור' },
  work:        { color: '#023E8A', icon: '💼', labelEn: 'Work',        labelHe: 'עבודה' },
  meeting:     { color: '#118AB2', icon: '🤝', labelEn: 'Meeting',     labelHe: 'פגישה' },
  call:        { color: '#06D6A0', icon: '📞', labelEn: 'Call',        labelHe: 'שיחה' },
  doctor:      { color: '#EF476F', icon: '⚕️', labelEn: 'Doctor',      labelHe: 'רופא' },
  gym:         { color: '#FF9F1C', icon: '💪', labelEn: 'Gym',         labelHe: 'אימון' },
  aspiration:  { color: '#FFD166', icon: '⭐', labelEn: 'Aspiration',  labelHe: 'שאיפה' },
  leisure:     { color: '#FF85A1', icon: '🎮', labelEn: 'Leisure',     labelHe: 'פנאי' },
  general:     { color: '#8A8A9A', icon: '📌', labelEn: 'General',     labelHe: 'כללי' },
  zoom:        { color: '#2D8CFF', icon: '💻', labelEn: 'Zoom',        labelHe: 'זום' },
  hobby_class: { color: '#06D6A0', icon: '🎨', labelEn: 'Hobby',       labelHe: 'חוג' },
};

export const PRIORITY_META = {
  must:        { color: '#EF476F', labelEn: 'Must Do',      labelHe: 'חייב לעשות' },
  have_to:     { color: '#FF9F1C', labelEn: 'Have To',      labelHe: 'צריך לעשות' },
  need_to:     { color: '#FFD166', labelEn: 'Need To',      labelHe: 'כדאי לעשות' },
  nice_to_do:  { color: '#06D6A0', labelEn: 'Nice To Do',   labelHe: 'אפשר לעשות' },
};

export const LEVELS = [
  { level: 1, minPoints: 0,    titleEn: 'Getting Started 🌱', titleHe: 'מתחיל 🌱' },
  { level: 2, minPoints: 100,  titleEn: 'Building Momentum 🚀', titleHe: 'בדרך 🚀' },
  { level: 3, minPoints: 300,  titleEn: 'On a Roll 🔥', titleHe: 'בתנופה 🔥' },
  { level: 4, minPoints: 600,  titleEn: 'Time Master ⚡', titleHe: 'מאסטר זמן ⚡' },
  { level: 5, minPoints: 1000, titleEn: 'Lumi Champion 👑', titleHe: 'אלוף לומי 👑' },
];

export const POINTS = {
  task_complete: 10,
  on_time: 20,
  verified_arrival: 25,
  perfect_day: 50,
  streak_bonus: 15,
  task_with_details: 5,
  goal_achieved: 100,
  time_estimate_accurate: 10,
};
