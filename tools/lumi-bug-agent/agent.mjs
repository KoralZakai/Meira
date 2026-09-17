#!/usr/bin/env node
/**
 * Lumi bug agent — fixes bugs reported over WhatsApp, on this Mac.
 *
 * Why here and not on Fly: the server is a Python container with no checkout of
 * this repo, no Claude Code, and no way to run an EAS build. Fixing code needs
 * a machine that has all three. The trade-off, accepted deliberately: nothing
 * happens while the Mac is asleep.
 *
 * The loop, per bug:
 *   1. poll  GET /admin/bugs
 *   2. branch bug/lumi-xxxx off origin/master, in its OWN git worktree
 *   3. fix    `claude -p` with the report, the screenshot, and the repo
 *   4. test   python + TS harnesses + a tsc regression check
 *   5. ask    WhatsApp: "fixed, build it?" → status 'fixed'
 *   6. build  on "בנה LUMI-xxxx", run EAS and send the install link
 *
 * Safety rules that are not negotiable here:
 *   - never commits to master, never merges, never force-pushes
 *   - never touches LUMI_REPO's own checkout: every bug gets a worktree under
 *     LUMI_WORKTREES. Before this, step 2 ran `git checkout master` in the
 *     repo directory itself and silently switched the branch under whoever was
 *     working there — a whole session's work looked lost twice because of it.
 *   - a failing test suite means the fix is NOT offered for build
 *   - tsc error count must not exceed the pre-change baseline
 * The user reviews the branch; this only ever proposes.
 *
 * Env: LUMI_ADMIN_TOKEN (required), LUMI_SERVER_URL, LUMI_REPO, LUMI_POLL_MS,
 *      LUMI_WORKTREES (default: a sibling dir of LUMI_REPO).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

const SERVER = process.env.LUMI_SERVER_URL || 'https://lumi-whatsapp.fly.dev';
const TOKEN = process.env.LUMI_ADMIN_TOKEN;
const REPO = process.env.LUMI_REPO || '/Users/user/dev/Lumi-My-AI-Assistant';
const POLL_MS = Number(process.env.LUMI_POLL_MS || 120_000);
// Outside REPO on purpose: a worktree nested inside the repo shows up as an
// untracked directory in every `git status` and gets swept up by `git add -A`.
const WORKTREES = process.env.LUMI_WORKTREES || join(REPO, '..', '.lumi-bug-worktrees');

if (!TOKEN) {
  console.error('LUMI_ADMIN_TOKEN is not set — refusing to start.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Run a command. `opts.cwd` defaults to REPO — pass a worktree to stay out of it. */
async function sh(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts.cwd || REPO,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 900_000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
    });
    return { ok: true, out: stdout, err: stderr };
  } catch (e) {
    return { ok: false, out: e.stdout || '', err: e.stderr || String(e) };
  }
}

/**
 * A private checkout for one bug.
 *
 * This used to be `git checkout master` + `git checkout -B bug/xxxx` inside
 * REPO itself, which yanked the branch out from under whoever was working in
 * that directory — mid-edit, every time a report arrived. A worktree gives the
 * agent its own checkout of the same repo and the same object store, so the
 * live directory is never touched and no work can be stranded.
 *
 * node_modules and .env.local are symlinked rather than reinstalled: a fresh
 * worktree has neither, and the test harnesses, tsc and an EAS build all need
 * them. .env.local in particular holds the EXPO_PUBLIC_* values — a build
 * without it produces an APK with no Supabase, no maps and no server.
 */
