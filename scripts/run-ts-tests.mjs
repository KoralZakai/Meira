/**
 * run-ts-tests — run every TypeScript suite in tests/, and report ALL failures.
 *
 * WHY THIS REPLACED THE CHAIN
 * `test:all` used to be a hand-written chain of 57 `npm run` calls joined by
 * `&&`. Two things were wrong with that, and both had already bitten:
 *
 *   1. A suite reached the repo without reaching the chain. 68 test scripts
 *      were defined and 57 were invoked, so ELEVEN suites had never run in
 *      CI or by hand. One of them, test:wake, had been failing since the
 *      alarm policy changed to 'every-morning' — the expectation was stale
 *      for a week and nothing said so. tests/run-clash-parity.ts had no npm
 *      script at all. Nobody forgot on purpose; a list maintained by hand
 *      alongside the thing it lists will drift, every time.
 *   2. `&&` stops at the first failure. Three broken suites take three full
 *      CI round-trips to even SEE, which is the slowest possible way to learn
 *      something the first run already knew.
 *
 * So the list is derived from the filesystem now, not maintained: every
 * tests/run-*.ts runs unless it is named in SKIP below, WITH a reason. Adding
 * a suite is `git add`, and there is no second place to remember.
 *
 * Exit code is 0 only when every suite passed.
 *
 * Run:  npm run test:all          (add --serial to disable concurrency)
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import path from 'node:path';

/**
 * The local, pinned tsx — not `npx tsx`.
 *
 * tsx was not a dependency of this project at all until it was added alongside
 * this runner. Every suite ran through whatever version `npx` decided to fetch
 * from the registry at that moment: unpinned, re-downloaded, and a network
 * round trip away from the suite being runnable. Same shape as the
 * undeclared pytest-asyncio on the Python side — the tests' greenness was a
 * fact about the machine, not the code. Resolving the binary here also saves
 * npx's resolution on each of the ~64 spawns.
 */
const TSX = path.join('node_modules', '.bin', 'tsx');
if (!existsSync(TSX)) {
  console.error(`\n✗ ${TSX} is missing — run \`npm ci\` (tsx is a devDependency).\n`);
  process.exit(1);
}

/**
 * Suites that must NOT run here, each with the reason. A file in this map is a
 * decision; a file missing from tests/ is not.
 */
const SKIP = {
  'run-clash-parity.ts':
    'golden GENERATOR, not an assertion — it rewrites tests/fixtures/clash-golden.json. ' +
    'Running it here would make server/tests/test_clash_parity.py compare Python against ' +
    'freshly-regenerated TypeScript, which passes even when the two have drifted. ' +
    'CI checks the golden is current instead (see .github/workflows/tests.yml).',
};

/** Suites needing arguments. Without these they reach for the network. */
const ARGS = {
  'run-week-schedule.ts': ['--offline'],
  'run-yoga-scenario.ts': ['--offline'],
  // run-personas.ts is offline by default; `--live` is the opt-in and is never
  // passed here, because a suite that can fail on someone else's outage is not
  // a gate on our deploy.
};

const TESTS_DIR = 'tests';
const serial = process.argv.includes('--serial');

const files = readdirSync(TESTS_DIR)
  .filter((f) => f.startsWith('run-') && f.endsWith('.ts'))
  .sort();

const planned = files.filter((f) => !SKIP[f]);
const skipped = files.filter((f) => SKIP[f]);

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      TSX,
      [path.join(TESTS_DIR, file), ...(ARGS[file] ?? [])],
      // Her clock, not the runner's. The suites model an Israeli phone; on a
      // UTC CI runner run-ceva-interview read 14:30+03:00 as 11:30 and every
      // leave and wake time came out three hours early (4.10, the gate's
      // first run). An explicit TZ still wins.
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: process.env.TZ || 'Asia/Jerusalem' } },
    );
    let out = '';
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve({ file, code, out, ms: Date.now() - started });
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // A suite that never started is a FAILURE with a reason, not a silent gap
    // in the count. Without this the 'error' event is unhandled and takes the
    // whole runner down mid-pass, reporting nothing about the other 63.
    child.on('error', (err) => {
      out += `\ncould not start ${TSX}: ${err.message}\n`;
      done(-1);
    });
    child.on('close', done);
  });
}

/** Run with a bounded worker pool; each suite is its own process. */
async function runAll(list, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const file = list[next++];
      const r = await runOne(file);
      results.push(r);
      process.stdout.write(
        `${r.code === 0 ? '  ✓' : '  ✗'} ${r.file.padEnd(34)} ${String(r.ms).padStart(6)} ms\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

const limit = serial ? 1 : Math.max(2, Math.min(8, cpus().length));

console.log(`\nTypeScript suites — ${planned.length} to run, ${skipped.length} skipped, `
  + `concurrency ${limit}\n`);

const startedAll = Date.now();
const results = await runAll(planned, limit);
const failed = results.filter((r) => r.code !== 0);

for (const f of failed) {
  console.log(`\n${'─'.repeat(70)}\n✗ ${f.file} — exit ${f.code}\n${'─'.repeat(70)}`);
  // The tail is where these suites print their summary line; the full stdout of
  // 60 suites is not something anyone reads.
  console.log(f.out.trimEnd().split('\n').slice(-30).join('\n'));
}

if (skipped.length) {
  console.log('\nSkipped, on purpose:');
  for (const f of skipped) console.log(`  · ${f}\n      ${SKIP[f]}`);
}

const secs = ((Date.now() - startedAll) / 1000).toFixed(1);
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} `
  + `suites passed in ${secs}s`,
);
if (failed.length) {
  console.log(`   failed: ${failed.map((f) => f.file).join(', ')}`);
}
process.exit(failed.length === 0 ? 0 : 1);
