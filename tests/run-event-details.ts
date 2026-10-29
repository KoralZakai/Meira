/** Run: npx tsx tests/run-event-details.ts */
import { eventDetailsFromGoogle, plainText } from '../src/utils/eventDetails';
let fails = 0;
const check = (l: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ' — ' + d : ''}`); };

// A real-shaped Google event: Meet link, guests with answers, HTML body, a Drive attachment.
const ev = {
  summary: 'Interview — Nebius', htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  description: 'Hi Koral,<br>Please bring:<ul><li>CV</li><li>ID</li></ul>Address: Azrieli &amp; Co<br><a href="https://maps.google.com/?q=x">map</a>',
  location: 'Azrieli Center, Tel Aviv', organizer: { email: 'dana@nebius.com', displayName: 'Dana Levi' },
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }, { entryPointType: 'phone', uri: 'tel:+97212345', pin: '1234' }] },
  attendees: [
    { email: 'dana@nebius.com', displayName: 'Dana Levi', responseStatus: 'accepted', organizer: true },
    { email: 'koral@x.com', responseStatus: 'needsAction', self: true },
    { email: 'omer@nebius.com', displayName: 'Omer', responseStatus: 'declined' }],
  attachments: [{ title: 'Job spec', fileUrl: 'https://docs.google.com/d/1' }, { title: 'bad', fileUrl: 'javascript:alert(1)' }],
};
const d = eventDetailsFromGoogle(ev);
check('event link kept', d.url === 'https://www.google.com/calendar/event?eid=abc');
check('Meet link is the join link', d.joinUrl === 'https://meet.google.com/abc-defg-hij');
check('dial-in with pin', d.dialIn?.phone === '+97212345' && d.dialIn?.pin === '1234');
check('guest names + answers', d.guests[0].name === 'Dana Levi' && d.guests[0].answer === 'yes' && d.guests[2].answer === 'no' && d.guests[1].answer === 'none');
check('name falls back to the email handle', d.guests[1].name === 'koral');
check('organizer named', d.organizer?.name === 'Dana Levi');
check('HTML → readable lines', d.description.includes('• CV') && d.description.includes('Azrieli & Co') && !/<|&amp;/.test(d.description), JSON.stringify(d.description));
check('non-https attachment dropped', d.attachments.length === 1 && d.attachments[0].title === 'Job spec');

// A map link in the body is NOT a meeting (CLAUDE.md rule 8) and a plain event has no join link.
const plain = eventDetailsFromGoogle({ summary: 'Coffee', description: 'See https://maps.google.com/?q=Herzliya', location: 'Herzliya' });
check('map link in body is not a join link', plain.joinUrl === undefined);
check('http (not https) link refused', eventDetailsFromGoogle({ htmlLink: 'http://x.y' }).url === undefined);
check('empty event does not throw', eventDetailsFromGoogle({}).guests.length === 0 && eventDetailsFromGoogle(undefined).description === '');
check('description capped', plainText('x'.repeat(5000)).length === 2000);
process.exit(fails ? 1 : 0);
