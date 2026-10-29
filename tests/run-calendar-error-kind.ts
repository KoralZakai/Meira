/**
 * run-calendar-error-kind — "offline" is not "reconnect Google".
 *
 * The 30.9 card said "Tap to reconnect Google" over a DNS blip.
 * Run: npx tsx tests/run-calendar-error-kind.ts
 */
import { classifyCalendarError, calendarErrorLine } from '../src/utils/calendarErrorKind';

let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

const REAL_0930 = 'network: fetch failed: java.net.UnknownHostException: Unable to resolve host '
  + '"www.googleapis.com": No address associated with hostname';

console.log('\nCalendar errors, by their fix\n');
check('the 30.9 DNS blip is OFFLINE', classifyCalendarError(REAL_0930) === 'offline');
check('…and does not send her to reconnect Google',
  calendarErrorLine('offline', false).action === 'retry' && !/reconnect/i.test(calendarErrorLine('offline', false).text));
check('a dead token is SIGNED_OUT',
  classifyCalendarError('http_401: Request had invalid authentication credentials.') === 'signed_out');
check('a missing scope is SIGNED_OUT too — the fix is signing in again',
  classifyCalendarError('http_403: Request had insufficient authentication scopes.') === 'signed_out');
check('a disabled API is API_OFF, not "sign in"',
  classifyCalendarError('http_403: Google Calendar API has not been used in project 123 before or it is disabled.') === 'api_off');
check('Google saying later is BUSY', classifyCalendarError('http_503: Backend Error') === 'busy');
check('no account is NOT_CONNECTED', classifyCalendarError('not_connected') === 'not_connected');
check('no error is no kind', classifyCalendarError(null) === null && classifyCalendarError('') === null);
check('every kind has a Hebrew line',
  (['offline', 'signed_out', 'api_off', 'busy', 'not_connected', 'other'] as const)
    .every((k) => /[א-ת]/.test(calendarErrorLine(k, true).text)));
check('no line carries an exception', !/exception|java|http_/i.test(calendarErrorLine('other', false).text));

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
process.exit(failures === 0 ? 0 : 1);
