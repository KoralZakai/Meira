/**
 * A Clalit confirmation SMS → date, hour, clinic — on the phone (utils/clalitSms).
 *
 * 27.10: Koral books at Clalit herself (no API, ID + SMS login) and shares the
 * confirmation to Meira. The parser must take the appointment, and must REFUSE
 * — with the reason — a cancellation, a past one, one with no hour, and any
 * text that is not Clalit's. The SMS bodies below follow Clalit's wording with
 * invented names; replace them with a real (redacted) one when we have it.
 */
import {
  clinicNamesSpecialty, isClinicBookingRequest, looksLikeClalitSms, parseClalitSms, parseFailText,
} from '../src/utils/clalitSms';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const section = (s: string) => console.log(`\n${s}`);

const NOW = new Date(2026, 9, 27, 10, 0);   // 27.10.2026 10:00

section('1. A confirmation is read');
const CONFIRM = 'כללית: שלום, נקבע לך תור לד"ר ישראל ישראלי, רפואת משפחה, ביום ה\' 30/10/2026 בשעה 09:40 במרפאת כללית רמת אביב, איינשטיין 40 תל אביב. לביטול השב 1';
const a = parseClalitSms(CONFIRM, NOW);
ok(a.ok, 'parsed');
if (a.ok) {
  ok(a.appt.date === '2026-10-30', `date 2026-10-30 (${a.appt.date})`);
  ok(a.appt.time === '09:40', `time 09:40 (${a.appt.time})`);
  ok(a.appt.doctor === 'ד"ר ישראל ישראלי', `doctor (${a.appt.doctor})`);
  ok(a.appt.specialty === 'רפואת משפחה', `specialty (${a.appt.specialty})`);
  ok(a.appt.clinic === 'כללית רמת אביב, איינשטיין 40 תל אביב', `clinic (${a.appt.clinic})`);
}

section('2. Short forms: dd.mm with no year, a two-digit year, ד״ר with gershayim');
const b = parseClalitSms('תזכורת מכללית: תור לד״ר כהן ב-4.11 בשעה 8:15 במרכז רפואי כללית חולון.', NOW);
ok(b.ok && b.appt.date === '2026-11-04' && b.appt.time === '08:15', `4.11 08:15 (${JSON.stringify(b)})`);
ok(b.ok && b.appt.doctor === 'ד"ר כהן', 'doctor כהן');
const c = parseClalitSms('Clalit: appointment with Dr. Levi on 05/01/27 at 14:30, clinic: Clalit Haifa', NOW);
ok(c.ok && c.appt.date === '2027-01-05' && c.appt.time === '14:30', `English, 05/01/27 (${JSON.stringify(c)})`);
const d = parseClalitSms('כללית: תור לבדיקת דם 2.1 בשעה 07:30', NOW);
ok(d.ok && d.appt.date === '2027-01-02', 'a day already gone this year → next year');

section('3. Refusals carry the reason');
const r = (t: string) => { const x = parseClalitSms(t, NOW); return x.ok ? 'ok' : x.reason; };
ok(r('מכבי: נקבע לך תור ב-30/10/2026 בשעה 09:40') === 'not_clalit', 'another fund → not_clalit');
ok(r('כללית: התור שלך לד"ר כהן ב-30/10/2026 בשעה 09:40 בוטל') === 'cancelled', 'cancelled');
ok(r('כללית: בוטל התור ל-30/10 09:40') === 'cancelled', 'בוטל התור');
ok(r(CONFIRM) === 'ok', '"לביטול השב 1" alone is NOT a cancellation');
ok(r('כללית: נקבע לך תור לד"ר כהן ב-30/10/2026') === 'no_time', 'no hour → no_time');
ok(r('כללית: נקבע לך תור לד"ר כהן בשעה 09:40') === 'no_date', 'no date → no_date');
ok(r('כללית: נקבע לך תור ב-27/10/2026 בשעה 09:00') === 'in_past', 'this morning, already gone → in_past');
ok(r('כללית: תור ב-31/02/2027 בשעה 09:00') === 'no_date', '31/02 is not a date');
for (const reason of ['not_clalit', 'cancelled', 'no_date', 'no_time', 'in_past'] as const) {
  ok(parseFailText(reason, true).length > 0 && parseFailText(reason, false).length > 0, `${reason}: says why, both languages`);
}

section('4. "Book me an appointment" is a booking ask, not a task');
for (const t of ['תקבעי לי תור לרופא', 'אני צריכה לקבוע תור לרופאת עור', 'לקבוע תור בכללית', 'תזמיני לי תור לבדיקת דם',
  'book me a doctor appointment', 'schedule a clinic appointment']) {
  ok(isClinicBookingRequest(t), `ask: ${t}`);
}
for (const t of ['תקבעי לי תור למספרה', 'לקבוע תור לשיעור', 'פגישה עם דנה מחר', 'book a table for two', CONFIRM]) {
  ok(!isClinicBookingRequest(t), `not an ask: ${t.slice(0, 40)}`);
}

section('5. A pasted SMS is recognised as one');
ok(looksLikeClalitSms(CONFIRM), 'the confirmation');
ok(!looksLikeClalitSms('תקבעי לי תור בכללית'), 'the ask is not an SMS');
ok(!looksLikeClalitSms('מה יש לי מחר?'), 'a question is not an SMS');

ok(looksLikeClalitSms('כללית: תוצאות הבדיקה שלך מ-20/10 זמינות באתר. ניתן לצפות בהן באזור האישי בכל עת, תודה ויום טוב'),
  'a long Clalit text with no "תור" still stays on the phone');
ok(!looksLikeClalitSms('מה השעות של כללית?'), 'a short question about Clalit goes on to the brain');

section('6. A clinic whose name says the specialty is not searched');
ok(clinicNamesSpecialty('מרכז בריאות הנפש כללית'), 'mental-health centre');
ok(clinicNamesSpecialty('מרכז בריאות האישה רמת גן'), "women's health centre");
ok(!clinicNamesSpecialty('כללית רמת אביב, איינשטיין 40 תל אביב'), 'a plain clinic is searched');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
