/**
 * run-add-conclusions — what the app does with Meira's conclusions.
 *
 * The server says WHAT follows from a sentence; the phone builds the HOW, from
 * what only the phone knows. What must hold:
 *   - the WhatsApp link is built from the CONTACT's number (any Israeli
 *     spelling of it), carries the greeting URL-encoded, and a junk number
 *     yields no link at all — never a chat with a stranger;
 *   - a reminder "the day before" / "at noon" lands on a real date and hour,
 *     never in the past, and never for an event that is already over;
 *   - the server is asked after a pause, when the sense of the sentence moved,
 *     at most twice, and once the allowance says no it is not asked again;
 *   - a conclusion this build cannot act on is dropped, not drawn as a dead button.
 *
 * Run:  npx tsx tests/run-add-conclusions.ts
 */
import {
  waLink, whatsappDigits, reminderSlot, shouldAsk, freshAskState, sanitizeConclusions,
  understandFailureLine, ASK_MAX_CALLS,
} from '../src/utils/addConclusions';
import { liveParse, parseSignature } from '../src/utils/liveParse';
import { looksLikeErrand, placelessErrands } from '../src/utils/addSuggestions';
import type { Task } from '../src/types/index';

const realLog = console.log;
console.log = () => {};
let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  realLog(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(label, ok, ok ? '' : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

// Saturday 17 October 2026, 14:00.
const NOW = new Date(2026, 9, 17, 14, 0, 0);
const parse = (t: string) => liveParse(t, { now: NOW, language: /[א-ת]/.test(t) ? 'he' : 'en' });

realLog('\nWhatsApp link');
eq('Israeli local, dashes', whatsappDigits('050-123-4567'), '972501234567');
eq('Israeli local, plain', whatsappDigits('0501234567'), '972501234567');
eq('mobile written without the zero', whatsappDigits('501234567'), '972501234567');
eq('international with plus', whatsappDigits('+972 50 123 4567'), '972501234567');
eq('international with 00', whatsappDigits('00972501234567'), '972501234567');
eq('a foreign number keeps its own code', whatsappDigits('+1 (415) 555-2671'), '14155552671');
eq('junk is no number', [whatsappDigits('abc'), whatsappDigits('12'), whatsappDigits(''), whatsappDigits(undefined)], [null, null, null, null]);
eq('the link', waLink('050-123-4567', 'Happy birthday Dad!'), 'https://wa.me/972501234567?text=Happy%20birthday%20Dad!');
eq('Hebrew and an emoji survive the URL', waLink('0501234567', 'יום הולדת שמח אבא 🎂'),
  `https://wa.me/972501234567?text=${encodeURIComponent('יום הולדת שמח אבא 🎂')}`);
check('a "&" in the greeting cannot cut the message short', /text=a%26b$/.test(waLink('0501234567', 'a&b')!));
eq('no usable number → no link at all', waLink('n/a', 'hi'), null);

realLog('\nReminder slots');
{
  const party = { date: '2026-10-20', time: '20:00' };
  eq('the day before → 17:00 on the 19th', reminderSlot('day_before', party, NOW), { date: '2026-10-19', time: '17:00' });
  eq('the evening before → 19:00', reminderSlot('evening_before', party, NOW), { date: '2026-10-19', time: '19:00' });
  eq('noon of → 12:00 that day', reminderSlot('noon_of', party, NOW), { date: '2026-10-20', time: '12:00' });
  eq('morning of → 09:00', reminderSlot('morning_of', party, NOW), { date: '2026-10-20', time: '09:00' });
  eq('an hour before', reminderSlot('one_hour_before', party, NOW), { date: '2026-10-20', time: '19:00' });
  eq('noon for an 11:00 event is not after the event', reminderSlot('noon_of', { date: '2026-10-20', time: '11:00' }, NOW),
    { date: '2026-10-20', time: '10:00' });
  eq('an event with no hour: an hour-before falls back to morning', reminderSlot('one_hour_before', { date: '2026-10-20' }, NOW),
    { date: '2026-10-20', time: '09:00' });
  const tonight = reminderSlot('day_before', { date: '2026-10-17', time: '20:00' }, NOW);
  eq('the day before a party that is TONIGHT has passed: soon, and flagged', tonight, { date: '2026-10-17', time: '14:05', moved: true });
  eq('an event already over → nothing to remind about', reminderSlot('morning_of', { date: '2026-10-17', time: '13:00' }, NOW), null);
  eq('a yesterday event → nothing', reminderSlot('day_before', { date: '2026-10-10' }, NOW), null);
  eq('the soon-slot never lands after the event', reminderSlot('day_before', { date: '2026-10-17', time: '14:03' }, NOW), null);
}

realLog('\nWhen to ask the server');
{
  const bday = parse("dad's birthday party at 20:00");
  const st = freshAskState();
  eq('a birthday sentence earns a call', shouldAsk("dad's birthday party at 20:00", bday, st).ask, true);
  eq('too short is not asked', shouldAsk('dad bd', parse('dad bd'), st).why, 'too_short');
  eq('"buy milk tomorrow" has nothing for the server to add',
    shouldAsk('buy milk tomorrow morning', parse('buy milk tomorrow morning'), st).why, 'nothing_to_add');
  eq('"call mom tomorrow" neither (a person is not an occasion)',
    shouldAsk('call mom tomorrow at 9', parse('call mom tomorrow at 9'), st).why, 'nothing_to_add');
  eq('"gift" alone is the errand, not a celebration', shouldAsk('buy a gift for the office', parse('buy a gift for the office'), st).why, 'nothing_to_add');
  const interview = parse('interview Sunday 13:30 at Rafael David Institute, algorithm engineer');
  eq('an interview earns a call (code answers it for free)',
    shouldAsk('interview Sunday 13:30 at Rafael David Institute, algorithm engineer', interview, st).ask, true);

  const t1 = "dad's birthday party at 20:00";
  const after1 = { ...st, calls: 1, lastText: t1, lastSignature: 'x' };
  eq('the very same text is not asked twice', shouldAsk(t1, bday, { ...after1, lastSignature: '' }).why, 'unchanged');
  const sameSense = { ...st, calls: 1, lastText: "dad's birthday party at 20:0", lastSignature: JSON.stringify('') };
  const sig = parseSignature;
  eq('another letter of the same sense is not asked', shouldAsk(t1, bday, { ...sameSense, lastSignature: sig(bday) }).why, 'same_sense');
  const moved = parse("dad's birthday party at 21:00 on Friday");
  eq('a new time and day IS a new sense', shouldAsk("dad's birthday party at 21:00 on Friday", moved, { ...sameSense, lastSignature: sig(bday) }).ask, true);
  eq(`never more than ${ASK_MAX_CALLS} calls`, shouldAsk("dad's birthday party at 21:00 on Friday", moved, { ...sameSense, calls: ASK_MAX_CALLS, lastSignature: sig(bday) }).why, 'max_calls');
  eq('once the allowance said no, it is not asked again this flow',
    shouldAsk("dad's birthday party at 21:00 on Friday", moved, { ...st, blocked: 'ai_limit' }).why, 'blocked:ai_limit');
}

realLog('\nWhat the server sends is checked, not trusted');
{
  const good = {
    kind: 'reminder', text_he: '🎁 לקנות מתנה', text_en: '🎁 Buy a gift',
    action: { type: 'add_reminder', when: 'day_before' },
  };
  const list = [
    good,
    { kind: 'wire_money', text_he: 'x', text_en: 'x', action: { type: 'none' } },
    { kind: 'greeting', text_he: 'x', text_en: 'x', action: { type: 'self_destruct' } },
    { kind: 'reminder', text_he: 'x', text_en: 'x', action: { type: 'add_reminder' } },          // no "when"
    { kind: 'reminder', text_he: 'x', text_en: 'x', action: { type: 'add_reminder', when: '17:30' } },
    { kind: 'interview', text_he: '📄', text_en: '📄', action: { type: 'none' } },
    { kind: 'whatsapp_send', text_he: '💬', text_en: '💬', action: { type: 'open_whatsapp', needs_contact: true } },
    { kind: 'greeting', text_he: 5, text_en: 'x', action: { type: 'show_greeting' } },
    null,
  ];
  const out = sanitizeConclusions(list);
  eq('only what this build can act on survives', out.map((c) => c.kind), ['reminder', 'interview', 'whatsapp_send']);
  eq('needs_contact is carried', out[2].action.needs_contact, true);
  eq('a non-list is nothing', sanitizeConclusions('oops'), []);
  check('the failure line is bilingual and says the way forward',
    /כרגיל/.test(understandFailureLine('model_unavailable', true)) && /as usual/.test(understandFailureLine('model_unavailable', false)));
  check('an allowance that is used up reads differently from a dead model',
    understandFailureLine('ai_limit', false) !== understandFailureLine('model_unavailable', false));
}

realLog('\nErrands on the way: which open tasks are worth asking about');
{
  const mk = (over: Partial<Task>): Task => ({
    id: 'x', text: 'x', category: 'general', priority: 'need_to', isFixed: false,
    durationMinutes: 30, date: '2026-10-17', status: 'pending', createdAt: 0, historicalDurations: [], ...over,
  } as Task);
  for (const t of ['לתקן את מכונת הקפה', 'laundry', 'כביסה', 'pick up the parcel', 'לקנות חלב', 'buy batteries', 'שטיפת רכב', 'haircut']) {
    check(`errand: ${t}`, looksLikeErrand(t));
  }
  for (const t of ['write the report', 'call mom', 'ללמוד לבחינה', 'gym']) {
    check(`not an errand: ${t}`, !looksLikeErrand(t));
  }
  const tasks = [
    mk({ id: 'a', text: 'laundry' }),
    mk({ id: 'b', text: 'post office', location: 'Dizengoff 5' }),
    mk({ id: 'c', text: 'fix the printer', status: 'complete' }),
    mk({ id: 'd', text: 'buy milk', location: { address: '', lat: 0, lng: 0, confirmed: false } as any }),
    mk({ id: 'e', text: 'write the report' }),
  ];
  eq('placeless, pending, errand-shaped only', placelessErrands(tasks).map((t) => t.id), ['a', 'd']);
}

console.log = realLog;
realLog(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
