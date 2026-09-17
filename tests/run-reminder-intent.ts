/**
 * run-reminder-intent — does Lumi tell a REMINDER apart from a TASK?
 *
 * The bug this locks down: "private class at 16:30" was saved with no alert,
 * and the follow-up "notify me at 16:00" was saved as a TASK called
 * "notify me at 16:00". Both in Hebrew and English.
 *
 * Pure pattern-level test — no storage, no notifications, no network — so it
 * runs anywhere and is fast. It exercises the same regexes and the same
 * minute/lead maths that LumiCoachEngine.handleReminderRequest uses.
 *
 * Run:  npx tsx tests/run-reminder-intent.ts
 */
import { resolveLeadMinutes, describeLead, DAY } from '../src/utils/leadTime';

// ── the patterns under test (kept in sync with LumiCoachEngine) ──────────────
const REMIND_TRIGGER_RE =
  /\b(remind|notify|ping|alert)\s+me\b|\bset\s+(?:an?\s+)?(?:alarm|reminder)\b|(?:^|\s)(?:תזכיר[יי]?\s+לי|תתריע[יי]?\s+לי|תתריעי?\s+לי|שים\s+לי\s+(?:התראה|תזכורת)|שימי\s+לי\s+(?:התראה|תזכורת)|קבע[יי]?\s+(?:לי\s+)?(?:התראה|תזכורת)|תשלח[יי]?\s+לי\s+תזכורת|תעדכן[יי]?\s+אותי)(?:\s|$)/i;
const AT_TIME_RE = /(?:\bat\b|\bfor\b|@|בשעה|לשעה|ב-)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;
const LEAD_BEFORE_RE =
  /(?:(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|דקות|דקה|דק'?|שעות|שעה)|half\s+an\s+hour|חצי\s+שעה|an?\s+hour|שעה)\s*(?:before|earlier|ahead|לפני|קודם|מראש)/i;

type Verdict = 'reminder_at' | 'lead_time' | 'task';

/** The routing decision, mirroring coachTurn's order of checks. */
function classify(input: string): { verdict: Verdict; time?: string; minutes?: number } {
  if (REMIND_TRIGGER_RE.test(input)) {
    const lead = input.match(LEAD_BEFORE_RE);
    if (lead) {
      const minutes = lead[1]
        ? parseInt(lead[1], 10) * (/hour|hr|שע/i.test(lead[2] || '') ? 60 : 1)
        : /half|חצי/i.test(lead[0]) ? 30 : 60;
      return { verdict: 'lead_time', minutes };
    }
    const at = input.match(AT_TIME_RE);
    if (at) {
      let h = parseInt(at[1], 10);
      const m = at[2] ? parseInt(at[2], 10) : 0;
      const mer = (at[3] || '').toLowerCase();
      if (/p/.test(mer) && h < 12) h += 12;
      if (/a/.test(mer) && h === 12) h = 0;
      if (h <= 23 && m <= 59) {
        return { verdict: 'reminder_at', time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
      }
    }
  }
  return { verdict: 'task' };
}

interface Case { input: string; want: Verdict; time?: string; minutes?: number; note?: string }

const CASES: Case[] = [
  // ── the reported bug, both languages ──
  { input: 'notify me at 16:00', want: 'reminder_at', time: '16:00', note: 'THE bug report' },
  { input: 'תתריע לי ב-16:00', want: 'reminder_at', time: '16:00', note: 'THE bug report (he)' },
  { input: 'תזכיר לי ב-16:00', want: 'reminder_at', time: '16:00' },
  { input: 'תזכירי לי בשעה 8', want: 'reminder_at', time: '08:00' },
  { input: 'remind me at 4pm', want: 'reminder_at', time: '16:00' },
  { input: 'set an alarm for 6:30', want: 'reminder_at', time: '06:30' },
  { input: 'שים לי התראה ב-21:45', want: 'reminder_at', time: '21:45' },
  { input: 'ping me at 12:15', want: 'reminder_at', time: '12:15' },
  { input: 'remind me at 12am', want: 'reminder_at', time: '00:00', note: 'midnight, not noon' },

  // ── lead time relative to a task ──
  { input: 'remind me 30 minutes before', want: 'lead_time', minutes: 30, note: 'the ask from the report' },
  { input: 'תזכיר לי חצי שעה לפני', want: 'lead_time', minutes: 30 },
  { input: 'תזכיר לי 45 דקות לפני', want: 'lead_time', minutes: 45 },
  { input: 'remind me 2 hours before', want: 'lead_time', minutes: 120 },
  { input: 'תתריע לי שעה קודם', want: 'lead_time', minutes: 60 },

  // ── genuine tasks that must NOT become reminders ──
  { input: 'remind me to buy milk', want: 'task', note: 'no time → a real task' },
  { input: 'תזכיר לי לקנות חלב', want: 'task' },
  { input: 'private class at 16:30', want: 'task', note: 'an event, not a reminder' },
  { input: 'שיעור פרטי ב-16:30', want: 'task' },
  { input: 'gym tomorrow at 19:00', want: 'task' },
  { input: 'פגישה במגדלי אמזון ב-10:00', want: 'task' },
];

let failed = 0;
console.log('\nLumi reminder-intent evaluation\n' + '─'.repeat(70));
for (const c of CASES) {
  const got = classify(c.input);
  const okKind = got.verdict === c.want;
  const okTime = c.time === undefined || got.time === c.time;
  const okMins = c.minutes === undefined || got.minutes === c.minutes;
  const ok = okKind && okTime && okMins;
  if (!ok) failed++;
  const detail = got.time ? ` → ${got.time}` : got.minutes ? ` → ${got.minutes}m before` : '';
  console.log(
    `${ok ? '✅' : '❌'} ${c.input.padEnd(34)} ${got.verdict.padEnd(12)}${detail}` +
    (ok ? (c.note ? `   (${c.note})` : '') : `   WANTED ${c.want}${c.time ? ' ' + c.time : ''}${c.minutes ? ' ' + c.minutes + 'm' : ''}`),
  );
}

// ── lead-time defaults: the day-before heads-up the user asked for ──
console.log('\n' + '─'.repeat(70) + '\ncategory defaults\n');
for (const category of ['interview', 'doctor', 'class', 'gym', 'call'] as const) {
  const leads = resolveLeadMinutes({ category });
  console.log(`  ${category.padEnd(12)} ${leads.map((m) => describeLead(m, false)).join(' · ')}`);
}
for (const category of ['interview', 'doctor'] as const) {
  if (!resolveLeadMinutes({ category }).some((m) => m >= DAY)) {
    console.log(`❌ ${category} has no day-before heads-up`);
    failed++;
  }
}
// An explicit request always wins over the category default.
const explicit = resolveLeadMinutes({ category: 'interview', remindMinutesBefore: [30] });
if (explicit.length !== 1 || explicit[0] !== 30) {
  console.log(`❌ explicit remindMinutesBefore ignored: got ${explicit.join(',')}`);
  failed++;
}

console.log('\n' + '─'.repeat(70));
console.log(failed === 0 ? `✅ all ${CASES.length} intent cases passed` : `❌ ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
