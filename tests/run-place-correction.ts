/**
 * Spoken-form place corrections must not corrupt real addresses.
 *
 * Pins the bug found on 2026-08-31 in a stored task: Google returned
 * "94, Yigal Alon Street, Tel Aviv-Yafo" and the correction map rewrote it to
 * "94, Yיגאל אלון Street" — because "igal alon" matched inside "Yigal Alon".
 */
import { correctPlaceName } from '../src/utils/fuzzyMatch';

let pass = 0, fail = 0;
const eq = (label: string, got: string, want: string) => {
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} ${label}` + (ok ? `  — ${JSON.stringify(got)}` : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('\n1. The corruption that reached a real task');
eq('Google address survives', correctPlaceName('94, Yigal Alon Street, Tel Aviv-Yafo'), '94, Yigal Alon Street, Tel Aviv-Yafo');
eq('inside a longer word', correctPlaceName('Yigal Alon'), 'Yigal Alon');

console.log('\n2. Real corrections still apply');
eq('standalone', correctPlaceName('igal alon'), 'יגאל אלון');
eq('with punctuation', correctPlaceName('meet at igal alon, 94'), 'meet at יגאל אלון, 94');
eq('case-insensitive', correctPlaceName('IGAL ALON'), 'יגאל אלון');
eq('hebrew variant', correctPlaceName('איגל אלון'), 'יגאל אלון');
eq('space gym', correctPlaceName('space gym'), 'Space Gym');
eq('biniamina', correctPlaceName('biniamina'), 'בנימינה');

console.log('\n3. Untouched text');
eq('unrelated', correctPlaceName('Dizengoff Center'), 'Dizengoff Center');
eq('empty', correctPlaceName(''), '');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
