/**
 * run-today-local-first — Today draws the phone's copy, then the cloud, and a
 * failed cloud refresh is said.
 *
 * 19.10, "super slow": Today's load() awaited getTasksForDate — a download of
 * every task row from Supabase — and getSettings (another round trip) behind a
 * spinner, for a list the phone already held. Now the phone copy is drawn
 * first and the cloud read follows. The risk in that change is the silent-state
 * one: if the cloud cannot be read, the phone copy must not pass for the truth
 * without a word (rule 1).
 *
 * Wiring, not arithmetic, so the rule is checked on the source.
 *
 *   npx tsx tests/run-today-local-first.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

const src = fs.readFileSync(path.join(__dirname, '..', 'src/screens/TodaySchedule.tsx'), 'utf8');
const start = src.indexOf('const load = async (showSpinner = true)');
const end = src.indexOf('} finally {', start);
const load = src.slice(start, end);

console.log('\nToday: phone copy first, cloud second\n');
ok(start > 0 && end > start, 'found load()');

const iLocal = load.indexOf('getLocalTasks()');
const iCloud = load.indexOf('getAllTasksChecked()');
ok(iLocal > 0, 'load() reads the phone copy (getLocalTasks)');
ok(iCloud > 0, 'load() reads the cloud with its reason (getAllTasksChecked)');
ok(iLocal < iCloud, 'the phone copy is drawn BEFORE the cloud is awaited');
ok(/getLocalSettings\(\)/.test(load.slice(0, iCloud)),
  'first paint does not wait for cloud settings either');
ok(!/await\s+Promise\.all\(\[\s*getTasksForDate\(today\)/.test(load),
  'no full download behind the spinner any more');

const firstPaint = load.slice(iLocal, iCloud);
ok(/setLoading\(false\)/.test(firstPaint), 'the spinner ends on the phone copy');
ok(/if \(local\.length\)/.test(firstPaint),
  'an EMPTY phone copy keeps the spinner (an empty day would read as "nothing today")');

ok(/setTasksCloudError\(read\.cloudError\)/.test(load), 'the cloud read records its failure');
ok(/setTasksCloudError\(refreshed\.cloudError\)/.test(load), '…and so does the refresh after the calendar sync');
ok(/tasksCloudError \?/.test(src) && /לא הצלחתי לרענן/.test(src) && /Couldn't refresh/.test(src),
  'the failure is drawn, in Hebrew and English');

const code = load.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const downloads = (code.match(/getAllTasks\(\)|getTasksForDate\(today\)/g) ?? []).length;
ok(downloads <= 1, 'at most one plain getAllTasks left in load() (the week\'s alerts, served from the shared read)',
  `${downloads}`);

console.log(fail ? `\n❌ ${fail} failed\n` : '\n✅ all passed\n');
process.exit(fail ? 1 : 0);
