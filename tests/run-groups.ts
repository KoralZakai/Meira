/**
 * run-groups — "find time together", phone side (Feature 3, 20.10).
 *
 * The grid's marks (? never drawn as ✗, the reason under every ?), the slot list
 * sent to the server (past/malformed/duplicate refused, max 6), the share message,
 * and the tick (a new invite once, one reminder after 24h). Pure — no device.
 *
 * Run:  npx tsx tests/run-groups.ts
 */
import {
  bestLabel, cellMark, cellNote, inviteMessage, inviteNotices, slotLabel, validSlots,
} from '../src/utils/groupGrid';
import type { GroupListItem } from '../src/services/LumiServer';

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed += 1;
}

check('slot label he', slotLabel({ day: '2026-10-23', start: '20:00' }, true) === 'שישי 23.10 20:00');
check('slot label en', slotLabel({ day: '2026-10-24', start: '20:30' }, false) === 'Sat 24.10 20:30');

check('yes is ✓', cellMark({ slotId: 's', value: 'yes', source: 'auto' }) === '✓');
check('no is ✗', cellMark({ slotId: 's', value: 'no', source: 'manual' }) === '✗');
check('unknown is ? — never ✗', cellMark({ slotId: 's', value: 'unknown', source: 'no_data' }) === '?');
check("couldn't check says so", cellNote({ slotId: 's', value: 'unknown', source: 'no_data' }, false) === "couldn't check");
check('waiting says so (he)', cellNote({ slotId: 's', value: 'unknown', source: 'waiting' }, true) === 'ממתין');
check('her own answer is marked as said', cellNote({ slotId: 's', value: 'yes', source: 'manual' }, true) === 'אמר/ה');
check("Meira's check carries no note", cellNote({ slotId: 's', value: 'yes', source: 'auto' }, false) === '');

const vs = validSlots([
  { day: '2026-10-24', start: '20:30' }, { day: '2026-10-23', start: '20:00' },
  { day: '2026-10-23', start: '20:00' }, { day: '2026-10-01', start: '20:00' }, { day: '2026-10-23', start: '25:00' },
], '2026-10-21');
check('slots: sorted, deduped, past and malformed refused',
  JSON.stringify(vs) === JSON.stringify([{ day: '2026-10-23', start: '20:00' }, { day: '2026-10-24', start: '20:30' }]));
check('slots: at most 6', validSlots(Array.from({ length: 9 }, (_, i) => ({ day: '2026-10-25', start: `1${i}:00` })), '2026-10-21').length === 6);

const msg = inviteMessage('מסיבה', 'https://x/g/abc', 'קורל', true);
check('share message names the event, the organizer and the link', msg.includes('מסיבה') && msg.includes('קורל') && msg.includes('https://x/g/abc'));
check('share message in English', inviteMessage('party', 'https://x/g/abc', '', false).startsWith('finding a time for party'));

const slots = [{ id: 'a', day: '2026-10-23', start: '20:00' }, { id: 'b', day: '2026-10-24', start: '20:30' }];
check('lock button names the best slot', bestLabel(slots, 'b', true) === 'לקבוע לשבת 24.10 20:30');
check('no best → no lock button', bestLabel(slots, null, false) === null);

const now = Date.parse('2026-10-22T12:00:00Z');
const g = (id: string, extra: Partial<GroupListItem>): GroupListItem => ({
  id, title: id, minutes: 120, status: 'open', role: 'member', myStatus: 'invited',
  createdAt: '2026-10-22T10:00:00Z', ...extra,
});
const list = [
  g('new', {}),
  g('old', { createdAt: '2026-10-21T08:00:00Z' }),
  g('joined', { myStatus: 'joined' }),
  g('mine', { role: 'owner', myStatus: 'joined' }),
  g('closed', { status: 'locked' }),
];
const first = inviteNotices(list, {}, now);
check('a new invite is told once', first.fresh.map((x) => x.id).join() === 'new,old');
check('nothing is reminded before it was told', first.remind.length === 0);
const later = inviteNotices(list, { invites: ['new', 'old'] }, now);
check('told + 24h unanswered → one reminder', later.fresh.length === 0 && later.remind.map((x) => x.id).join() === 'old');
check('reminded once only', inviteNotices(list, { invites: ['new', 'old'], reminded: ['old'] }, now).remind.length === 0);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall group rules hold');
