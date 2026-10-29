/**
 * skyGradient — the Today background follows the real sky outside.
 *
 * Koral, 26–27.10 (design canvas v3): morning light blue with a touch of
 * yellow, noon more yellow, then a gentle pastel sunset, then night. Soft and
 * light only — a saturated yellow→pink→violet mesh was tried and rejected
 * ("really bad"). The hour each phase starts is the REAL sunrise / sunset for
 * where she is, computed here (NOAA's simplified solar equations), so no API
 * call and nothing to fail at the edge.
 *
 * Pure: the caller passes the date, the place and the minute of the day.
 */

export interface SunTimes {
  /** Minutes after local midnight. */
  sunrise: number;
  sunset: number;
  solarNoon: number;
}

export type SkyPhase = 'night' | 'dawn' | 'morning' | 'noon' | 'sunset' | 'dusk';

export interface Sky {
  phase: SkyPhase;
  /** Top → bottom, always four stops. */
  colors: [string, string, string, string];
  /** Light text and controls on top of it. */
  dark: boolean;
}

/** Tel Aviv — used only when there is no fix and no home; the caller says so. */
export const FALLBACK_PLACE = { lat: 32.0853, lng: 34.7818 };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Sunrise, sunset and solar noon for a calendar day at a place.
 * `tzOffsetMinutes` is the local offset from UTC on that day (Israel: 120 in
 * winter, 180 in summer); by default the device's own offset for that date.
 * Polar day / night are clamped to 00:00 / 24:00 — Meira does not ship there.
 */
export function sunTimes(date: Date, lat: number, lng: number, tzOffsetMinutes = -date.getTimezoneOffset()): SunTimes {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);
  const g = ((2 * Math.PI) / 365) * (day - 1);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosHa = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
  const ha = deg(Math.acos(Math.max(-1, Math.min(1, cosHa))));
  const noonUtc = 720 - 4 * lng - eqTime;
  const clamp = (m: number) => Math.max(0, Math.min(1440, m));
  return {
    sunrise: clamp(noonUtc - 4 * ha + tzOffsetMinutes),
    sunset: clamp(noonUtc + 4 * ha + tzOffsetMinutes),
    solarNoon: clamp(noonUtc + tzOffsetMinutes),
  };
}

type Stops = [string, string, string, string];
const NIGHT: Stops = ['#050919', '#0E1538', '#1A1D4F', '#2A2160'];
const MORNING: Stops = ['#7DB9F0', '#AED6F7', '#E4F1FA', '#FFF0C2'];
const NOON: Stops = ['#A6D1F4', '#D6EBF8', '#FFF6D2', '#FFE69C'];
const SUNSET: Stops = ['#B8C9F2', '#E2D5F1', '#FFDCD2', '#FFE9BC'];

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const m = (s: number) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t);
  return `#${((m(16) << 16) | (m(8) << 8) | m(0)).toString(16).padStart(6, '0').toUpperCase()}`;
}

const mix = (a: Stops, b: Stops, t: number): Stops =>
  a.map((c, i) => mixHex(c, b[i], Math.max(0, Math.min(1, t)))) as Stops;

/** The sky for minute `now` (0–1439) of a day with these sun times. */
export function skyFor(now: number, sun: SunTimes): Sky {
  const dawnFrom = sun.sunrise - 30, dawnTo = sun.sunrise + 45;
  const noonFrom = sun.solarNoon - 30, noonFull = sun.solarNoon + 60;
  const sunsetFrom = sun.sunset - 120, sunsetFull = sun.sunset - 45;
  const duskFrom = sun.sunset + 10, nightAt = sun.sunset + 60;

  if (now < dawnFrom || now >= nightAt) return { phase: 'night', colors: NIGHT, dark: true };
  if (now < dawnTo) return withInk('dawn', mix(NIGHT, MORNING, (now - dawnFrom) / (dawnTo - dawnFrom)));
  if (now < noonFrom) return { phase: 'morning', colors: MORNING, dark: false };
  if (now < sunsetFrom) {
    return { phase: 'noon', colors: mix(MORNING, NOON, (now - noonFrom) / (noonFull - noonFrom)), dark: false };
  }
  if (now < duskFrom) {
    return { phase: 'sunset', colors: mix(NOON, SUNSET, (now - sunsetFrom) / (sunsetFull - sunsetFrom)), dark: false };
  }
  return withInk('dusk', mix(SUNSET, NIGHT, (now - duskFrom) / (nightAt - duskFrom)));
}

/** Ink for HEADER text on the top stop — the side that reads better, never a fixed switch time. */
export const INK = { light: '#F2F0FF', dark: '#141B2E' } as const;
function withInk(phase: SkyPhase, colors: Stops): Sky {
  return { phase, colors, dark: contrast(INK.light, colors[0]) > contrast(INK.dark, colors[0]) };
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const p = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((p >> 16) & 255) + 0.7152 * lin((p >> 8) & 255) + 0.0722 * lin(p & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend #RRGGBB a toward b; t = how much of a stays (0..1). */
function washMix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * t + ((pb >> s) & 255) * (1 - t));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/** The cream the secondary screens' dark text was designed on. */
export const WASH_BASE = '#FCF7EC';
/** How much of the sky survives in the wash — low enough that the app's dark inks pass 4.5:1 at midnight. */
export const WASH_KEEP = 0.15;

/**
 * The sky for screens whose text was drawn for cream (menu, review, agents, …):
 * the same hue as the hour, washed toward cream so their existing dark text
 * stays readable all day — one design, no per-screen ink switching.
 */
export function washedSky(sky: Sky): [string, string, string, string] {
  return sky.colors.map((c) => washMix(c, WASH_BASE, WASH_KEEP)) as [string, string, string, string];
}
