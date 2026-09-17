#!/usr/bin/env node
/**
 * Put the EXPO_PUBLIC_* values where a build can actually see them, and refuse
 * to build when they are missing.
 *
 * Why this exists: `EXPO_PUBLIC_*` is inlined into the JS bundle at build time.
 * Every local build so far ran with none of them set, because the repo has no
 * committed .env — which is correct, but nothing filled the gap. The resulting
 * APKs had `isSupabaseConfigured === false`, so the sign-in screen never
 * rendered, every cloud write was skipped, the phone could never be linked,
 * and no route could be planned (no Maps key). All of it failed silently, and
 * it read on the phone as "the app just doesn't sync".
 *
 * `eas env:pull` writes .env.local, but .easignore excludes `.env.*` from the
 * build tarball and whitelists exactly one file: `.env.production`. So pulling
 * alone is not enough — the public subset has to be copied there. The subset
 * matters: .env.local also holds WHATSAPP_API_TOKEN, DATABASE_URL and friends,
 * which must never travel with the app.
 *
 * Usage:  node scripts/prepare-build-env.mjs        (runs from `npm run android:*`)
 *         REFRESH=1 node scripts/prepare-build-env.mjs   (re-pull from EAS first)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Without any one of these the app is broken in a way that is invisible on the
// phone, so an absent value must stop the build rather than ship.
const REQUIRED = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SERVER_URL',
  'EXPO_PUBLIC_GOOGLE_MAPS_API_KEY',
  'EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_ANDROID',
];

const SOURCE = '.env.local';
const TARGET = '.env.production';

if (process.env.REFRESH || !existsSync(SOURCE)) {
  console.log(`· pulling EAS preview env into ${SOURCE}`);
  execFileSync('npx', ['eas-cli', 'env:pull', '--environment', 'preview', '--non-interactive'], {
    stdio: 'inherit',
  });
}

if (!existsSync(SOURCE)) {
  console.error(`x ${SOURCE} is missing and could not be pulled.`);
  console.error('  Run: npx eas-cli env:pull --environment preview');
  process.exit(1);
}

// Keep only the client-visible half. Everything else is a server secret.
const publicLines = readFileSync(SOURCE, 'utf8')
  .split('\n')
  .filter((line) => /^EXPO_PUBLIC_[A-Z0-9_]+=/.test(line));

const present = new Set(
  publicLines
    .map((line) => line.slice(0, line.indexOf('=')))
    // An empty value is the same failure as an absent one, and harder to spot.
    .filter((name) => publicLines.find((l) => l.startsWith(`${name}=`)).slice(name.length + 1).trim()),
);

const missing = REQUIRED.filter((name) => !present.has(name));
if (missing.length) {
  console.error('x refusing to build — these would be undefined in the bundle:');
  for (const name of missing) console.error(`    ${name}`);
  console.error(`\n  Set them with:  npx eas-cli env:set --environment preview --name <NAME> --value <VALUE>`);
  console.error(`  then re-run with REFRESH=1.`);
  process.exit(1);
}

// ── Secret classification ───────────────────────────────────────────────────
// The EXPO_PUBLIC_ prefix is a BUILD instruction ("inline me"), not a security
// claim. Anything carrying it is extractable from the APK with `unzip` — so the
// prefix filter above stops server secrets that are *named* like server
// secrets, and nothing at all stops one that has been given a public name.
//
// Two classes, deliberately different in severity:
//
//   KNOWN_CLIENT_EXPOSED — already shipping, tracked, and not blocking.
//
//   Anything else that looks like a credential — BLOCKED. This is the
//     regression guard: a NEW secret can never quietly join the bundle.
//
// EXPO_PUBLIC_NEBIUS_API_KEY used to sit in the first list with the note
// "migrate the last callers, then delete". The callers are migrated: every
// model call now happens on the server, so the key is no longer required, no
// longer allowed, and matches CREDENTIAL_ISH — if it ever reappears in the
// bundle this script blocks the build instead of warning about it.
const KNOWN_CLIENT_EXPOSED = {
  EXPO_PUBLIC_GOOGLE_MAPS_API_KEY:
    'Maps/Directions key. Restrict by Android package + SHA-1 in Google Cloud Console.',
};
// Names that are safe to inline: public endpoints and public/anon identifiers.
const SAFE = /_(URL|BASE_URL|MODEL|CLIENT_ID|CLIENT_ID_ANDROID|ANON_KEY|PROJECT_ID)$/;
const CREDENTIAL_ISH = /(SECRET|PRIVATE|SERVICE_ROLE|_TOKEN|PASSWORD|_KEY)$/;

const shipped = publicLines.map((l) => l.slice(0, l.indexOf('=')));
const unexpected = shipped.filter(
  (n) => !(n in KNOWN_CLIENT_EXPOSED) && !SAFE.test(n) && CREDENTIAL_ISH.test(n),
);

if (unexpected.length) {
  console.error('\nx refusing to build — these look like credentials and would be');
  console.error('  compiled into the APK, where `unzip` reveals them:');
  for (const name of unexpected) console.error(`    ${name}`);
  console.error('\n  Move them server-side and reach them through the backend, or —');
  console.error('  if genuinely public — rename so the intent is explicit (…_URL, …_ANON_KEY,');
  console.error('  …_CLIENT_ID) or add to KNOWN_CLIENT_EXPOSED in this script with a reason.');
  process.exit(1);
}

const stillExposed = shipped.filter((n) => n in KNOWN_CLIENT_EXPOSED);
if (stillExposed.length) {
  console.warn('\n!  SECURITY — these ship inside the APK and are extractable:');
  for (const name of stillExposed) console.warn(`     ${name}  — ${KNOWN_CLIENT_EXPOSED[name]}`);
  console.warn('   Tracked in docs/product-audit.md §27. Not blocking this build.\n');
}

writeFileSync(
  TARGET,
  `# Generated by scripts/prepare-build-env.mjs — do not edit, do not commit.\n` +
    `# The EXPO_PUBLIC_* subset of ${SOURCE}; .easignore ships this file and only this file.\n` +
    `${publicLines.join('\n')}\n`,
);

console.log(`v ${TARGET} written — ${publicLines.length} public vars, all ${REQUIRED.length} required ones present`);
