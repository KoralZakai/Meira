/**
 * run-transit-alerts — "is there roadworks / a closed train line on my way?" (20.10)
 *
 * Pure rules of the pre-departure check (utils/transitAlertWindow): which trips
 * are re-checked, what the news search is asked, and that a report is pushed
 * once per trip, never twice.
 *
 * Run:  npx tsx tests/run-transit-alerts.ts
 */
import {
  alertPush, newAlerts, placesFromAddress, routeTerms, tripsToRecheck,
} from '../src/utils/transitAlertWindow';
import { sourceOf, transitAlertLine } from '../src/utils/transitAlertLine';
import type { Task } from '../src/types/index';

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed += 1;
}

const today = '2026-10-20';
const now = new Date(2026, 9, 20, 8, 0);

function trip(id: string, leave: string, extra: Partial<Task> = {}, checkedAt?: number): Task {
  return {
    id, text: `Interview ${id}`, category: 'interview', priority: 'must', isFixed: true,
    fixedTime: '10:00', durationMinutes: 60, date: today, status: 'pending', createdAt: 0,
    historicalDurations: [],
    location: {
      address: 'Herzl 3, Haifa, Israel', lat: 32.8, lng: 35, confirmed: true, leaveHomeBy: leave,
      transportType: 'train',
      transitPlan: {
        totalDurationMinutes: 90, leaveHomeAt: leave, arriveAt: '09:50', firstBusDeparture: '08:40',
        firstBusStop: 'Savidor', walkToStopMinutes: 8, source: 'google', fetchedAt: 0,
        legs: [
          { type: 'walk', from: 'home', to: 'Savidor', durationMinutes: 8, departureTime: '08:30', arrivalTime: '08:38' },
          { type: 'train', from: 'תל אביב - סבידור מרכז', to: 'חיפה - חוף הכרמל', durationMinutes: 55,
            departureTime: '08:40', arrivalTime: '09:35' },
          { type: 'bus', from: 'חוף הכרמל', to: 'הרצל', lineNumber: '115', durationMinutes: 12,
            departureTime: '09:38', arrivalTime: '09:50' },
        ],
      },
      ...(checkedAt ? { transitAlerts: { checkedAt, alerts: [] } } : {}),
    },
    ...extra,
  } as Task;
}

// ── the window ──
const ids = tripsToRecheck([
  trip('soon', '08:30'),
  trip('later', '09:30'),
  trip('gone', '07:45'),
  trip('fresh', '08:40', {}, now.getTime() - 5 * 60_000),
  trip('stale', '08:40', {}, now.getTime() - 25 * 60_000),
  trip('done', '08:30', { status: 'complete' }),
  trip('tomorrow', '08:30', { date: '2026-10-21' }),
], now, today).map((t) => t.id);
check('a trip leaving within the hour is checked', ids.includes('soon'));
check('a trip more than an hour away waits', !ids.includes('later'));
check('a trip whose leave time has passed is not checked', !ids.includes('gone'));
check('checked 5 min ago is not re-asked', !ids.includes('fresh'));
check('checked 25 min ago is re-asked', ids.includes('stale'));
check('a completed trip is not checked', !ids.includes('done'));
check("tomorrow's trip is not checked today", !ids.includes('tomorrow'));

// ── the terms ──
check('address drops the number and country',
  JSON.stringify(placesFromAddress('Herzl 12, Haifa, Israel')) === JSON.stringify(['Herzl', 'Haifa']));
const terms = routeTerms(trip('t', '08:30'), 'Dizengoff 50, Tel Aviv-Yafo, Israel');
check('destination and home cities are asked about', terms.places.includes('Haifa') && terms.places.includes('Tel Aviv-Yafo'));
check('the bus line is asked about', terms.lines.includes('115'));
check('the boarding station is asked about', terms.stations.includes('תל אביב - סבידור מרכז'));
check('walking legs add no station', !terms.stations.includes('home'));
check('the train mode is passed', terms.modes.includes('train'));

// ── push once ──
const a1 = { title: 'ללא רכבות לחיפה', link: 'https://news.example/1' };
const a2 = { title: 'קו 115 יוסט', link: 'https://news.example/2' };
check('a new report is new', newAlerts([a1], undefined).length === 1);
check('a report already told is not pushed again',
  newAlerts([a1, a2], { checkedAt: 1, alerts: [a1] }).map((a) => a.link).join() === a2.link);
const he = alertPush(trip('t', '08:30'), a1, true);
const en = alertPush(trip('t', '08:30'), a1, false);
check('push in Hebrew names the task and the headline', he.title.includes('Interview t') && he.body.includes(a1.title));
check('push in English differs and names the headline', en.title !== he.title && en.body.includes(a1.title));

// ── the line under the trip row (option A) ──
const at = new Date(2026, 9, 20, 7, 58).getTime();
const warnHe = transitAlertLine({ checkedAt: at, alerts: [a1, a2] }, true, now);
const warnEn = transitAlertLine({ checkedAt: at, alerts: [a1] }, false, now);
check('alert line names the headline, source and time (he)',
  !!warnHe && warnHe.kind === 'warn' && warnHe.text.includes(a1.title)
  && warnHe.source === 'news.example' && warnHe.checked === 'נבדק 07:58' && warnHe.more === 1);
check('alert line in English', !!warnEn && warnEn.text.startsWith('⚠️ Possible disruption') && warnEn.checked === 'checked 07:58');
const blind = transitAlertLine({ checkedAt: at, alerts: [], reason: 'rate_limited' }, true, now);
check("couldn't check is drawn, not hidden", !!blind && blind.kind === 'unchecked' && blind.text.includes('לא הצלחתי'));
check('a clear check draws nothing', transitAlertLine({ checkedAt: at, alerts: [] }, true, now) === null);
check('never checked draws nothing', transitAlertLine(undefined, false, now) === null);
const yesterday = transitAlertLine({ checkedAt: new Date(2026, 9, 19, 21, 5).getTime(), alerts: [a1] }, false, now);
check("a check from another day shows its date", !!yesterday && yesterday.checked === 'checked 19.10 21:05');
check('source strips www', sourceOf('https://www.ynet.co.il/news/1') === 'ynet.co.il');

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall transit-alert rules hold');
