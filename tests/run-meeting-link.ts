/**
 * run-meeting-link — a video call must never be given a bus route or an alarm.
 *
 * Google Calendar puts the join URL wherever the organiser typed it, and very
 * often that is `location`. Lumi treats `location` as somewhere to travel to:
 * it geocodes it, asks Directions for a route, works out a leave-home time and
 * sets a WAKE ALARM. Reported from a real day — a Zoom call was given travel
 * planning, which is wrong in the most disruptive way available.
 *
 * dayPlanning.addrOf is the single point every route flows through, so the
 * decisive assertion is that it refuses a URL.
 *
 * Run:  npx tsx tests/run-meeting-link.ts
 */
import { addrOf } from '../src/utils/dayPlanning';
import {
  isMeetingLink, extractMeetingUrl, meetingProvider, isRemoteTask,
} from '../src/utils/meetingLink';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const task = (over: Partial<Task>): Task => ({
  id: 't', text: 'x', category: 'meeting', priority: 'have_to', isFixed: true,
  durationMinutes: 60, date: '2026-08-26', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as Task);

function main() {
  console.log('\nMeeting links vs places\n');

  console.log('1. A link is not a place');
  for (const url of [
    'https://us02web.zoom.us/j/8123456789?pwd=abc',
    'https://meet.google.com/abc-defg-hij',
    'https://teams.microsoft.com/l/meetup-join/xyz',
    'www.whereby.com/lumi',
  ]) {
    check(`recognised: ${url.slice(0, 42)}`, isMeetingLink(url));
  }

  console.log('\n2. A real address is still a place');
  for (const addr of [
    "Mordei ha-Geta'ot St 25, Tel Aviv-Yafo",
    'Yigal Alon 94',
    'Space Gym',
    'בנימינה',
  ]) {
    check(`still an address: ${addr}`, !isMeetingLink(addr));
  }
  // "zoom" as a word is not a URL — someone could be going to a room called that.
  check('a bare word "zoom" is not treated as a link', !isMeetingLink('Zoom room, 3rd floor'));

  console.log('\n3. THE BUG: addrOf must refuse a URL');
  const zoom = task({ location: 'https://us02web.zoom.us/j/8123456789' as any, category: 'zoom' });
  check('a Zoom URL in location yields NO route target', addrOf(zoom) === undefined, String(addrOf(zoom)));
  const yoga = task({ location: 'Yigal Alon 94, Tel Aviv' as any });
  check('a real address still yields a route target', addrOf(yoga) === 'Yigal Alon 94, Tel Aviv');
  check('no location at all is still undefined', addrOf(task({})) === undefined);

  console.log('\n4. Pulling the link out of free text');
  check('from a bare location field',
    extractMeetingUrl('https://zoom.us/j/999') === 'https://zoom.us/j/999');
  check('from prose in the description',
    extractMeetingUrl(undefined, 'Join here: https://meet.google.com/abc-defg-hij, see you!')
      === 'https://meet.google.com/abc-defg-hij',
    String(extractMeetingUrl(undefined, 'Join here: https://meet.google.com/abc-defg-hij, see you!')));
  check('www. gets a scheme', extractMeetingUrl('www.zoom.us/j/1') === 'https://www.zoom.us/j/1');
  check('nothing when there is no URL', extractMeetingUrl('Yigal Alon 94') === undefined);

  console.log('\n5. Naming the provider');
  check('zoom.us → Zoom', meetingProvider('https://us02web.zoom.us/j/1') === 'Zoom');
  check('meet.google.com → Google Meet', meetingProvider('https://meet.google.com/a') === 'Google Meet');
  check('an unknown host has no name', meetingProvider('https://example.com/x') === undefined);

  console.log('\n6. Which half of a clash can move');
  // This is what lets Lumi say "watch the call on the way to yoga".
  check('a task with a link is doable anywhere', isRemoteTask({ meetingUrl: 'https://zoom.us/j/1' }));
  check('a link left in location still counts',
    isRemoteTask({ location: 'https://zoom.us/j/1' }));
  check('category zoom counts', isRemoteTask({ category: 'zoom' }));
  check('a phone call counts', isRemoteTask({ category: 'call' }));
  check('a yoga class does NOT', !isRemoteTask({ category: 'hobby_class', location: 'Yigal Alon 94' }));

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
