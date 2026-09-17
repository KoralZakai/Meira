/**
 * run-known-places — "this is my gym address", said once.
 *
 * Koral, 2026-09-17: "i added 'יוגה ב 11 בבוקר ביגאל אלון 94' — i didn't write
 * tel aviv but Meira needs to know that, THIS IS MY GYM ADDRESS."
 *
 * server/known_places.py has done this since 2026-09-08 and its docstring
 * quotes her own brief: "enough for me to write once 'yoga class' in יגאל אלון
 * 94, next time 'yoga class on 11:00' automatically location known and bike".
 * It works. It just never ran for a task typed into the APP, because
 * addManualTask is entirely local — and `Task.activityKey`, the one field that
 * could have carried this, was written there and read nowhere.
 *
 * So src/utils/knownPlaces.ts is a PORT, and the first half of this file is a
 * parity check against the Python's own answers (tests/fixtures/
 * known-places-parity.json, generated from known_places.py itself). Two
 * implementations of one rule are only safe while they agree, and "I ported it
 * carefully" is not evidence that they do.
 *
 * Regenerate the fixture:
 *   see the generator in the run-known-places section of the session that
 *   added it — it calls concept_of / activity_key / _tokens directly.
 *
 * Run:  npx tsx tests/run-known-places.ts
 */
import {
  conceptOf, activityKeyOf, tokensOf, rememberPlace, resolvePlace, KnownPlaces,
} from '../src/utils/knownPlaces';
import fixture from './fixtures/known-places-parity.json';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

function main() {
  console.log('\nKnown places — learned once, reused forever\n');

  console.log('1. Parity with server/known_places.py');
  let mismatches = 0;
  for (const row of fixture.phrases) {
    const concept = conceptOf(row.text);
    const key = activityKeyOf(row.text);
    const toks = [...tokensOf(row.text)].sort();
    const same = concept === row.concept
      && key === row.key
      && JSON.stringify(toks) === JSON.stringify(row.tokens);
    if (!same) {
      mismatches += 1;
      console.log(`    ✗ "${row.text}"`);
      console.log(`       python: concept=${row.concept} key=${row.key} tokens=${JSON.stringify(row.tokens)}`);
      console.log(`       ts    : concept=${concept} key=${key} tokens=${JSON.stringify(toks)}`);
    }
  }
  check(`all ${fixture.phrases.length} phrases agree with the Python`, mismatches === 0,
    mismatches ? `${mismatches} disagree` : 'the two implementations are one rule');

  console.log('\n2. Her sentence, and the bare one that should find it');
  check('"יוגה ביגאל אלון 94" is fitness', conceptOf('יוגה ב 11 בבוקר ביגאל אלון 94') === 'fitness');
  check('...and bare "יוגה" gets the SAME key',
    activityKeyOf('יוגה') === activityKeyOf('יוגה ב 11 בבוקר ביגאל אלון 94'),
    'which is what lets the second one find the first');

  console.log('\n3. Learning it once');
  let places: KnownPlaces = {};
  places = rememberPlace(places, 'יוגה ב 11 בבוקר ביגאל אלון 94',
    'יגאל אלון 94, תל אביב-יפו', { lat: 32.0713, lng: 34.7942 });
  const found = resolvePlace(places, 'יוגה ב-11')!;
  check('next time "יוגה ב-11" already knows where', Boolean(found), found ? found.address : 'null — would ask again');
  check('...at her gym', found.address === 'יגאל אלון 94, תל אביב-יפו', found.address);
  check('...with coordinates, so the map has a pin', found.lat === 32.0713);
  check('...matched by concept, not by luck', found.via === 'concept');

  console.log('\n4. It crosses languages — that is the point of a concept');
  check('"gym" finds what "יוגה" saved', resolvePlace(places, 'gym at 8')?.address
    === 'יגאל אלון 94, תל אביב-יפו');
  check('"workout" too', Boolean(resolvePlace(places, 'workout')));
  check('"אימון בחדר כושר" too', Boolean(resolvePlace(places, 'אימון בחדר כושר')));

  console.log('\n5. What it must NOT claim to know');
  check('an unrelated activity resolves to nothing',
    resolvePlace(places, 'תור לרופא שיניים') === null,
    'a confident wrong address is worse than a question');
  check('a dentist is not a gym', conceptOf('תור לרופא שיניים') === 'doctor');
  check('an empty store knows nothing', resolvePlace({}, 'יוגה') === null);
  check('...and so does no store at all', resolvePlace(null, 'יוגה') === null);

  console.log('\n6. "שיעור" is a container, not an activity');
  check('"שיעור יוגה" is fitness, NOT class',
    conceptOf('שיעור יוגה') === 'fitness',
    'otherwise yoga lands wherever the last unrelated course was');
  check('a bare "שיעור אנגלית" IS class', conceptOf('שיעור אנגלית') === 'class');
  check('...so English lessons do not resolve to the gym',
    resolvePlace(places, 'שיעור אנגלית') === null);

  console.log('\n7. She moved gyms');
  places = rememberPlace(places, 'יוגה', 'דיזנגוף 50, תל אביב', { lat: 32.08, lng: 34.77 });
  check('the newer address wins', resolvePlace(places, 'יוגה')?.address === 'דיזנגוף 50, תל אביב');
  check('...and confidence in the ACTIVITY still rose',
    places[activityKeyOf('יוגה')].count === 2,
    'it is the activity we are sure about, not the string');

  console.log('\n8. An activity the table has no concept for');
  let other: KnownPlaces = {};
  other = rememberPlace(other, 'חוג קרמיקה של נועה', 'שנקין 12, תל אביב');
  check('it is remembered by her own words',
    Boolean(resolvePlace(other, 'קרמיקה של נועה')), 'word overlap is the fallback');
  check('...and a different hobby does not collide with it',
    resolvePlace(other, 'שיעור גיטרה') === null);

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
