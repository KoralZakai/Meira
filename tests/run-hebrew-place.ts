/**
 * Separate WHAT KIND of place from WHICH place — and refuse to guess.
 *
 * Two bugs are pinned here, both from 2026-08-31:
 *
 *   1. "אימון ב8 ביגאל אלון 94" produced a task with NO location, because the
 *      fallback's matcher was English-only.
 *   2. The first fix for (1) then returned the WHOLE SENTENCE as the address —
 *      "חדר כושר ב 8 בערב ביגאל אלון 94" — because it took everything after
 *      the first ב-word. That is worse than extracting nothing: an empty
 *      address asks, a nonsense address routes her somewhere real and wrong.
 */
import { extractHebrewPlace, extractHebrewPlaceParts } from '../src/utils/hebrewPlace';

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}` + (ok ? `  — ${JSON.stringify(got)}` : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('\n1. The sentence that broke it — a venue type AND an address');
eq('אימון בחדר כושר ב 8 בערב ביגאל אלון 94',
   extractHebrewPlaceParts('אימון בחדר כושר ב 8 בערב ביגאל אלון 94'),
   { place: 'יגאל אלון 94', activity: 'חדר כושר' });

console.log('\n2. A venue type with NO address — ask, never invent');
eq('אימון בחדר כושר ב 8 בערב',
   extractHebrewPlaceParts('אימון בחדר כושר ב 8 בערב'),
   { place: null, activity: 'חדר כושר' });
eq('פגישה במשרד', extractHebrewPlaceParts('פגישה במשרד'), { place: null, activity: 'משרד' });

console.log('\n3. An address with no venue type');
eq('אימון ב 8 בערב ביגאל אלון 94', extractHebrewPlace('אימון ב 8 בערב ביגאל אלון 94'), 'יגאל אלון 94');
eq('אימון ב8 ביגאל אלון 94', extractHebrewPlace('אימון ב8 ביגאל אלון 94'), 'יגאל אלון 94');

console.log('\n4. The address must stop before its own hour');
eq('address then clock', extractHebrewPlace('אימון ביגאל אלון 94 ב 20:00'), 'יגאל אלון 94');
eq('address then evening', extractHebrewPlace('אימון ביגאל אלון 94 ב 8 בערב'), 'יגאל אלון 94');

console.log('\n5. Time words are never places');
eq('בערב', extractHebrewPlace('אימון ב 8 בערב'), null);
eq('בבוקר', extractHebrewPlace('פגישה ב9 בבוקר'), null);
eq('בעוד שעתיים', extractHebrewPlace('תזכיר לי בעוד שעתיים'), null);
eq('ביום שני', extractHebrewPlace('פגישה ביום שני'), null);
eq('lone ב + digit', extractHebrewPlace('אימון ב 8'), null);

console.log('\n6. Explicit address leads');
eq('ברחוב', extractHebrewPlace('פגישה ברחוב דיזנגוף 50'), 'דיזנגוף 50');
eq('בשדרות', extractHebrewPlace('כנס בשדרות רוטשילד 12'), 'רוטשילד 12');

console.log('\n7. Refuse to guess rather than return a sentence');
eq('a verb phrase is not an address', extractHebrewPlace('צריך לדבר עם יניר בקשר לפרויקט'), null);
eq('no place at all', extractHebrewPlace('לקנות חלב'), null);
eq('empty', extractHebrewPlace(''), null);
eq('english only', extractHebrewPlace('gym at 8'), null);

console.log('\n8. Short proper names still work');
eq('ספייס גים', extractHebrewPlace("אימון בספייס ג'ים"), "ספייס ג'ים");

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