async function worktreeFor(branch) {
  const path = join(WORKTREES, branch.replace(/\//g, '-'));
  await sh('bash', ['-lc', `mkdir -p ${q(WORKTREES)}`]);
  // Non-destructive in REPO: updates origin/master without moving HEAD.
  await sh('git', ['fetch', 'origin', 'master']);
  // Stale worktree from a previous run for the same bug. No-op when absent.
  await sh('git', ['worktree', 'remove', '--force', path]);
  const add = await sh('git', [
    'worktree', 'add', '--force', '-B', branch, path, 'origin/master',
  ]);
  if (!add.ok) {
    log(`x worktree failed for ${branch}: ${add.err.slice(0, 300)}`);
    return null;
  }
  for (const name of ['node_modules', '.env.local']) {
    const src = join(REPO, name);
    await sh('bash', ['-lc', `[ -e ${q(src)} ] && ln -sfn ${q(src)} ${q(join(path, name))} || true`]);
  }
  return path;
}

/** Shell-quote one path. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function api(path, init = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: {
      'x-admin-token': TOKEN,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res;
}

const setStatus = (id, status, extra = {}) =>
  api(`/admin/bugs/${id}`, { method: 'POST', body: JSON.stringify({ status, ...extra }) });

/** Save the attached screenshot locally so Claude can actually look at it. */
async function fetchScreenshot(id) {
  try {
    const res = await fetch(`${SERVER}/admin/bugs/${id}/image`, {
      headers: { 'x-admin-token': TOKEN },
    });
    if (!res.ok) return null;
    const dir = await mkdtemp(join(tmpdir(), 'lumi-bug-'));
    const path = join(dir, `${id}.jpg`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    return path;
  } catch {
    return null;
  }
}

/** tsc errors right now. The baseline is whatever master has — not zero. */
async function tscErrors(cwd) {
  const r = await sh('npx', ['tsc', '--noEmit'], { cwd });
  return (r.out + r.err)
    .split('\n')
    .filter((l) => /^(src|tests|App).*error TS/.test(l)).length;
}

async function runTests(cwd) {
  const results = [];
  const py = await sh('bash', [
    '-lc',
    'cd server && (python3.12 -m pytest tests/ -q || python3 -m pytest tests/ -q)',
  ], { cwd });
  results.push({
    name: 'python',
    ok: py.ok,
    tail: (py.out + py.err).trim().split('\n').slice(-3).join('\n'),
  });

  for (const t of ['test:personas', 'test:reminders', 'test:future', 'test:planning']) {
    const r = await sh('npm', ['run', t, '--silent'], { cwd });
    results.push({
      name: t,
      ok: r.ok,
      tail: (r.err || r.out).trim().split('\n').slice(-2).join('\n'),
    });
  }
  return results;
}

async function fixOne(bug, baselineErrors) {
  const id = bug.id;
  log(`> ${id}: ${bug.description}`);
  await setStatus(id, 'fixing');

  // Always start from current master. A stale branch fixes the wrong code.
  const branch = `bug/${id.toLowerCase()}`;
  const cwd = await worktreeFor(branch);
  if (!cwd) {
    await setStatus(id, 'new', { note: 'could not create a worktree' });
    return;
  }

  const shot = await fetchScreenshot(id);
  const context = (bug.context || [])
    .map((t) => `user: ${t.user || ''}\nlumi: ${t.assistant || ''}`)
    .join('\n');

  const prompt = [
    'A user reported this bug in the Lumi app (React Native/Expo + a Python WhatsApp server).',
    '',
    `BUG ${id}: ${bug.description}`,
    shot ? `A screenshot is attached at: ${shot} — read it.` : 'No screenshot was attached.',
    context ? `\nConversation just before the report:\n${context}` : '',
    '',
    'Read CLAUDE.md first. Find the ROOT CAUSE and fix it — do not paper over the',
    'symptom, and do not delete working code. Add or update a test that fails',
    'without your fix. Keep changes minimal and in the existing style.',
    'If you cannot reproduce or identify the cause with confidence, change',
    'nothing and explain why instead — a wrong fix is worse than none.',
  ].join('\n');

  const r = await sh('claude', ['-p', prompt, '--permission-mode', 'acceptEdits'], {
    cwd,
    timeout: 1_800_000,
  });
  if (!r.ok) {
    log(`x ${id}: claude failed`);
    await setStatus(id, 'new', { note: `agent run failed: ${r.err.slice(0, 300)}` });
    return;
  }

  const diff = await sh('git', ['diff', '--stat', 'origin/master'], { cwd });
  if (!diff.out.trim()) {
    await setStatus(id, 'triaged', {
      note: 'agent made no change',
      notify: `🐞 ${id}: לא הצלחתי לשחזר את הבאג מהתיאור. אפשר עוד פרט או צילום?`,
    });
    return;
  }

  const tests = await runTests(cwd);
  const errors = await tscErrors(cwd);
  const failed = tests.filter((t) => !t.ok);
  const tscRegressed = errors > baselineErrors;

  if (failed.length || tscRegressed) {
    // Leave the branch in place for a human to look at, but never offer it.
    const why = [
      ...failed.map((f) => `${f.name}: ${f.tail}`),
      tscRegressed ? `tsc ${errors} > baseline ${baselineErrors}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    log(`x ${id}: tests failed\n${why}`);
    await setStatus(id, 'triaged', {
      note: `tests failed:\n${why}`,
      notify: `🐞 ${id}: כתבתי תיקון אבל הטסטים נפלו — לא אבנה גרסה. צריך מבט שלך.`,
    });
    return;
  }

  await sh('git', ['add', '-A'], { cwd });
  await sh('git', [
    'commit',
    '-m',
    `fix(${id}): ${bug.description.slice(0, 60)}\n\nReported from WhatsApp.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`,
  ], { cwd });
  await sh('git', ['push', '-u', 'origin', branch], { cwd });

  await setStatus(id, 'fixed', {
    note: `branch ${branch}, tests green`,
    notify:
      `✅ ${id} תוקן — הטסטים עוברים.\n״${bug.description.slice(0, 60)}״\n` +
      `לבנות גרסה? שלחי: בנה ${id}`,
  });
  log(`v ${id}: fixed on ${branch}`);
}

async function buildFor(bug) {
  const id = bug.id;
  log(`> ${id}: building`);
  // The branch was pushed from its worktree and is still checked out there.
  // Rebuilding it here must not disturb REPO, so re-derive the path rather
  // than checking the branch out.
  const cwd = join(WORKTREES, `bug-${id.toLowerCase()}`);
  const r = await sh(
    'npx',
    ['eas-cli', 'build', '--platform', 'android', '--profile', 'preview', '--non-interactive', '--no-wait'],
    { cwd, timeout: 1_800_000 },
  );

  const url = (r.out + r.err).match(/https:\/\/expo\.dev\/accounts\/\S+\/builds\/\S+/)?.[0];
  if (!url) {
    await setStatus(id, 'fixed', {
      notify: `⚠️ ${id}: הבנייה לא יצאה לדרך. אריץ שוב בהמשך.`,
    });
    return;
  }
  await setStatus(id, 'released', {
    build: url,
    notify: `📦 ${id} — גרסה חדשה בדרך.\nפתחי בטלפון להתקנה (QR בדף):\n${url}`,
  });
  log(`v ${id}: build ${url}`);
}

async function tick(baseline) {
  const bugs = (await (await api('/admin/bugs')).json()).bugs || [];
  for (const bug of bugs.filter((b) => b.status === 'new')) await fixOne(bug, baseline);
  for (const bug of bugs.filter((b) => b.status === 'fixed' && b.buildRequested)) {
    await buildFor(bug);
  }
}

log(`lumi-bug-agent watching ${SERVER} · repo ${REPO}`);
const baseline = await tscErrors(REPO);
log(`tsc baseline: ${baseline} pre-existing errors`);
for (;;) {
  try {
    await tick(baseline);
  } catch (e) {
    log('tick failed:', e.message);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
