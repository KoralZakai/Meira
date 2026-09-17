/**
 * run-log-redaction — the app's release logs must not carry other people's data.
 *
 * Written during the pre-release security review. The live logcat from her own
 * phone showed `pulling from …/tasks/972500000000` fifty-three times in two
 * hundred lines, task titles, and Supabase error payloads. On her phone that
 * was a diagnostic. On a friend's phone it is their phone number and their
 * appointments, and it is the thing Play's Data Safety form asks about.
 *
 * Two properties, and the second is the one that gets forgotten:
 *
 *   it redacts   — every pattern that identifies a person or authorises a
 *                  request
 *   it survives  — a logger that throws is a worse bug than the leak it was
 *                  meant to fix, so cycles, depth and odd values must all be
 *                  handled rather than trusted
 *
 * Run:  npx tsx tests/run-log-redaction.ts
 */
import { redact, redactString, installLogGate } from '../src/utils/logRedaction';

let failures = 0;
let checks = 0;
// Bound to the REAL console before anything can replace it. Section 5 installs
// the production gate, which silences console.log — including this harness's
// own output. The first run of this file ended at check 26 with no summary and
// no failure, looking for all the world like a crash.
const say = console.log.bind(console);
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  say(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const gone = (needle: string, haystack: string) => !haystack.includes(needle);

function main() {
  say('\nLog redaction\n');

  say('1. Credentials never reach the log');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc123DEF456ghi';
  check('a JWT is replaced', redactString(`token=${jwt}`) === 'token=<jwt>');
  check('an Authorization header is replaced',
    redactString('Bearer sk_live_abcdefgh12345678').includes('<redacted>'));
  check('a Google API key is replaced',
    gone('AIzaSyD', redactString('key=AIzaSyD1234567890abcdefghijklmnop')));

  say('\n2. People are not identifiable');
  // The exact string from the real log.
  const real = 'pulling from https://lumi-whatsapp.fly.dev/tasks/972500000000';
  check('her number, in the form the log actually used',
    gone('972500000000', redactString(real)), redactString(real));
  check('the local 05x form', gone('0500000000', redactString('from 0500000000')));
  check('the dashed form', gone('050-000-0000', redactString('call 050-000-0000')));
  check('E.164 generally', gone('+447700900123', redactString('+447700900123')));
  check('an email address',
    gone('you@example.com', redactString('user you@example.com signed in')));
  check('a GPS fix precise enough to be a doorstep',
    gone('32.06140', redactString('here 32.06140,34.77150')),
    redactString('here 32.06140,34.77150'));
  check('a coarse number is NOT mangled — this must not eat ordinary data',
    redactString('took 32.5 minutes') === 'took 32.5 minutes');

  say('\n3. Whatever console is handed, not just strings');
  const obj = redact({ phone: '972500000000', nested: { token: jwt }, n: 42 }) as any;
  check('objects are walked', gone('972500000000', JSON.stringify(obj)));
  check('...to depth', obj.nested.token === '<jwt>');
  check('...leaving harmless values alone', obj.n === 42);
  const arr = redact(['972500000000', 7]) as any[];
  check('arrays are walked', arr[0] === '<phone>' && arr[1] === 7);
  const err = redact(new Error('failed for 972500000000')) as Error;
  check('Error messages are cleaned', gone('972500000000', err.message), err.message);
  check('...and stay Errors', err instanceof Error);

  say('\n4. The logger must never be the thing that breaks');
  const cycle: any = { phone: '972500000000' };
  cycle.self = cycle;
  let threw = false;
  let out: any;
  try { out = redact(cycle); } catch { threw = true; }
  check('a circular object does not throw', !threw);
  check('...is still redacted', !threw && out.phone === '<phone>');
  check('...and the cycle is marked', !threw && out.self === '<circular>');
  check('null and undefined pass through',
    redact(null) === null && redact(undefined) === undefined);
  check('numbers, booleans and functions pass through',
    redact(42) === 42 && redact(true) === true);
  let deepThrew = false;
  try {
    let deep: any = 'x';
    for (let i = 0; i < 50; i += 1) deep = { deep };
    redact(deep);
  } catch { deepThrew = true; }
  check('a deeply nested object does not blow the stack', !deepThrew);

  say('\n5. The gate itself');
  const original = { log: console.log, warn: console.warn, error: console.error };
  try {
    installLogGate(true);
    check('development keeps console.log', console.log === original.log);

    const seen: unknown[][] = [];
    console.warn = (...a: unknown[]) => { seen.push(a); };
    console.error = () => {};
    installLogGate(false);
    check('production silences console.log', console.log !== original.log);
    console.log('this must vanish');   // no-op now
    console.warn('failed for 972500000000');
    check('production keeps console.warn', seen.length === 1);
    check('...and redacts what it carries',
      gone('972500000000', String(seen[0]?.[0])), String(seen[0]?.[0]));
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  say(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
