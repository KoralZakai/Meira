/**
 * run-place-mode — the question she has already answered.
 * Run: npx tsx tests/run-place-mode.ts
 */
import { placeKey, winnerOf, MIN_TRIPS } from '../src/utils/placeMode';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

function main() {
  console.log('\nPlace habits\n');

  console.log('1. One town, however it is written');
  check('the Hebrew ב prefix is not part of the name', placeKey('בנהריה') === placeKey('נהריה'));
  check('case and punctuation do not matter',
    placeKey('Tel Aviv University,') === placeKey('tel aviv university'));
  check('whitespace is normalised', placeKey('  נהריה   ') === 'נהריה');

  console.log('\n2. A habit needs more than one trip');
  check('one journey is not a habit', winnerOf({ train: 1 }) === null, `${MIN_TRIPS} needed`);
  check('two of the same is', winnerOf({ train: 2 }) === 'train');
  check('a clear majority wins', winnerOf({ train: 5, car: 1 }) === 'train');
  check('a tie is not a habit', winnerOf({ train: 2, car: 2 }) === null);
  check('nothing recorded, nothing claimed', winnerOf(undefined) === null);
  check('zero counts are ignored', winnerOf({ train: 0 }) === null);

  console.log('\n3. …and one outlier does not overturn it');
  check('a single drive does not make Nahariya a driving town',
    winnerOf({ train: 6, car: 1 }) === 'train');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
