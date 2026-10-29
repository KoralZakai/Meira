/**
 * run-task-patch — a route refresh must not put a stale title back.
 * Bug (18.10): the server retitled a task; the phone, holding the old title,
 * recomputed its route and upserted the WHOLE row, undoing the retitle.
 *
 * Run:  npx tsx tests/run-task-patch.ts
 */
import { changedColumns } from '../src/utils/changedColumns';

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

const was = { userId: 'u', id: 't', text: 'old title', location: { a: 1 }, durationMinutes: 30 };
const now = { userId: 'u', id: 't', text: 'old title', location: { a: 2 }, durationMinutes: 30 };
const patch = changedColumns(was, now);
check('only the changed column goes up', JSON.stringify(Object.keys(patch)) === '["location"]');
check('the untouched title is not in the patch', !('text' in patch));
check('nothing changed -> empty patch', Object.keys(changedColumns(now, { ...now })).length === 0);
check('key columns are never patched', !('id' in changedColumns(was, { ...now, id: 'x' })));

if (failures) { console.error(`${failures} failed`); process.exit(1); }
