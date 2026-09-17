/**
 * run-release-config — the settings that break a release silently.
 *
 * Every check here is something that has actually gone wrong, or was found
 * wrong during the pre-release security review, and none of them announce
 * themselves. A wrong build environment does not fail the build; it produces an
 * APK that installs, opens, and quietly has no Supabase, no maps and no
 * server. A permission nobody uses does not crash anything; it stalls a Play
 * review. That is what makes them worth a test rather than a comment.
 *
 * Static only: it reads the config files. No network, no build.
 *
 * Run:  npx tsx tests/run-release-config.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const eas = JSON.parse(read('eas.json'));
const app = JSON.parse(read('app.json')).expo;

function main() {
  console.log('\nRelease configuration\n');

  console.log('1. Every build profile must load the environment that HAS the keys');
  // CLAUDE.md: "preview" is the only EAS environment with the EXPO_PUBLIC_*
  // values in it. On 2026-09-15 the production profile pointed at
  // "production", which holds exactly one variable — so a Play upload would
  // have shipped an app with no sign-in, no sync, no routes and no server,
  // with nothing anywhere saying so.
  for (const [name, profile] of Object.entries<any>(eas.build)) {
    check(`${name} -> preview`, profile.environment === 'preview',
      String(profile.environment));
  }

  console.log('\n2. Play needs a version code that moves');
  check('appVersionSource is set', Boolean(eas.cli?.appVersionSource),
    'Play rejects a second upload carrying the same versionCode');
  check('the store profile increments it',
    eas.build.production?.android?.autoIncrement === 'versionCode');
  check('the store profile ships a bundle, not an apk',
    eas.build.production?.android?.buildType === 'app-bundle');

  console.log('\n3. Permissions: ask for nothing the app does not use');
  const perms: string[] = app.android?.permissions ?? [];
  const blocked: string[] = app.android?.blockedPermissions ?? [];
  const bare = (p: string) => p.replace('android.permission.', '');

  // The most scrutinised permission on Play — a declaration form and a demo
  // video — and the feature behind it does not exist: the background task is
  // never registered with TaskManager and the function that would start it has
  // no callers.
  check('background location is NOT requested',
    !perms.some((p) => bare(p) === 'ACCESS_BACKGROUND_LOCATION'));
  check('...and is explicitly blocked, so a library cannot re-add it',
    blocked.some((p) => bare(p) === 'ACCESS_BACKGROUND_LOCATION'));

  // Contacts are read (ContactService), never written.
  check('WRITE_CONTACTS is not requested',
    !perms.some((p) => bare(p) === 'WRITE_CONTACTS'));
  check('...and is blocked', blocked.some((p) => bare(p) === 'WRITE_CONTACTS'));

  // Pulled in by libraries, used by nothing here. Each one is a question on a
  // Play review that has no good answer.
  for (const p of ['SYSTEM_ALERT_WINDOW', 'USE_BIOMETRIC', 'USE_FINGERPRINT',
    'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']) {
    check(`${p} is blocked`, blocked.some((b) => bare(b) === p));
  }

  // The ones the app genuinely needs must survive this tidying.
  for (const p of ['RECORD_AUDIO', 'ACCESS_FINE_LOCATION', 'READ_CONTACTS',
    'SCHEDULE_EXACT_ALARM']) {
    check(`${p} is still requested`, perms.some((q) => bare(q) === p));
  }
  check('nothing is both requested and blocked',
    !perms.some((p) => blocked.some((b) => bare(b) === bare(p))));

  console.log('\n4. The build upload must not carry server secrets');
  const easignore = read('.easignore');
  const line = (s: string) => easignore.split('\n').some((l) => l.trim() === s);
  check('the whole server/ tree is excluded', line('server/'),
    'it holds the JSON stores with conversations and profiles');
  check('every .env is excluded', line('.env') && line('.env.*'));
  check('...except .env.production, which holds only EXPO_PUBLIC_* values',
    line('!.env.production'));
  check('signing material is excluded',
    line('*.jks') && line('*.p12') && line('*.key'));

  console.log('\n5. The deployed image must not carry personal data');
  const dockerignore = read('.dockerignore');
  const dline = (s: string) => dockerignore.split('\n').some((l) => l.trim() === s);
  // The Dockerfile does `COPY server/ .`, so anything not excluded here is
  // baked into the image and pushed to the registry. At runtime every store is
  // opened from config.DATA_DIR (the Fly volume), never from the code
  // directory, so these copies are never read — they only travel.
  for (const f of ['server/conversations.json', 'server/profiles.json',
    'server/user_memory.json', 'server/active_session.json',
    'server/travel_prefs.json', 'server/known_places.json']) {
    check(`${f} stays out of the image`, dline(f));
  }
  check('the 144 MB virtualenv stays out', dline('server/.venv/'),
    'the image rebuilds it from requirements.txt, and COPY would shadow it');

  console.log('\n6. Nothing but EXPO_PUBLIC_* may reach the device');
  // Everything in this file is compiled into the bundle and is extractable
  // from the APK. A server secret here ships to every user, which is how the
  // old LLM key had to be rotated.
  const envProd = path.join(root, '.env.production');
  if (fs.existsSync(envProd)) {
    const names = [...read('.env.production').matchAll(/^(\w+)=/gm)].map((m) => m[1]);
    const leaked = names.filter((n) => !n.startsWith('EXPO_PUBLIC_'));
    check('.env.production contains only EXPO_PUBLIC_* names',
      leaked.length === 0, leaked.join(', ') || `${names.length} vars, all public`);
  } else {
    check('.env.production is generated at build time (not present here)', true);
  }

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
