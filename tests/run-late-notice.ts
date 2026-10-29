/**
 * run-late-notice — the running-late draft: how late, when, to whom; never sent by Meira.
 *
 * Run:  npx tsx tests/run-late-notice.ts
 */
import { lateNotice, lateText } from '../src/utils/lateNotice';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const task = (o: Partial<Task>): Task => ({
  id: 'x', text: 'פגישה', category: 'meeting', priority: 'must', isFixed: true, durationMinutes: 60,
  date: '2026-10-28', status: 'pending', createdAt: 0, historicalDurations: [], fixedTime: '17:00', ...o,
} as Task);

const he = lateText(12, '17:12', true);
check('Hebrew says how late and when', he.includes('12 דק׳') && he.includes('17:12'), he);
check('English says how late and when', lateText(12, '17:12', false).includes('12 min') && lateText(12, '17:12', false).includes('17:12'));
check('never "0 minutes late"', lateText(0.2, '17:00', true).includes('1 דק׳'));

const withPhone = lateNotice(task({ contact: { name: 'יוסי', phone: '050-123-4567' } as any }), 12, '17:12', true);
check('a contact with a number → wa.me to them', withPhone.url.startsWith('https://wa.me/972501234567?text='), withPhone.url);
check('…and names them', withPhone.to === 'יוסי');
check('the text is in the link, encoded', decodeURIComponent(withPhone.url.split('text=')[1]) === withPhone.text);

const noPhone = lateNotice(task({}), 5, '17:05', false);
check('no number → WhatsApp opens to pick a chat', noPhone.url.startsWith('whatsapp://send?text='), noPhone.url);
check('…and names nobody', noPhone.to === '');
const junk = lateNotice(task({ contactPhone: '12' } as any), 5, '17:05', false);
check('a junk number is not dialled — she picks the chat', junk.url.startsWith('whatsapp://send'), junk.url);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
