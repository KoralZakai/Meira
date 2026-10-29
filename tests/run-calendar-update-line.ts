/**
 * "📅 Update calendars" (menu, 8.10) — what it says after a tap.
 * Rule 3: it can say it failed, and why; "nothing new" is never said over a
 * calendar that could not be read.
 */
import { calendarUpdateLine } from '../src/utils/calendarUpdateLine';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const google = { added: 0, error: null, device: { ok: false, error: 'off' }, outlook: { ok: false, error: 'not_connected' } };

{
  const l = calendarUpdateLine({ ...google, added: 2 }, 0, true);
  ok(l.body === '✓ 2 חדשים ביומן' && !l.failed, 'two new events');
}
{
  const l = calendarUpdateLine(google, 3, true);
  ok(l.body === '✓ אין חדש ביומן\n📧 3 אירועים נמצאו במייל', 'nothing new, three in the mail');
  ok(l.title === 'עדכון יומנים', 'title');
}
{
  const l = calendarUpdateLine({ ...google, error: '401 invalid_grant' }, 0, true);
  ok(l.failed && !l.body.includes('אין חדש'), 'Google refused: no "nothing new" claim');
  ok(l.body.includes('להתחבר שוב'), 'Google refused: names the fix');
}
{
  const l = calendarUpdateLine({ added: 1, error: 'not_connected', device: { ok: false, error: 'permission_denied' } }, 0, true);
  ok(l.failed && l.body.includes('אין הרשאה') && l.body.includes('✓ 1 חדשים'), 'phone calendars refused, Outlook unused; what arrived is still said');
}
{
  const l = calendarUpdateLine({ added: 0, error: 'not_connected', device: { ok: false, error: 'off' },
    outlook: { ok: false, error: 'not_connected' } }, 0, true);
  ok(l.nothingConnected && l.body === 'עוד לא חובר יומן.', 'nothing connected: says so, offers to connect');
}
{
  const l = calendarUpdateLine({ added: 0, error: 'not_connected', device: { ok: true },
    outlook: { ok: false, error: 'reconnect' } }, 0, false);
  ok(l.failed && l.body.startsWith('📧 Outlook: sign in again'), 'Outlook needs signing in again (English)');
}

{
  // Gmail off in this build (null): said in words, never "0 found in your email".
  const l = calendarUpdateLine({ ...google, added: 1 }, null, true);
  ok(l.body === '✓ 1 חדשים ביומן\n✉️ קריאת Gmail כבויה בגרסה הזו. מאירה קוראת רק את היומן.', 'Gmail off (he): says it is off');
  const e = calendarUpdateLine({ ...google, added: 0 }, null, false);
  ok(e.body.includes('Reading Gmail is off in this version') && !/found in your email/.test(e.body), 'Gmail off (en): says it is off');
  const n = calendarUpdateLine({ added: 0, error: 'not_connected', device: { ok: false, error: 'off' },
    outlook: { ok: false, error: 'not_connected' } }, null, true);
  ok(n.body === 'עוד לא חובר יומן.', 'nothing connected: the Gmail line does not crowd the one thing to do');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
