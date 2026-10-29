/**
 * run-chain-answer — the bike/car-elsewhere plans the chat draws as a map
 * (Koral 19.10, mockup pick B). Run: npx tsx tests/run-chain-answer.ts
 */
import { asChainAnswer, chipTitle, stepLine, framePoints, ChainOption } from '../src/utils/chainAnswer';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const after: ChainOption = {
  kind: 'fetch_after', leave_at: '17:28', extra_min: 12, event: 'באות',
  steps: [
    { mode: 'bus', minutes: 20, to: 'event', line: '50', board_at: '17:38',
      from_pt: { lat: 32.07, lng: 34.78 }, to_pt: { lat: 32.083, lng: 34.795 }, polyline: 'abc' },
    { mode: 'bus', minutes: 19, to: 'vehicle', line: '40', after: true,
      from_pt: { lat: 32.083, lng: 34.795 }, to_pt: { lat: 32.056, lng: 34.768 } },
    { mode: 'bike', minutes: 13, to: 'home', after: true, to_pt: { lat: 0, lng: 0 } },
  ],
};

function main() {
  console.log('\nChain answers\n');

  console.log('1. Only a real chain is drawn');
  check('a pickup plan is accepted',
    asChainAnswer({ ok: true, kind: 'vehicle_pickup', options: [after] }) !== null);
  check('a route answer is not a chain', asChainAnswer({ ok: true, kind: 'route', results: [] }) === null);
  check('a failed plan is not drawn', asChainAnswer({ ok: false, kind: 'vehicle_pickup', options: [] }) === null);
  check('an option with no legs is not drawn',
    asChainAnswer({ ok: true, kind: 'vehicle_chain', options: [{ kind: 'leave_it', steps: [] }] }) === null);

  console.log('\n2. The words');
  check('the chip says which way and what it adds', chipTitle(after, 0, true) === '1 · אחרי באות · +12',
    chipTitle(after, 0, true));
  check('the bus number and its minute lead the leg',
    stepLine(after.steps[0], true, 'bike', 'באות') === '🚌 50 ב-17:38 ← באות (20 דק׳)',
    stepLine(after.steps[0], true, 'bike', 'באות'));
  check('a leg after the event says so', stepLine(after.steps[1], true).startsWith('אחרי: 🚌 40'));
  check('English too', stepLine(after.steps[2], false) === 'after: 🚴 → home (13 min)', stepLine(after.steps[2], false));

  console.log('\n3. The map frame');
  const pts = framePoints(after);
  check('0,0 is never framed (it is the Atlantic)', pts.every((p) => p.lat !== 0 || p.lng !== 0), `${pts.length} points`);
  check('every real end is framed', pts.length === 4);

  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures) process.exit(1);
}

main();
