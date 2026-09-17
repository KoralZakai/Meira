/**
 * run-address-completion — "יגאל אלון 94" is an address, just not a complete one.
 *
 * Koral, 2026-09-17, adding a class for tomorrow:
 *
 *   "i added to tomorrow a task 'יוגה ב 11 בבוקר ביגאל אלון 94' — i didn't
 *    write tel aviv but Meira needs to know that, this is my gym address."
 *
 * The parser was never the problem: extractHebrewPlaceParts returns exactly
 * "יגאל אלון 94", and timeParser returns 11:00. What broke was the next step.
 * geocodeTaskLocation called expo-location's PLATFORM geocoder — no country,
 * no region, no idea where she lives — while claiming in its own comment to
 * use Google Geocoding.
 *
 * A street with no city is not ambiguous to someone who lives in one city. It
 * is ambiguous to a geocoder nobody told, and the failure mode is not an error
 * — it is a confident route to a street of the same name in another town, with
 * a leave time and an alarm built on top of it.
 *
 * THIS IS NOT HYPOTHETICAL. Asked on the live server, with the real Maps key,
 * on 2026-09-17:
 *
 *     'יגאל אלון 94 תל אביב'  ->  Yigal Alon St 94, Tel Aviv-Yafo
 *     'יגאל אלון 94'          ->  יגאל אלון 94, DIMONA
 *
 * Dimona is 90 km south of her gym. Google answered confidently both times.
 * That is what a missing city costs: not an error she would notice, but a
 * route, a leave time and a wake alarm, all correct for the wrong town.
 *
 * Appending a WRONG city is worse than appending none, so every rule here is
 * conservative, and most of these checks are about what must be left alone.
 *
 * Run:  npx tsx tests/run-address-completion.ts
 */
import { completeAddress, needsCity, namesACity, cityOf } from '../src/utils/addressCompletion';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const HOME = 'הרצל 20, תל אביב-יפו, ישראל';

function main() {
  console.log('\nCompleting an address she did not finish typing\n');

  console.log('1. Her actual sentence');
  check('a bare street with a number needs a city', needsCity('יגאל אלון 94'));
  check('...and gets hers', completeAddress('יגאל אלון 94', HOME) === 'יגאל אלון 94, תל אביב-יפו',
    completeAddress('יגאל אלון 94', HOME));

  // The live result above, as a check: completing it is what puts the class in
  // the right city, and the bare form is what Google sends to Dimona.
  check('the completed form is what reaches Google, not the bare one',
    completeAddress('יגאל אלון 94', HOME).includes('תל אביב'),
    'bare → Dimona, verified against the live Maps key');

  console.log('\n2. Finding the city in a home address');
  check('a Google-formatted home gives its city', cityOf(HOME) === 'תל אביב-יפו', String(cityOf(HOME)));
  check('a typed home gives it too', cityOf('הרצל 20, רעננה') === 'רעננה');
  check('a leading house number is skipped, not mistaken for the city',
    cityOf('11א, Kaufmann Street, Tel Aviv') === 'Kaufmann Street',
    'the segment after a bare number is the street; the city is further along');
  check('a home with no comma still yields an inline city',
    cityOf('הרצל 20 תל אביב') === 'תל אביב');
  check('a home with nothing to lend says so', cityOf('הרצל 20') === null);
  check('...and no home at all', cityOf(undefined) === null && cityOf('') === null);

  console.log('\n3. What must be left ALONE — appending a wrong city is worse');
  check('an address that already has segments is untouched',
    completeAddress('יגאל אלון 94, חיפה', HOME) === 'יגאל אלון 94, חיפה',
    'she said Haifa and she meant Haifa');
  check('an inline city is respected too',
    completeAddress('יגאל אלון 94 חיפה', HOME) === 'יגאל אלון 94 חיפה');
  check('a full Google address is untouched',
    completeAddress('11א, Kaufmann Street, Tel Aviv, Israel', HOME)
      === '11א, Kaufmann Street, Tel Aviv, Israel');
  check('prose is not an address to complete',
    completeAddress('somewhere near the big park by the sea', HOME)
      === 'somewhere near the big park by the sea');
  check('nothing in, nothing out', completeAddress('', HOME) === '' && completeAddress(null, HOME) === '');

  console.log('\n4. No home city means NO GUESS');
  check('it does not assume Tel Aviv because most people live there',
    completeAddress('יגאל אלון 94', 'הרצל 20') === 'יגאל אלון 94',
    'guessing a city is how a task lands 60 km from where she meant');
  check('...nor with no home at all',
    completeAddress('יגאל אלון 94', undefined) === 'יגאל אלון 94');

  console.log('\n5. Recognising a city by name');
  check('Hebrew', namesACity('משהו בתל אביב') && namesACity('רחוב כלשהו, ירושלים'));
  check('English', namesACity('Some street, Tel Aviv'));
  check('a hyphenated form', namesACity('תל-אביב'));
  check('a street name is not a city', !namesACity('יגאל אלון 94'));

  console.log('\n6. A place NAME with no street still gets placed near her');
  check('a short venue name is completed',
    completeAddress('צ׳ארלס קלור', HOME) === 'צ׳ארלס קלור, תל אביב-יפו',
    'a park name is as ambiguous to a geocoder as a street name');
  check('Space Gym too', completeAddress('Space Gym', HOME) === 'Space Gym, תל אביב-יפו');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
