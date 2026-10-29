/** Run: npx tsx tests/run-source-link.ts */
import { sourceLinkOf } from '../src/utils/sourceLink';
import { briefFor } from '../src/utils/clashTradeoffs';
let fails = 0;
const check = (l: string, ok: boolean) => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const g: any = { id: 'gcal-abc123', calendarEventId: 'abc123', date: '2026-10-27' };
const l1 = sourceLinkOf(g, 'koral@x.com')!;
check('google event with account → exact event', l1.kind === 'google-event' && l1.url.includes('eid=' + Buffer.from('abc123 koral@x.com').toString('base64url')));
const l2 = sourceLinkOf(g)!;
check('google event w/o account → says it is the DAY', l2.kind === 'google-day' && l2.url.endsWith('/2026/10/27'));
check('gmail thread', sourceLinkOf({ id: 't1', gmailThreadId: '18c0ffee' } as any)!.kind === 'gmail');
check('outlook recurring id loses @date', sourceLinkOf({ id: 'ocal-AAMk=@2026-10-27' } as any)!.url.endsWith('AAMk%3D'));
check('device calendar / manual → none (not a fake link)', sourceLinkOf({ id: 'dcal-9' } as any) === null && sourceLinkOf({ id: 'x' } as any) === null);
check('outlook-namespaced calendarEventId is not read as google', sourceLinkOf({ id: 'gcal-1', calendarEventId: 'outlook:1' } as any, 'a@b.c') === null);

const iv: any = { id: 'gcal-i', text: 'Interview Nebius', category: 'interview', priority: 'must', fixedTime: '10:00', durationMinutes: 60, location: { address: 'Haifa', travelMinutes: 70 }, attendees: ['a@b.c', 'd@e.f'] };
const gym: any = { id: 'm1', text: 'Gym', category: 'gym', fixedTime: '10:00', durationMinutes: 60 };
const b = briefFor(iv, gym);
check('summary names place and trip', b.summary.en.includes('Haifa') && b.summary.en.includes('70 min'));
check('dropping her own gym = movable', b.costs[0].en.includes('can move'));
const c = briefFor(gym, iv);
check('dropping the interview warns about other people + must', c.costs.length >= 3);
check('both languages filled', [...b.costs, ...c.costs, ...b.gains].every((x) => x.en && x.he));
process.exit(fails ? 1 : 0);
