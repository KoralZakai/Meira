/**
 * run-gmail-off — the store build reads no Gmail, and every surface says so.
 *
 * 19.10, before Google Play (Koral: "כן, להוציא"): gmail.readonly is a restricted
 * scope (paid CASA review, 100-user cap). Two ways this could quietly go wrong:
 * the scope survives in the sign-in request (Play / Google review sees it), or a
 * surface keeps drawing "0 found in your email" over a mailbox nobody read
 * (silent-state rule 1). GoogleService needs expo, so its wiring is checked on
 * the source, the way run-focus-session checks the Kotlin.
 *
 * Run:  npx tsx tests/run-gmail-off.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GMAIL_ENABLED, GMAIL_SCOPE, gmailOffLine, gmailOffShort, googleScopes } from '../src/utils/gmailAccess';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\n1. Sign-in asks for Calendar only\n');
check('Gmail is off in this build', GMAIL_ENABLED === false);
check('the requested scopes carry no gmail scope', !googleScopes().some((s) => /gmail/.test(s)), googleScopes().join(' '));
check('...and still carry Calendar read + events', googleScopes().includes('https://www.googleapis.com/auth/calendar.readonly')
  && googleScopes().includes('https://www.googleapis.com/auth/calendar.events'));
check('turning it back on is the one switch', googleScopes(true)[0] === GMAIL_SCOPE);
const gs = read('src/services/GoogleService.ts');
check('GoogleService takes its scopes from gmailAccess', /const GOOGLE_SCOPES = googleScopes\(\);/.test(gs));
check('no other gmail scope string in src/', !/auth\/gmail/.test(gs) && !/auth\/gmail/.test(read('src/services/GoogleSync.ts')));

console.log('\n2. Every Gmail reader stops before the network\n');
for (const fn of ['searchGmailForTask', 'gmailHistoryWith', 'scanGmailForEvents']) {
  const at = gs.indexOf(`async ${fn}(`);
  const body = gs.slice(at, gs.indexOf('getToken', at));
  check(`${fn} returns on !GMAIL_ENABLED before asking for a token`, at > 0 && /if \(!GMAIL_ENABLED\) return/.test(body));
}
check('getGmailEventSuggestions returns before any scan or cache write',
  /getGmailEventSuggestions[\s\S]{0,400}if \(!GMAIL_ENABLED\) return \[\];[\s\S]{0,40}try \{/.test(read('src/services/GoogleSync.ts')));

console.log('\n3. Every surface says Gmail is off (rule 1)\n');
check('the off line, both languages', /Gmail is off/.test(gmailOffLine(false)) && /Gmail כבויה/.test(gmailOffLine(true)));
check('the per-account label, both languages', /off/.test(gmailOffShort(false)) && /כבוי/.test(gmailOffShort(true)));
check('Menu › Update calendars passes null (off), not a 0 count',
  /calendarUpdateLine\(r, GMAIL_ENABLED \? found\.length : null, he\)/.test(read('src/screens/SettingsMenu.tsx')));
check('Plan tomorrow says it is off where the email section was',
  /!GMAIL_ENABLED \? \([\s\S]{0,160}gmailOffLine/.test(read('src/screens/PlanTomorrow.tsx')));
const cc = read('src/components/CalendarConnections.tsx');
check('Calendars: no mail switch that reads nothing — a "Mail: off" label instead',
  /GMAIL_ENABLED \? \([\s\S]{0,300}<Switch value=\{a\.mail\}[\s\S]{0,600}gmailOffShort\(he\)/.test(cc));
check('Calendars: the Add-account dialog no longer promises Gmail', /Gmail is not read in this version/.test(cc) && /Gmail לא נקרא בגרסה הזו/.test(cc));

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
