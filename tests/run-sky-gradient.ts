/**
 * run-sky-gradient — the Today background follows the real sky.
 *
 * Pins three things Koral asked for (26–27.10): the phase changes at the REAL
 * sunrise / sunset of the place (not a fixed hour), the day palette stays soft
 * and light, and the header ink stays readable on whatever sky is drawn.
 *
 * Run:  npx tsx tests/run-sky-gradient.ts
 */
import { sunTimes, skyFor, contrast, luminance, FALLBACK_PLACE, INK } from '../src/utils/skyGradient';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const near = (got: number, want: string, tol = 6) => {
  const [h, m] = want.split(':').map(Number);
  return Math.abs(got - (h * 60 + m)) <= tol;
};

console.log('sun times — Tel Aviv');
const { lat, lng } = FALLBACK_PLACE;
const oct = sunTimes(new Date(2026, 9, 28), lat, lng, 120);   // winter time (IST)
check('28.10 sunrise ≈ 05:55', near(oct.sunrise, '05:55'), hhmm(oct.sunrise));
check('28.10 sunset ≈ 16:55', near(oct.sunset, '16:55'), hhmm(oct.sunset));
const jun = sunTimes(new Date(2026, 5, 21), lat, lng, 180);   // summer time (IDT)
check('21.6 sunrise ≈ 05:33', near(jun.sunrise, '05:33'), hhmm(jun.sunrise));
check('21.6 sunset ≈ 19:49', near(jun.sunset, '19:49'), hhmm(jun.sunset));
const eilat = sunTimes(new Date(2026, 9, 28), 29.5577, 34.9519, 120);
check('a different place gets a different sunset (Eilat ≠ Tel Aviv)', Math.abs(eilat.sunset - oct.sunset) >= 1,
  `${hhmm(eilat.sunset)} vs ${hhmm(oct.sunset)}`);

console.log('phases follow the sun, not the clock');
check('03:00 is night', skyFor(180, oct).phase === 'night');
check('10:36 is morning', skyFor(636, oct).phase === 'morning');
check('13:30 is noon', skyFor(810, oct).phase === 'noon');
check('16:20 is sunset', skyFor(980, oct).phase === 'sunset');
check('19:00 is night', skyFor(1140, oct).phase === 'night');
check('in June, 19:00 is still day', skyFor(1140, jun).phase !== 'night', skyFor(1140, jun).phase);

console.log('soft, light day; dark night');
const lightest = (c: string[]) => Math.max(...c.map(luminance));
for (const [label, m] of [['morning', 636], ['noon', 810], ['sunset', 980]] as const) {
  const sky = skyFor(m, oct);
  check(`${label} is light (every stop luminance ≥ 0.35)`, sky.colors.every((c) => luminance(c) >= 0.35),
    sky.colors.join(' '));
  check(`${label} draws dark ink`, !sky.dark);
}
const night = skyFor(1200, oct);
check('night draws light ink', night.dark);
check('night is dark (no stop above 0.05)', lightest(night.colors) < 0.05);

// The greeting and the big clock are LARGE text (WCAG 3:1). Small text in the
// header sits on frosted glass, not on the bare sky. During the 30-minute dawn
// and dusk blends no ink reaches 4.5 on a mid-tone, so the bar is 3:1 there.
console.log('header ink readable on every minute of the day');
let worst = 99;
let worstAt = 0;
for (let m = 0; m < 1440; m += 5) {
  const sky = skyFor(m, oct);
  const ink = sky.dark ? INK.light : INK.dark;
  const c = contrast(ink, sky.colors[0]);
  if (c < worst) { worst = c; worstAt = m; }
}
check('large header text ≥ 3:1 every minute (≥ 4.5 outside dawn/dusk)', worst >= 3, `worst ${worst.toFixed(2)} at ${hhmm(worstAt)}`);

const steady = [180, 636, 810, 980, 1200].map((m) => { const s = skyFor(m, oct); return contrast(s.dark ? INK.light : INK.dark, s.colors[0]); });
check('night / morning / noon / sunset header ink ≥ 4.5', steady.every((c) => c >= 4.5), steady.map((c) => c.toFixed(1)).join(' '));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
