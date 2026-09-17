/**
 * run-travel-preference — she cycles to yoga and does not cycle to Herzliya.
 *
 * Koral, 2026-09-17: "start learning about the user's preferences, like
 * habits, ways of transportation, usual things he does."
 *
 * Until now the app had exactly one answer about transport:
 * `profile.transportType`, chosen once in onboarding, used for every route
 * forever. That is not wrong in an exotic case — it is wrong in the ordinary
 * one, every week, and a wrong mode is a wrong travel time, which is a wrong
 * leave time, which is a wrong alarm.
 *
 * The server has had this rule since 2026-09-08 (server/travel_prefs.py). This
 * is the same rule on the phone, key normalisation included, so the two stores
 * cannot drift into disagreeing about how she travels.
 *
 * Run:  npx tsx tests/run-travel-preference.ts
 */
import {
  placeKeyFor, rememberMode, preferredMode, describeAssumption,
  EMPTY_PREFERENCES, TravelPreferences,
} from '../src/utils/travelPreference';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

function main() {
  console.log('\nLearning how she actually travels\n');

  console.log('1. One address, however it is spelled');
  const KEY = placeKeyFor('יגאל אלון 94');
  check('a typed street and a Google address share a key',
    placeKeyFor('יגאל אלון 94, תל אביב-יפו, מחוז תל אביב, ישראל') === KEY);
  check('...and so does the bare street', placeKeyFor('  יגאל אלון 94  ') === KEY);
  check('the house number is KEPT — two gyms on one street are two places',
    placeKeyFor('יגאל אלון 94') !== placeKeyFor('יגאל אלון 12'));
  check('a leading house number pulls in its street, so "11א" is not a key',
    placeKeyFor('11א, Kaufmann Street, Tel Aviv') === '11א kaufmann street');
  check('...and two different streets at number 11א stay distinct',
    placeKeyFor('11א, Kaufmann Street, Tel Aviv') !== placeKeyFor('11א, Florentin Street, Tel Aviv'));
  check('nothing is not a place', placeKeyFor('') === '' && placeKeyFor(null) === '');

  console.log('\n2. Nothing learned yet — say so, do not pretend');
  const none = preferredMode(EMPTY_PREFERENCES, { place: 'somewhere', category: 'gym' }, 'bus');
  check('the profile mode is used', none.mode === 'bus');
  check('...and it is labelled as a default, not as a memory', none.from === 'default');
  check('so nothing claims "like last time"',
    describeAssumption(none, 'he') === undefined,
    'a false "like last time" makes every real one less trustworthy');

  console.log('\n3. She cycles to the yoga class');
  let prefs: TravelPreferences = EMPTY_PREFERENCES;
  prefs = rememberMode(prefs, { mode: 'bike', place: '11א, Kaufmann Street, Tel Aviv', category: 'hobby_class' });
  const yoga = preferredMode(prefs, { place: '11א, Kaufmann Street, Tel Aviv', category: 'hobby_class' }, 'bus');
  check('the next route to Charles Clore is planned by bike, not by bus',
    yoga.mode === 'bike', yoga.mode);
  check('...because of the PLACE', yoga.from === 'place');
  check('and Lumi says so out loud',
    describeAssumption(yoga, 'he')!.includes('כמו בפעם הקודמת'),
    describeAssumption(yoga, 'he'));
  check('...in English too', describeAssumption(yoga, 'en')!.includes('like last time here'));

  console.log('\n4. It carries to a class she has never been to');
  const newStudio = preferredMode(prefs, { place: 'somewhere new entirely', category: 'hobby_class' }, 'bus');
  check('a different studio still gets the bike', newStudio.mode === 'bike');
  check('...and it is honest that this is the weaker guess', newStudio.from === 'category');
  check('the wording is weaker too',
    describeAssumption(newStudio, 'he')!.includes('בדרך כלל'));

  console.log('\n5. ...and NOT to an interview in Herzliya');
  check('a category she has never cycled to falls back to the profile',
    preferredMode(prefs, { place: 'Herzliya', category: 'interview' }, 'train').mode === 'train',
    'this is the case a single global mode always got wrong');

  console.log('\n6. The place beats the category');
  prefs = rememberMode(prefs, { mode: 'bus', category: 'hobby_class' });
  prefs = rememberMode(prefs, { mode: 'bus', category: 'hobby_class' });
  prefs = rememberMode(prefs, { mode: 'bus', category: 'hobby_class' });
  const stillBike = preferredMode(prefs, { place: '11א, Kaufmann Street, Tel Aviv', category: 'hobby_class' }, 'bus');
  check('three buses to classes in general do not outvote the bike to THIS one',
    stillBike.mode === 'bike', stillBike.mode);
  check('...while a new class now assumes the bus',
    preferredMode(prefs, { category: 'hobby_class' }, 'walk').mode === 'bus');

  console.log('\n7. A correction outvotes an old habit over time');
  let corrected = prefs;
  for (let i = 0; i < 3; i += 1) {
    corrected = rememberMode(corrected, { mode: 'walk', place: '11א, Kaufmann Street, Tel Aviv' });
  }
  check('three walks beat one bike', preferredMode(corrected,
    { place: '11א, Kaufmann Street, Tel Aviv' }, 'bus').mode === 'walk');
  check('and it counts how sure it is', preferredMode(corrected,
    { place: '11א, Kaufmann Street, Tel Aviv' }, 'bus').timesSeen === 3);

  console.log('\n8. Things it must refuse to learn');
  const junk = rememberMode(EMPTY_PREFERENCES, { mode: 'teleport' as any, place: 'x', category: 'gym' });
  check('an invalid mode is not recorded', Object.keys(junk.places).length === 0);
  check('...and the store is not corrupted either', Object.keys(junk.categories).length === 0);
  const noPlace = rememberMode(EMPTY_PREFERENCES, { mode: 'bike', category: 'gym' });
  check('a choice with no place still teaches the category',
    preferredMode(noPlace, { category: 'gym' }, 'bus').mode === 'bike');
  check('...and adds no empty place key', Object.keys(noPlace.places).length === 0);

  console.log('\n9. The store is never mutated in place');
  const before = JSON.stringify(EMPTY_PREFERENCES);
  rememberMode(EMPTY_PREFERENCES, { mode: 'car', place: 'anywhere', category: 'work' });
  check('the constant is still empty', JSON.stringify(EMPTY_PREFERENCES) === before,
    'a shared mutable default is how one task teaches another');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
