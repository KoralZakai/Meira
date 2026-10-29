/**
 * run-signin-backfill-gate — the "push everything after sign-in" runs once per
 * sign-in, not on every launch.
 *
 * 19.10, measured on her phone: every cold start logged
 *   [App] post-sign-in: pushed 245 task(s)
 * because backfillCloudAfterSignIn ran on ANY auth event with a session —
 * INITIAL_SESSION at launch, TOKEN_REFRESHED every hour, and SIGNED_IN, which
 * auth-js ALSO emits when it restores a stored session (_recoverAndRefresh).
 * So the gate is the event AND "not already done for this account here".
 *
 *   npx tsx tests/run-signin-backfill-gate.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src/services/SupabaseAuthService.ts'), 'utf8');

console.log('\nSign-in backfill: once per sign-in\n');
ok(/onAuthStateChange\(\(event, session\) => callback\(session, event\)\)/.test(auth),
  'onAuthChange passes the auth event through');

const handler = app.slice(app.indexOf('onAuthChange((s, event)'), app.indexOf('return () => {', app.indexOf('onAuthChange((s, event)')));
ok(handler.length > 0, 'found the auth handler');
ok(!/backfillCloudAfterSignIn\(\)/.test(handler), 'the handler never calls the backfill directly');
ok(/event === 'SIGNED_IN'/.test(handler) && /backfillOnSignIn\(s\.user\.id\)/.test(handler),
  'only SIGNED_IN reaches it, with the account id');
ok(/event === 'SIGNED_OUT'[\s\S]*removeItem\(BACKFILLED_FOR_KEY\)/.test(handler),
  'signing out clears the mark, so signing back in pushes again');
ok(/invalidateTaskCache\(\)/.test(handler), 'an account change ends the shared task read');

const gate = app.slice(app.indexOf('async function backfillOnSignIn'), app.indexOf('async function backfillCloudAfterSignIn'));
ok(/if \(done === userId\) return;/.test(gate), 'a restored session for the same account does nothing');
ok(/if \(await backfillCloudAfterSignIn\(\)\)[\s\S]*setItem\(BACKFILLED_FOR_KEY, userId\)/.test(gate),
  'the mark is set only when the backfill reached the cloud — a failed one is retried next sign-in event');

console.log(fail ? `\n❌ ${fail} failed\n` : '\n✅ all passed\n');
process.exit(fail ? 1 : 0);
