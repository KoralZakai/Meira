/**
 * run-menu-map — every setting has exactly one home, and no control is fake
 * (6.10: "organise Profile and Menu so nothing appears twice").
 *
 * Before: language in two places, calendars in four, a wake-alarm switch in
 * the Menu that saved nothing beside the real one on an orphaned screen,
 * "Sleep time" that moved the evening check-in, and a Sign out that signed
 * nothing out. This reads the screens' source and pins the map.
 *
 *   npx tsx tests/run-menu-map.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const read = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8');
const menu = read('screens/SettingsMenu.tsx');
const pages = read('screens/ProfileEditScreen.tsx');
const today = read('screens/TodaySchedule.tsx');

// ProfileEditScreen draws one page per Menu door: `{section === 'x' && (`.
const blocks: Record<string, string> = {};
const re = /\{section === '(\w+)'(?: && \w+)? && \(/g;
const starts = [...pages.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }));
starts.forEach((s, i) => { blocks[s.name] = pages.slice(s.at, starts[i + 1]?.at ?? pages.length); });

console.log('\nOne page per door\n');
check('the pages are You, Alerts, Calendars, Helpers, Account',
  JSON.stringify(Object.keys(blocks).sort()) === JSON.stringify(['account', 'alerts', 'calendars', 'helpers', 'you']),
  JSON.stringify(Object.keys(blocks)));
for (const door of ['you', 'calendars', 'alerts', 'helpers', 'account']) {
  check(`the Menu opens "${door}"`, menu.includes(`open('${door}')`));
}

console.log('\nEvery setting on exactly one page\n');
const HOME: Record<string, string> = {
  "transportMode: mode": 'you',
  'hasCar: value': 'you',
  'earliestWakeTime:': 'you',
  'sleepTime:': 'you',
  '<RoutineList': 'you',
  '<LearnedRules': 'you',
  'dirty.current.hobbies = true': 'you',
  "navigate('CoachChat'": 'you',
  'wakeAlarmEnabled:': 'alerts',
  'morningTime:': 'alerts',
  'eveningTime:': 'alerts',
  // 7.10: no typed number any more — a WhatsApp link is PROVED by a message.
  'connectWhatsApp': 'alerts',
  'linkedPhone': 'alerts',
  'setManualAlarm': 'alerts',
  '<CalendarConnections': 'calendars',
  'runCalendarCheck': 'calendars',
  "navigate('Agents')": 'helpers',
  '<AiAssistants': 'helpers',
  'switchAccount': 'account',
  'handleSignOut': 'account',
  'handleDeleteAccount': 'account',
};
for (const [marker, home] of Object.entries(HOME)) {
  const where = Object.entries(blocks).filter(([, src]) => src.includes(marker)).map(([n]) => n);
  check(`${marker} → ${home} only`, where.length === 1 && where[0] === home, JSON.stringify(where));
}

console.log('\nThe Menu holds doors, not copies\n');
check('Language is chosen in the Menu', /setLanguage\(lang\)/.test(menu));
check('…and nowhere in the pages', !/language: lang|setLanguage\(/.test(pages));
for (const dup of ['<CalendarConnections', '<AiAssistants', '<Switch']) {
  check(`no ${dup} in the Menu`, !menu.includes(dup));
}

console.log('\nNo fake controls\n');
for (const [name, src] of [['Menu', menu], ['pages', pages]] as const) {
  check(`${name}: no handler that does nothing`, !/on(Press|Change|ValueChange)=\{\(\) => \{\}\}/.test(src));
}
check('Sign out really ends the session', /handleSignOut[\s\S]{0,1500}supabaseSignOut\(\)/.test(pages));
check('Sign out erases the phone (7.10)', /handleSignOut[\s\S]{0,1800}wipeDevice\(\)/.test(pages));
check('"Sleep time" no longer moves the evening check-in',
  !/label="Sleep time"/.test(pages) && /sleepTime: fmtTime/.test(pages));
check('a check-in hour moved is rescheduled at once', /rescheduleDailyNotifications\(next\)/.test(pages));
check("Today's calendar pill opens Calendars, not the whole Menu",
  today.includes("navigate('ProfileEdit', { section: 'calendars' })"));

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
