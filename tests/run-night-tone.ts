/**
 * run-night-tone — after dusk every screen draws on dark glass (canvas v4) and
 * its text stays readable: each night ink on each night surface, over the
 * lightest and darkest stop of the night sky, keeps ≥ 4.5:1.
 *
 * Koral, 28.10: "night mode looks really bad — both light and dark". The sky
 * went navy and the inks stayed dark brown.
 *
 * Run:  npx tsx tests/run-night-tone.ts
 */
import { contrast, skyFor, sunTimes } from '../src/utils/skyGradient';
import { NIGHT_COLORS as C } from '../src/constants/nightColors';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
/** An rgba(...) or #RRGGBB surface laid over an opaque #RRGGBB backdrop. */
function over(surface: string, backdrop: string): string {
  const b = parseInt(backdrop.slice(1), 16);
  const [br, bg, bb] = [(b >> 16) & 255, (b >> 8) & 255, b & 255];
  const m = surface.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
  if (!m) return surface;
  const [r, g, bl, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return `#${hex(r * a + br * (1 - a))}${hex(g * a + bg * (1 - a))}${hex(bl * a + bb * (1 - a))}`;
}

const sun = sunTimes(new Date(2026, 9, 28), 32.0853, 34.7818);
const night = skyFor(23 * 60, sun);
check('23:00 is night (the palette switches on)', night.dark && night.phase === 'night');
check('noon is not night (day keeps its cream)', !skyFor(12 * 60, sun).dark);

const surfaces: Array<[string, string]> = [['card', C.card], ['glass', C.glass], ['chip', C.chip], ['bar', C.bar], ['cardDim', C.cardDim], ['input', C.input]];
const inks: Array<[string, string]> = [['ink', C.ink], ['inkSoft', C.inkSoft], ['goldInk', C.goldInk], ['purpleInk', C.purpleInk]];
for (const [sn, s] of surfaces) {
  for (const [inkName, ink] of inks) {
    let worst = 99;
    for (const stop of night.colors) worst = Math.min(worst, contrast(ink, over(s, stop)));
    check(`${inkName} on ${sn}`, worst >= 4.5, `worst ${worst.toFixed(2)}:1`);
  }
}
// The bug itself: the day ink on the night sky — must be what we no longer draw.
check('the old day ink (#574326) on the night sky fails — the reason for this palette',
  night.colors.every((c) => contrast('#574326', c) < 3));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
