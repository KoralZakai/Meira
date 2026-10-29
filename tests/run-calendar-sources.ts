/**
 * run-calendar-sources — the phone's calendars and Outlook/Teams land as the
 * same kind of task Google does, and the same meeting seen twice lands once.
 *
 * Payloads are the real shapes: Graph's calendarView item (UTC times with no
 * offset and seven fractional digits, "Microsoft Teams Meeting" as location)
 * and an expo-calendar Android row.
 *
 * Run:  TZ=Asia/Jerusalem npx tsx tests/run-calendar-sources.ts
 */
import { graphEventToCalendarEvent } from '../src/utils/graphEvent';
import { deviceEventToCalendarEvent } from '../src/utils/deviceEvent';
import {
  calendarEventToTask, withoutDuplicates, isOnlineOnlyPlace, providerOfTaskId, calendarTaskId,
} from '../src/utils/calendarEventTask';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

console.log('\nGraph (Outlook / Teams)');
const teams = graphEventToCalendarEvent({
  id: 'AAMkAGI2TG93AAA=',
  subject: 'Sprint review',
  start: { dateTime: '2026-09-30T07:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-30T07:45:00.0000000', timeZone: 'UTC' },
  location: { displayName: 'Microsoft Teams Meeting', locationType: 'default' },
  bodyPreview: 'Join on your computer, mobile app or room device ...',
  isAllDay: false,
  isCancelled: false,
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc' },
  organizer: { emailAddress: { name: 'Dana', address: 'dana@corp.com' } },
  attendees: [{ emailAddress: { address: 'koral@corp.com' } }],
  responseStatus: { response: 'accepted' },
});
check('UTC 07:00 is 10:00 in Israel, not 07:00', teams?.event.startTime === '10:00', teams?.event.startTime);
check('end 10:45', teams?.event.endTime === '10:45', teams?.event.endTime);
check('date is the local day', teams?.date === '2026-09-30', teams?.date);
check('Teams join link kept', /teams\.microsoft\.com/.test(teams?.event.meetingUrl || ''));
check('organiser read', teams?.event.organizer === 'dana@corp.com');
const teamsTask: any = teams && calendarEventToTask(teams.event, teams.date, 'outlook');
check('"Microsoft Teams Meeting" is NOT a place → no journey', !teamsTask?.location && teamsTask?.hasLocation === false,
  String(teamsTask?.location));
check('id is namespaced ocal-', teamsTask?.id === 'ocal-AAMkAGI2TG93AAA=', teamsTask?.id);
check('calendarEventId namespaced', teamsTask?.calendarEventId === 'outlook:AAMkAGI2TG93AAA=');
check('provider read back off the id', providerOfTaskId(teamsTask?.id) === 'outlook');

const office = graphEventToCalendarEvent({
  id: 'X2', subject: 'Interview with Rafael',
  start: { dateTime: '2026-10-08T11:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-08T13:00:00.0000000', timeZone: 'UTC' },
  location: { displayName: 'Rafael HQ', address: { street: 'Derech HaAtsmaut 1', city: 'Haifa' } },
  isAllDay: false, isCancelled: false, responseStatus: { response: 'organizer' },
});
const officeTask: any = office && calendarEventToTask(office.event, office.date, 'outlook');
check('in-person venue + street kept', officeTask?.location === 'Rafael HQ, Derech HaAtsmaut 1, Haifa', officeTask?.location);
check('interview recognised from the title', officeTask?.category === 'interview' && officeTask?.priority === 'must',
  `${officeTask?.category}/${officeTask?.priority}`);
check('90-minute block', officeTask?.durationMinutes === 90);

check('declined meeting is not in her day', graphEventToCalendarEvent({
  id: 'd', subject: 'Optional sync', start: { dateTime: '2026-09-30T08:00:00', timeZone: 'UTC' },
  end: { dateTime: '2026-09-30T09:00:00', timeZone: 'UTC' }, responseStatus: { response: 'declined' },
}) === null);
check('cancelled skipped', graphEventToCalendarEvent({
  id: 'c', subject: 'x', isCancelled: true, start: { dateTime: '2026-09-30T08:00:00', timeZone: 'UTC' },
}) === null);
// 29.10: an all-day event is a WHOLE DAY (no hour → no invented midnight alarm), not dropped.
const holiday = graphEventToCalendarEvent({
  id: 'a', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-09-30T00:00:00', timeZone: 'UTC' },
  end: { dateTime: '2026-10-03T00:00:00', timeZone: 'UTC' },
});
check('all-day Outlook event → a whole-day range, no hour', holiday?.event.allDay === true
  && holiday?.event.startDate === '2026-09-30' && holiday?.event.endDate === '2026-10-02' && holiday?.event.startTime === '');
