/**
 * run-sky-wash — the washed sky behind cream-designed screens keeps their dark text readable every minute.
 *
 * Run:  npx tsx tests/run-sky-wash.ts
 */
import { contrast, skyFor, sunTimes, washedSky, WASH_BASE } from '../src/utils/skyGradient';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const INK_SOFT = '#645843';   // BRAND.inkSoft — the faintest text these screens draw on the background
const sun = sunTimes(new Date(2026, 9, 28), 32.0853, 34.7818);
let worst = 99;
let worstAt = 0;
for (let m = 0; m < 1440; m += 5) {
  for (const c of washedSky(skyFor(m, sun))) {
    const r = contrast(INK_SOFT, c);
    if (r < worst) { worst = r; worstAt = m; }
  }
}
check('inkSoft ≥ 4.5:1 on every washed stop, all day', worst >= 4.5, `worst ${worst.toFixed(2)} at ${Math.floor(worstAt / 60)}:${String(worstAt % 60).padStart(2, '0')}`);
const noon = washedSky(skyFor(12 * 60, sun));
const night = washedSky(skyFor(23 * 60, sun));
check('the wash still follows the hour (noon ≠ night)', noon[0] !== night[0], `${noon[0]} vs ${night[0]}`);
check('…and is not just cream', noon[0] !== WASH_BASE && night[0] !== WASH_BASE);
check('always four #RRGGBB stops', night.length === 4 && night.every((c) => /^#[0-9a-f]{6}$/.test(c)));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
