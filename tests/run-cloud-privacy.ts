/**
 * 7.10 privacy — where she IS never leaves the phone; logs and alarms name nothing.
 *
 *   npx tsx tests/run-cloud-privacy.ts
 */
import { forCloud, isBareCoords } from '../src/utils/cloudPrivacy';
import { redact } from '../src/utils/logRedaction';

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

const trip: any = {
  id: 't1', text: 'ראיון ב-Ceva', date: '2026-10-08',
  departedFromLat: 32.0853, departedFromLng: 34.7818,
  location: {
    address: 'Ceva, Ra\'anana', lat: 32.18, lng: 34.87,
    transitPlan: { originAddress: '32.0853,34.7818', originLabel: 'My location now', leaveHomeAt: '08:10' },
  },
};

console.log('a task on its way to Supabase / the server');
const out: any = forCloud(trip);
check('departure GPS fix is dropped', out.departedFromLat === undefined && out.departedFromLng === undefined);
check('a GPS origin is dropped', out.location.transitPlan.originAddress === undefined);
check('its label stays (the card still reads right)', out.location.transitPlan.originLabel === 'My location now');
check('the destination — the plan itself — stays', out.location.address === 'Ceva, Ra\'anana');
check('the phone copy is untouched', trip.departedFromLat === 32.0853
  && trip.location.transitPlan.originAddress === '32.0853,34.7818');
const named: any = forCloud({ ...trip, location: { ...trip.location, transitPlan: { originAddress: 'אבן גבירול 30' } } });
check('a NAMED origin is a plan, not a position — kept', named.location.transitPlan.originAddress === 'אבן גבירול 30');
check('isBareCoords', isBareCoords('32.08,34.78') && !isBareCoords('Herzl 5, 32 Tel Aviv'));

console.log('release logs');
const logged: any = redact({ task: { text: 'ראיון עם דני', location: { address: 'הרצל 5', lat: 32.1, lng: 34.8 } }, status: 'ok' });
check('task text, address and coordinates are withheld', logged.task.text === '<redacted>'
  && logged.task.location.address === '<redacted>' && logged.task.location.lat === '<redacted>');
check('the diagnosis survives', logged.status === 'ok');

console.log('the Clock-app alarm');
// AlarmService imports native modules; the label rule is checked at its source.
const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/AlarmService.ts'), 'utf8');
check('the label is "Meira · HH:MM", never the task', /alarm\.MESSAGE': alarmLabel\(hhmm, message\)/.test(src)
  && /return `Meira · \$\{hhmm\}`/.test(src));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
