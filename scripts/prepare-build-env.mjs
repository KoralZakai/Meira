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
 * .easignore excludes `.env.*` from the build tarball and whitelists exactly
 * one file: `.env.production`. So the public subset has to be copied there.
 *
 * NO KEY IS EVER STORED ON DISK. The EAS preview environment also holds server
 * secrets (WHATSAPP_API_TOKEN, DATABASE_URL, ANTHROPIC_API_KEY and friends), and
 * a plain `eas env:pull` writes every one of them into .env.local in plaintext —
 * that happened on 2026-09-28. So the pull goes to a private temp file that is
 * deleted before this script does anything else, even when the pull fails, and
 * .env.local only ever receives the build variables (EXPO_PUBLIC_*, APP_ENV).
 * An existing .env.local holding anything else is stripped on every run.
 *
 * Usage:  node scripts/prepare-build-env.mjs        (runs from `npm run android:*`)
 *         REFRESH=1 node scripts/prepare-build-env.mjs   (re-pull from EAS first)
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The only names .env.local may hold. It is a build input and nothing else:
// the server reads its secrets from Fly, never from a file on this laptop.
const BUILD_VAR = /^(EXPO_PUBLIC_[A-Z0-9_]+|APP_ENV)$/;
// `NAME=` and the `# NAME=***** (secret)` placeholder eas writes for secrets.
const ASSIGNMENT = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
// Safe to echo. eas writes values raw, so a multi-line value (a PEM key) puts
// base64 lines in the file that parse as `CHUNK=`; a name without an
// underscore could be one, and is only counted, never printed.
const PRINTABLE_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

/** Split env-file text into the lines .env.local may keep and the ones it may not. */
function buildVarsOnly(text, { keepComments }) {
  const kept = [];
  const dropped = [];
  for (const line of text.split('\n')) {
    const name = line.match(ASSIGNMENT)?.[1];
    if (name) (BUILD_VAR.test(name) ? kept : dropped).push(line);
    else if (!line.trim() || line.trimStart().startsWith('#')) {
      if (keepComments) kept.push(line);
    } else dropped.push(line);
  }
  return { kept, dropped };
}

/** Names only, and only those that cannot be a fragment of a value. */
function describeDropped(dropped) {
  const names = new Set();
  let other = 0;
  for (const line of dropped) {
    const name = line.match(ASSIGNMENT)?.[1];
    if (name && PRINTABLE_NAME.test(name)) names.add(name);
    else other++;
  }
  return [...names, ...(other ? [`${other} other line(s)`] : [])].join(', ');
}

/**
 * `eas env:pull` into a private temp dir, and return the text. The dir is
 * removed in `finally`, so nothing survives a failed pull. SIGINT/SIGTERM/SIGHUP
 * are held while the child runs: without a listener, Ctrl-C kills node on the
 * spot and `finally` never runs. (SIGKILL cannot be caught; the dir is 0700 in
 * the per-user tmpdir.)
 */
function pullPreviewEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'lumi-eas-env-'));
  const file = join(dir, '.env');
  const hold = () => {};
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) process.on(s, hold);
  try {
    // Pre-created 0600: eas overwrites in place, so the mode sticks.
    writeFileSync(file, '', { mode: 0o600 });
    execFileSync('npx', ['eas-cli', 'env:pull', '--environment', 'preview', '--non-interactive', '--path', file], {
      stdio: 'inherit',
    });
    return readFileSync(file, 'utf8');
  } catch (err) {
    const why = err.signal ?? (err.status != null ? `exit ${err.status}` : err.code);
    console.error(`x eas env:pull failed (${why}) — nothing was written.`);
    return null;
  } finally {
    for (const s of signals) process.off(s, hold);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`x could not delete ${dir} (${err.code}) — delete it by hand, it holds server secrets.`);
      process.exit(1);
    }
  }
}

if (process.env.REFRESH || !existsSync(SOURCE)) {
  console.log('· pulling the EAS preview env into a temp file (deleted right after)');
  const pulled = pullPreviewEnv();
  if (pulled === null) process.exit(1);

  const { kept, dropped } = buildVarsOnly(pulled, { keepComments: false });
  // A file-type variable is written beside the project, not into the temp dir.
  for (const line of dropped) {
    const name = line.match(ASSIGNMENT)?.[1];
    if (name) rmSync(join('.eas', '.env', name), { force: true });
  }
  writeFileSync(
    SOURCE,
    `# Generated by scripts/prepare-build-env.mjs from the EAS "preview" environment.\n` +
      `# Build variables ONLY (EXPO_PUBLIC_*, APP_ENV). Server secrets are Fly secrets\n` +
      `# and never touch this disk. Regenerate with: REFRESH=1 npm run build:env\n` +
      `${kept.join('\n')}\n`,
  );
  console.log(`v ${SOURCE} written — ${kept.length} build vars`);
  if (dropped.length) console.log(`  left out (never written here): ${describeDropped(dropped)}`);
} else {
  // A .env.local from an older, plain `eas env:pull` still holds every secret.
  const { kept, dropped } = buildVarsOnly(readFileSync(SOURCE, 'utf8'), { keepComments: true });
  if (dropped.length) {
    writeFileSync(SOURCE, kept.join('\n'));
    console.warn(`!  ${SOURCE} held non-build values — removed: ${describeDropped(dropped)}`);
  }
}

if (!existsSync(SOURCE)) {
  console.error(`x ${SOURCE} is missing and could not be pulled.`);
  console.error('  Run: REFRESH=1 npm run build:env   (never a bare `eas env:pull` — it writes server secrets)');
  process.exit(1);
}

// Keep only the client-visible half. .env.local holds nothing else now, but
// the filter stays: .env.production is the one file that ships.
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
