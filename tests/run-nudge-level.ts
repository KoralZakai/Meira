/**
 * run-nudge-level — the three levels, both languages, and the server's names (19.10).
 * Run:  npx tsx tests/run-nudge-level.ts
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_NUDGE_LEVEL, NUDGE_LEVELS, levelAtX, nudgeCard, nudgeLevelOf, stepLevel, stopRatio } from '../src/utils/nudgeLevel';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

check('default is gentle', DEFAULT_NUDGE_LEVEL === 'gentle' && nudgeLevelOf({}) === 'gentle' && nudgeLevelOf(null) === 'gentle');
check('a stored level is kept', nudgeLevelOf({ nudgeLevel: 'alarm' }) === 'alarm' && nudgeLevelOf({ nudgeLevel: 'motivating' }) === 'motivating');
check('junk falls back to gentle', nudgeLevelOf({ nudgeLevel: 'loud' }) === 'gentle' && nudgeLevelOf({ nudgeLevel: 3 }) === 'gentle');
for (const lv of NUDGE_LEVELS) {
  const en = nudgeCard(lv, 'en'); const he = nudgeCard(lv, 'he');
  check(`${lv}: both languages have a title and a sample`, !!(en.title && en.sample && he.title && he.sample));
  check(`${lv}: the Hebrew is Hebrew`, /[\u0590-\u05FF]/.test(he.title) && /[\u0590-\u05FF]/.test(he.sample));
}
// ── the slider ──
check('a touch snaps to the nearest of three stops', levelAtX(0, 300) === 'alarm' && levelAtX(140, 300) === 'gentle' && levelAtX(160, 300) === 'gentle' && levelAtX(300, 300) === 'motivating');
check('a touch outside the track clamps to the ends', levelAtX(-50, 300) === 'alarm' && levelAtX(999, 300) === 'motivating');
check('a track with no width falls back to the default', levelAtX(10, 0) === 'gentle');
check('stops sit at 0, 0.5, 1', stopRatio('alarm') === 0 && stopRatio('gentle') === 0.5 && stopRatio('motivating') === 1);
check('screen-reader steps stop at the ends', stepLevel('gentle', 1) === 'motivating' && stepLevel('motivating', 1) === 'motivating' && stepLevel('alarm', -1) === 'alarm' && stepLevel('gentle', -1) === 'alarm');
for (const lv of NUDGE_LEVELS) {
  const en = nudgeCard(lv, 'en').how; const he = nudgeCard(lv, 'he').how;
  const n = NUDGE_LEVELS.indexOf(lv) + 1;
  check(`${lv}: the interpretation names the level (${n} of 3) in both languages`, en.includes(`Level ${n} of 3`) && he.includes(`רמה ${n} מתוך 3`));
}
check('the Profile uses the slider, not cards', readFileSync('src/screens/ProfileEditScreen.tsx', 'utf8').includes('<NudgeSlider'));
// The server accepts exactly these three (agent_turn._APP_PROFILE_FIELDS) and reminders speak them (reschedule.py).
const server = readFileSync('server/agent_turn.py', 'utf8');
check('the server accepts the same three names',
  NUDGE_LEVELS.every((l) => new RegExp(`"nudgeLevel":[^\\n]*"${l}"`).test(server)));
check('the app sends the level to the brain', readFileSync('src/services/LumiBrain.ts', 'utf8').includes('nudgeLevel'));

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
