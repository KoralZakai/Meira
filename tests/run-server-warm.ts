/**
 * run-server-warm — the sleeping server is knocked on when a request is
 * coming, at most once a minute, and nothing waits for it.
 *
 * 19.10: the Fly machine sleeps when idle, so her first mic turn of the
 * morning paid the boot. serverAvailable() existed with no callers — and it
 * only checks the session, so calling it would have woken nothing. warmServer
 * GETs /health from the root's foreground event and from the mic sheet.
 *
 *   npx tsx tests/run-server-warm.ts
 */
import * as fs from 'fs';
import * as path from 'path';

process.env.EXPO_PUBLIC_SERVER_URL = 'https://example.test';
const hits: string[] = [];
let fail503 = false;
(globalThis as any).fetch = (url: string) => {
  hits.push(url);
  return fail503 ? Promise.reject(new Error('Network request failed')) : Promise.resolve({ status: 200 });
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getSession: async () => null };
  }
  return origLoad.call(this, request, ...rest);
};
console.warn = () => {};
const { warmServer } = require('../src/services/LumiServer');

let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  console.log('\nWaking the server\n');
  const ret = warmServer('foreground');
  ok(ret === undefined, 'returns nothing to wait on (fire-and-forget)');
  ok(hits.length === 1 && hits[0] === 'https://example.test/health', 'GETs /health', hits.join(','));
  warmServer('mic');
  ok(hits.length === 1, 'a second knock within the minute is skipped', `${hits.length}`);

  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  fail503 = true;
  warmServer('foreground');
  ok(hits.length === 2, 'a minute later it knocks again', `${hits.length}`);
  await new Promise((r) => setTimeout(r, 5));
  warmServer('mic');
  ok(hits.length === 3, 'a knock that failed does not count — the next moment tries again', `${hits.length}`);
  Date.now = realNow;

  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
  const sheet = fs.readFileSync(path.join(root, 'src/components/VoiceSheet.tsx'), 'utf8');
  const active = app.slice(app.indexOf("AppState.addEventListener('change'"));
  ok(/if \(s !== 'active'\) return;\s*warmServer\('foreground'\)/.test(active),
    'trigger: the app comes to the foreground (root AppState, not a screen)');
  ok(/warmServer\('launch'\)/.test(app), 'trigger: cold start');
  ok(/beginVoiceContext\(lang\);[\s\S]{0,200}warmServer\('mic'\)/.test(sheet), 'trigger: the mic sheet opens');

  console.log(fail ? `\n❌ ${fail} failed\n` : '\n✅ all passed\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
