/**
 * The Ceva interview, 23/09/2026 — the event that was on her calendar and not
 * in her app.
 *
 * Two separate failures met in one Wednesday:
 *
 *  1. The event carries NO `location` field. Comeet/Spark Hire (and every
 *     other recruiting system that mails an invite) writes the address into
 *     the body beside a Google Maps link and leaves Google's own field empty.
 *     `addrOf` reads `location`, so the whole travel chain — geocode, route,
 *     leave-home time, wake alarm — was skipped without a word.
 *
 *  2. Every way the calendar call can fail arrived at the caller as `[]`, so
 *     "Google refused us" and "you have a free Wednesday" printed the same
 *     sentence in the Profile check.
 *
 * The payload below is the real event, as the Calendar API returned it.
 */
import assert from 'assert';
import { addressFromDescription } from '../src/utils/eventAddress';
import { isMeetingLink } from '../src/utils/meetingLink';

/** Verbatim from GET /calendar/v3/calendars/primary/events, 2026-09-21. */
const CEVA_DESCRIPTION =
  'Reply above to continue the conversation with CEVA Admin support. Sent by '
  + 'Spark Hire Recruit on behalf of Ceva  \n---  \n---  \nDear koral,  \n'
  + 'An in-person interview has been scheduled for you in Ceva.\n'
  + 'Please review the interview details below.\n​\n'
  + 'Position:C++ Software Engineer – AI & DSP Processor Simulators  \n---  \n'
  + '| Interview with Marika Klubakov (Core Simulator and Debugger Team Leader)  \n–  \n'
  + '|  Wednesday, September 23, 2026, 2:30 PM IDT  \n'
  + "|  7 HaPnina Street, Ra'anana, Center District  \n"
  + "Please arrive at the reception at HaPnina 7, Ra'anana, building D, 9th floor  \n"
  + '[ ](https://www.google.com/maps/place/7+HaPnina+Street%2C+Ra%27anana%2C+Center+District)  \n';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

console.log('\nThe interview that was invisible\n');

check('the Ceva invite yields the street it actually happens on', () => {
  const address = addressFromDescription(CEVA_DESCRIPTION);
  assert.ok(address, 'no address extracted — the route chain stays dead');
  assert.match(address!, /HaPnina/i);
  assert.match(address!, /Ra'anana/i);
});

check('the extracted address is a place, never a link', () => {
  const address = addressFromDescription(CEVA_DESCRIPTION)!;
  assert.equal(isMeetingLink(address), false, 'a URL would be geocoded and alarmed');
});

check('an event with no body is left alone', () => {
  assert.equal(addressFromDescription(''), undefined);
  assert.equal(addressFromDescription(undefined), undefined);
});

check('a Zoom invite is NOT turned into somewhere to drive', () => {
  const body = 'Join here: https://us02web.zoom.us/j/8412345678\nSee you then.';
  assert.equal(addressFromDescription(body), undefined);
});

check('"Location: <zoom link>" is refused as a place', () => {
  const body = 'Location: https://us02web.zoom.us/j/8412345678';
  assert.equal(addressFromDescription(body), undefined);
});

check('a labelled Hebrew address is read', () => {
  const body = 'שלום קורל,\nכתובת: רחוב יגאל אלון 98, תל אביב\nנתראה.';
  assert.equal(addressFromDescription(body), 'רחוב יגאל אלון 98, תל אביב');
});

check('a labelled English address is read', () => {
  const body = 'Hi,\nAddress: 7 HaPnina Street, Raanana\nBest';
  assert.equal(addressFromDescription(body), '7 HaPnina Street, Raanana');
});

check('a maps ?q= link is read too', () => {
  const body = 'Directions: https://maps.google.com/?q=Space+Gym%2C+Binyamina';
  assert.equal(addressFromDescription(body), 'Space Gym, Binyamina');
});

check('prose that merely mentions a city invents nothing', () => {
  const body = 'We are excited to meet you. Our offices are lovely this time of year.';
  assert.equal(addressFromDescription(body), undefined);
});

check('the maps link wins over a labelled line', () => {
  const body = 'Address: Head office, Tel Aviv\n'
    + 'https://www.google.com/maps/place/7+HaPnina+Street%2C+Ra%27anana';
  assert.match(addressFromDescription(body)!, /HaPnina/);
});

console.log(
  failures === 0
    ? '\nAll good — the interview has an address to travel to.\n'
    : `\n${failures} failing.\n`,
);
process.exit(failures === 0 ? 0 : 1);
