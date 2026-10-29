/**
 * run-title-address — the venue was typed into the event's TITLE (18.10, Koral):
 * "סרט ברציף רחוב הגליל 6 תל אביב" had no place, so no route and nothing said why.
 * Only a street named with its own word and a house number counts; a place merely
 * mentioned in a title is still no address (silent-state rule 8: do not guess).
 *
 * Run:  npx tsx tests/run-title-address.ts
 */
import { addressFromTitle } from '../src/utils/eventAddress';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const a = addressFromTitle('סרט ברציף רחוב הגליל 6 תל אביב');
check('the real title gives street, number and city', a === 'הגליל 6, תל אביב', String(a));
check('"ברחוב" works too', addressFromTitle('ארוחה ברחוב הרצל 12 חיפה') === 'הרצל 12, חיפה');
check('no city in the title: street and number only', addressFromTitle('פגישה ברחוב ויצמן 5') === 'ויצמן 5');
check('a word after the number that is no city is not part of the address',
  addressFromTitle('פגישה ברח׳ ויצמן 5 בשעה שבע') === 'ויצמן 5');
check('English street', addressFromTitle('Dinner at 6 HaGalil Street, Tel Aviv') === '6 HaGalil Street, Tel Aviv');
check('a place named without a street is no address', addressFromTitle('סרט ברציף') === undefined);
check('a street without a number is no address', addressFromTitle('פגישה ברחוב הרצל') === undefined);
check('an hour is not a house number', addressFromTitle('אימון בשעה 6') === undefined);
check('empty and missing are nothing', addressFromTitle('') === undefined && addressFromTitle(undefined) === undefined);

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