const holidayTask: any = holiday && calendarEventToTask(holiday.event, holiday.date, 'outlook');
check('…its task has no fixed time (so no alarm, no route)', holidayTask?.allDay === true && !holidayTask?.fixedTime && !holidayTask?.isFixed);

console.log('\nPhone calendar (expo-calendar, Android)');
const local = (h: number, m: number, day = 30) => new Date(2026, 8, day, h, m).toISOString();
const dev = deviceEventToCalendarEvent({
  id: '412', title: 'Dentist', startDate: local(16, 0), endDate: local(16, 45), allDay: false,
  status: 'CONFIRMED', location: 'Ibn Gabirol 30, Tel Aviv', notes: '', organizerEmail: 'clinic@x.co',
});
check('local 16:00 stays 16:00', dev?.event.startTime === '16:00' && dev?.event.endTime === '16:45',
  `${dev?.event.startTime}-${dev?.event.endTime}`);
const devTask: any = dev && calendarEventToTask(dev.event, dev.date, 'device', { calendarName: 'Samsung' });
check('address kept → journey', devTask?.location === 'Ibn Gabirol 30, Tel Aviv');
check('category doctor-ish from "Dentist"', devTask?.category === 'doctor', devTask?.category);
check('dcal- id', devTask?.id === 'dcal-412');
check('recurring device event keyed by date', calendarTaskId('device', '77', '2026-10-06', true) === 'dcal-77@2026-10-06');
const bday = deviceEventToCalendarEvent({
  id: '1', title: 'Birthday', startDate: '2026-10-06T00:00:00.000Z', endDate: '2026-10-07T00:00:00.000Z', allDay: true,
});
check('all-day device event → one whole day (UTC midnight, end exclusive)', bday?.event.allDay === true
  && bday?.date === '2026-10-06' && bday?.event.endDate === undefined);
check('cancelled device occurrence skipped', deviceEventToCalendarEvent({
  id: '2', title: 'Class', startDate: local(9, 0), endDate: local(10, 0), status: 'CANCELED',
}) === null);
const late = deviceEventToCalendarEvent({
  id: '3', title: 'Party', startDate: local(22, 0), endDate: local(2, 0, 31),
});
check('past midnight ends 23:59 on its own day', late?.event.endTime === '23:59' && late?.date === '2026-09-30');
const zoomNotes = deviceEventToCalendarEvent({
  id: '4', title: 'Call with Tom', startDate: local(11, 0), endDate: local(11, 30),
  location: 'Zoom', notes: 'Join https://us02web.zoom.us/j/123456 — map https://maps.google.com/?q=x',
});
const zoomTask: any = zoomNotes && calendarEventToTask(zoomNotes.event, zoomNotes.date, 'device');
check('"Zoom" as location is not a place', !zoomTask?.location);
check('zoom link from notes, not the map link', /zoom\.us/.test(zoomTask?.meetingUrl || ''), zoomTask?.meetingUrl);

console.log('\nOnline-only places');
for (const s of ['Microsoft Teams Meeting', 'Teams', 'zoom', 'Google Meet', 'Online', 'אונליין', 'https://meet.google.com/abc-defg-hij']) {
  check(`"${s}" is online-only`, isOnlineOnlyPlace(s));
}
for (const s of ['Teams Cafe, Dizengoff 50', 'Azrieli Center, Tel Aviv', 'Zoom Studio, Herzl 3']) {
  check(`"${s}" is a real place`, !isOnlineOnlyPlace(s));
}

console.log('\nThe same meeting through two doors');
const g = { id: 'gcal-abc', date: '2026-09-30', fixedTime: '10:00', text: 'Sprint review' };
const o = { id: 'ocal-XYZ', date: '2026-09-30', fixedTime: '10:00', text: 'Sprint Review!' };
const other = { id: 'ocal-Q', date: '2026-09-30', fixedTime: '10:00', text: 'Dentist' };
const r1 = withoutDuplicates([o, other], [g]);
check('Outlook copy of a Google meeting dropped', r1.duplicates.length === 1 && r1.duplicates[0].id === 'ocal-XYZ');
check('a different meeting at the same hour survives', r1.kept.some((t) => t.id === 'ocal-Q'));
const r2 = withoutDuplicates([g], [g]);
check('a re-sync of the same id is kept (reconcile owns it)', r2.kept.length === 1);
const r3 = withoutDuplicates([{ ...o, fixedTime: '10:30' }], [g]);
check('same title, different hour = two meetings', r3.kept.length === 1);
const r4 = withoutDuplicates([o, { ...o, id: 'dcal-9' }], []);
check('two calendars in one batch → one', r4.kept.length === 1 && r4.duplicates.length === 1);
const r5 = withoutDuplicates([{ ...o, text: 'Standup' }], [{ ...g, text: 'Stand' }]);
check('short titles need an exact match', r5.kept.length === 1);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
