/**
 * run-profile-shape — the stored profile must never reach the planner as
 * `undefined`.
 *
 * The app carries two UserProfile shapes: models/UserProfile (what
 * UserProfileStorage actually persists) and types/UserProfile (what the
 * planner, the travel chain and the LLM prompt read). Every field name differs,
 * and every call site cast to `any`, so the mismatch was invisible to both the
 * compiler and the reader. LLMService.getSystemPrompt rendered four of its six
 * profile lines as the literal string "undefined" — the agent was planning
 * days for a user with no transport, no routine and no wake time.
 *
 * These assertions are the regression guard. A `.transportType` that comes back
 * undefined here is the exact production bug.
 *
 * Run:  npx tsx tests/run-profile-shape.ts
 */
import { normalizeProfile } from '../src/utils/profileShape';
import { blankProfile } from '../src/models/UserProfile';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Exactly what loadProfile() returns for a user who finished onboarding.
const STORED = {
  name: 'Koral',
  homeAddress: "Mordei ha-Geta'ot St 25, Tel Aviv-Yafo",
  homeLatLng: { lat: 32.0564079, lng: 34.7874931 },
  transportMode: 'transit' as const,
  morningHabits: [{ habit: 'coffee', estimatedMinutes: 15 }],
  totalMorningRoutineMinutes: 40,
  workStartTime: '09:00',
  sleepTime: '23:30',
  onboardingComplete: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-08-01T00:00:00.000Z',
};

function main() {
  console.log('\nProfile shape\n');

  console.log('1. Every field the planner reads is defined');
  const p = normalizeProfile(STORED)!;
  for (const field of [
    'transportType', 'morningRoutineMinutes', 'wakeBufferMinutes',
    'homeAddress', 'homeLat', 'homeLng', 'defaultWakeTime', 'sleepTime',
  ] as const) {
    check(`${field} is not undefined`, (p as any)[field] !== undefined, String((p as any)[field]));
  }

  console.log('\n2. Values are translated, not just present');
  check("transportMode 'transit' becomes transportType 'bus'", p.transportType === 'bus', p.transportType);
  check('totalMorningRoutineMinutes carries over', p.morningRoutineMinutes === 40, String(p.morningRoutineMinutes));
  check('homeLatLng is split into homeLat/homeLng',
    p.homeLat === 32.0564079 && p.homeLng === 34.7874931, `${p.homeLat}, ${p.homeLng}`);
  // Nothing has ever written defaultWakeTime, so it must be derived — backwards
  // from the first commitment, the way the rest of the app reasons about time.
  check('wake time is work start minus the morning routine (09:00 − 40m)',
    p.defaultWakeTime === '08:20', p.defaultWakeTime);

  console.log('\n3. Each transport mode maps to a routable type');
  for (const [mode, expected] of [
    ['car', 'car'], ['foot', 'walk'], ['bicycle', 'bike'], ['transit', 'bus'],
  ] as const) {
    const got = normalizeProfile({ ...STORED, transportMode: mode })!.transportType;
    check(`${mode} → ${expected}`, got === expected, got);
  }

  console.log('\n4. Missing pieces fall back instead of poisoning the plan');
  const bare = normalizeProfile(blankProfile())!;
  check('a blank profile still yields a transport type', !!bare.transportType, bare.transportType);
  check('a blank profile still yields a wake time', /^\d{2}:\d{2}$/.test(bare.defaultWakeTime), bare.defaultWakeTime);
  const noWork = normalizeProfile({ ...STORED, workStartTime: '' })!;
  check('no work start → a sane default, never undefined', noWork.defaultWakeTime === '07:00', noWork.defaultWakeTime);
  const noRoutine = normalizeProfile({ ...STORED, totalMorningRoutineMinutes: undefined })!;
  check('no routine length → the documented 45 min', noRoutine.morningRoutineMinutes === 45, String(noRoutine.morningRoutineMinutes));
  check('null profile stays null', normalizeProfile(null) === null);

  console.log('\n5. Normalizing twice changes nothing');
  // Some screens hold an already-normalized profile in state and re-save it.
  const twice = normalizeProfile(normalizeProfile(STORED))!;
  check('transportType survives a second pass', twice.transportType === 'bus', twice.transportType);
  check('wake time survives a second pass', twice.defaultWakeTime === '08:20', twice.defaultWakeTime);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
