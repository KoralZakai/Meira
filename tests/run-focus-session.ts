/**
 * run-focus-session — the learning-session blocker: its rules, its words, and its wiring.
 *
 * Koral, 17.10: "a session where the user defines a learning time and cannot enter WhatsApp,
 * Instagram or any social app she decides to block while learning." Starts BOTH automatically at a
 * study task's hour AND by hand; "End early" only after a visible 10-second wait; WhatsApp blocked
 * completely (calls included); the phone and emergency never blocked.
 *
 * Most of this is pure (utils/focusSession) and driven directly. The Kotlin cannot run here, so the
 * parts of it that are RULES — the 10-second wait, the never-block list, the service type, the
 * permissions — are checked on the source itself, and so is the wiring: a blocker with no caller is
 * not a feature (CLAUDE.md, silent-state rule 7), so each trigger must exist in the file that owns it.
 *
 * Run:  npx tsx tests/run-focus-session.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../src/types/index';
import {
  DEFAULT_APP_IDS, DEFAULT_SESSION_MINUTES, END_EARLY_SECONDS, FOCUS_APPS, MAX_SESSION_MINUTES,
  MIN_SESSION_MINUTES, NEVER_BLOCK_PACKAGES, START_GRACE_MINUTES, appOfPackage, failureText,
  focusDisclosure, focusStrings, hhmmOf, isLearningTask, joinNames, namesOf, normaliseChoice, packagesFor, parseLocalMs,
  planDiff, plannedStudySessions, sessionSig, sessionWindow, startNotice,
} from '../src/utils/focusSession';
import { FocusGuard } from '../modules/focus-guard';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const KT = (f: string) => read(`modules/focus-guard/android/src/main/java/expo/modules/focusguard/${f}`);

const task = (over: Partial<Task>): Task => ({
  id: 't1', text: 'Study for the exam', category: 'course', priority: 'have_to', isFixed: true,
  fixedTime: '10:00', durationMinutes: 45, date: '2026-10-17', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
});

// 17.10 10:00 local — a Saturday-morning "now" the windows below are built around.
const at = (date: string, hhmm: string) => parseLocalMs(date, hhmm)!;
const NOW = at('2026-10-17', '09:00');

console.log('\n1. Which tasks are study sessions\n');
{
  const yes = [
    'Morning study for koral Technical Interview — up early, then out the door',
    'Prep for the Ceva interview — company, role, questions',
    'Final review for Ceva — questions to ask, what to wear, the route',
    'Study for the exam',
    'ללמוד לראיון של אמזון',
    'לימוד בוקר לראיון — לקום מוקדם ואז לצאת',
    'שיעורי בית במתמטיקה',
  ];
  for (const text of yes) check(`"${text.slice(0, 44)}" qualifies`, isLearningTask(task({ text })));
  const no = ['Dentist', 'Gym with Dana', 'Interview with Ceva', 'Lunch with mom', 'Submit CV'];
  for (const text of no) check(`"${text}" does not`, !isLearningTask(task({ text, category: 'general' })));
  check('a study task already done does not', !isLearningTask(task({ status: 'complete' })));
  check('...nor one that was moved', !isLearningTask(task({ status: 'moved' })));
  check('a partly-done one still does', isLearningTask(task({ status: 'partial' })));
}

console.log('\n2. The window a study task occupies\n');
{
  const w = sessionWindow(task({ fixedTime: '10:00', durationMinutes: 45 }))!;
  check('fixedTime + duration', w.minutes === 45 && hhmmOf(w.startAtMs) === '10:00' && hhmmOf(w.endsAtMs) === '10:45');
  const s = sessionWindow(task({ fixedTime: undefined, scheduledTime: '14:30', durationMinutes: 60 }))!;
  check('scheduledTime when there is no fixedTime', hhmmOf(s.startAtMs) === '14:30' && hhmmOf(s.endsAtMs) === '15:30');
  const r = sessionWindow(task({ fixedTime: '19:00', endTime: '20:15', durationMinutes: 30 }))!;
  check('a from→to range wins over the estimate', r.minutes === 75, String(r.minutes));
  check('no duration → the default', sessionWindow(task({ durationMinutes: 0 }))!.minutes === DEFAULT_SESSION_MINUTES);
  check('a 9-hour estimate is capped, so WhatsApp is not locked all day',
    sessionWindow(task({ durationMinutes: 540 }))!.minutes === MAX_SESSION_MINUTES);
  check('a 2-minute estimate is raised to the minimum', sessionWindow(task({ durationMinutes: 2 }))!.minutes === MIN_SESSION_MINUTES);
  check('no hour → no window (never a guess)', sessionWindow(task({ fixedTime: undefined, scheduledTime: undefined })) === null);
  check('a malformed hour → no window', sessionWindow(task({ fixedTime: '25:99' })) === null);
}

console.log('\n3. The apps: presets, what is available, what can never be blocked\n');
{
  check('presets are Instagram, WhatsApp, TikTok', JSON.stringify(DEFAULT_APP_IDS) === '["instagram","whatsapp","tiktok"]');
  const ids = FOCUS_APPS.map((a) => a.id);
  for (const id of ['youtube', 'facebook', 'x', 'telegram', 'snapchat', 'whatsapp_business']) {
    check(`${id} is available to add`, ids.includes(id));
  }
  const pk = packagesFor(DEFAULT_APP_IDS);
  check('Instagram, WhatsApp and both TikTok packages are blocked',
    ['com.instagram.android', 'com.whatsapp', 'com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'].every((p) => pk.includes(p)));
  check('WhatsApp Business is NOT blocked unless chosen', !pk.includes('com.whatsapp.w4b') && packagesFor(['whatsapp_business']).includes('com.whatsapp.w4b'));
  check('WhatsApp is blocked as a whole app — calls included (one package, no call exception)',
    pk.includes('com.whatsapp')
    && ['FocusService.kt', 'FocusBlockActivity.kt', 'FocusUsage.kt'].every((f) => !/whatsapp/i.test(KT(f))));
  check('never chosen → the presets', JSON.stringify(normaliseChoice(undefined)) === JSON.stringify(DEFAULT_APP_IDS));
  check('an empty choice stays empty (she picked nothing)', normaliseChoice([]).length === 0);
  check('unknown ids and duplicates are dropped', JSON.stringify(normaliseChoice(['x', 'x', 'bogus', 7, 'youtube'])) === '["x","youtube"]');
  for (const pkg of NEVER_BLOCK_PACKAGES) {
    check(`never blocked: ${pkg}`, !packagesFor(FOCUS_APPS.map((a) => a.id)).includes(pkg));
  }
  check('the dialer and emergency are on the never-block list',
    ['com.android.dialer', 'com.google.android.dialer', 'com.android.emergency', 'com.android.phone'].every((p) => NEVER_BLOCK_PACKAGES.includes(p)));
  check('TikTok\'s second package maps back to TikTok', appOfPackage('com.ss.android.ugc.trill')?.id === 'tiktok');

  // The Kotlin list and the TS list must say the same thing.
  const kt = KT('FocusService.kt');
  const block = /NEVER_BLOCK = setOf\(([\s\S]*?)\)\n/.exec(kt)?.[1] ?? '';
  const ktSet = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const tsSet = new Set(NEVER_BLOCK_PACKAGES.filter((p) => p !== 'meira.secretary')); // Kotlin tests packageName itself
  check('FocusService.NEVER_BLOCK equals NEVER_BLOCK_PACKAGES', ktSet.size === tsSet.size && [...tsSet].every((p) => ktSet.has(p)),
    `kotlin=${[...ktSet].filter((p) => !tsSet.has(p))} ts=${[...tsSet].filter((p) => !ktSet.has(p))}`);
  check('Meira herself is never blocked (packageName test)', /front == packageName/.test(kt));
}

console.log('\n4. What gets scheduled — idempotent, today and tomorrow, merged, never late\n');
{
  const ids = DEFAULT_APP_IDS;
  const study = task({ id: 'a', fixedTime: '10:00', durationMinutes: 45 });
  const planned = plannedStudySessions([study], NOW, ids, 'he');
  check('one study task today → one session', planned.length === 1 && planned[0].id === 'study-a');
  check('...blocking the chosen packages', planned[0].blocked.length === packagesFor(ids).length);
  check('...with its own window', hhmmOf(planned[0].startAtMs) === '10:00' && hhmmOf(planned[0].endsAtMs) === '10:45');
  check('...and not yet "start now"', planned[0].startNow === false);

  const again = plannedStudySessions([study], NOW, ids, 'he');
  check('the same input → the same fingerprint (a sync every 10 min is a no-op)', again[0].sig === planned[0].sig);
  check('a moved task → a new fingerprint', plannedStudySessions([{ ...study, fixedTime: '11:00' }], NOW, ids, 'he')[0].sig !== planned[0].sig);
  check('a changed app list → a new fingerprint', plannedStudySessions([study], NOW, ['instagram'], 'he')[0].sig !== planned[0].sig);

  const tomorrow = task({ id: 'b', date: '2026-10-18', fixedTime: '08:00' });
  const farther = task({ id: 'c', date: '2026-10-19', fixedTime: '08:00' });
  const ps = plannedStudySessions([study, tomorrow, farther], NOW, ids, 'en');
  check('tomorrow is scheduled (the alarm must exist before she wakes)', ps.some((p) => p.id === 'study-b'));
  check('the day after is not (yet)', !ps.some((p) => p.id === 'study-c'));

  const justPassed = task({ id: 'd', fixedTime: '08:55', durationMinutes: 60 });
  const grace = plannedStudySessions([justPassed], NOW, ids, 'en');
  check(`a start ${START_GRACE_MINUTES} min ago or less still starts, now`, grace.length === 1 && grace[0].startNow === true);
  const late = task({ id: 'e', fixedTime: '08:30', durationMinutes: 60 });
  check('a start 30 min ago does not (she can press Start)', plannedStudySessions([late], NOW, ids, 'en').length === 0);
  const over = task({ id: 'f', fixedTime: '07:00', durationMinutes: 45 });
  check('a window that is over is not scheduled', plannedStudySessions([over], NOW, ids, 'en').length === 0);

  const o1 = task({ id: 'g', fixedTime: '15:00', durationMinutes: 60, text: 'Study for the exam' });
  const o2 = task({ id: 'h', fixedTime: '15:30', durationMinutes: 60, text: 'Prep for the Ceva interview — company, role, questions' });
  const merged = plannedStudySessions([o2, o1], NOW, ids, 'en');
  check('two overlapping study tasks become ONE session (one service, one window)', merged.length === 1 && merged[0].taskIds.length === 2);
  check('...ending when the later one ends', hhmmOf(merged[0].endsAtMs) === '16:30');

  check('nothing chosen → nothing scheduled', plannedStudySessions([study], NOW, [], 'en').length === 0);
  check('a non-study task is never scheduled', plannedStudySessions([task({ text: 'Dentist', category: 'doctor' })], NOW, ids, 'en').length === 0);

  // The diff against what the native side already holds.
  const have = planned.map((p) => ({ id: p.id, sig: p.sig }));
  let d = planDiff(planned, have);
  check('in step → nothing to do', d.toSchedule.length === 0 && d.toCancel.length === 0);
  d = planDiff(plannedStudySessions([{ ...study, fixedTime: '11:00' }], NOW, ids, 'he'), have);
  check('moved → rescheduled, not duplicated', d.toSchedule.length === 1 && d.toCancel.length === 0);
  d = planDiff([], have);
  check('task gone (done / deleted) → its alarm is cancelled', d.toCancel.join() === 'study-a');
  d = planDiff([], [{ id: 'resume-xyz-1', sig: 's' }]);
  check('a "resume after the break" entry is not ours to cancel', d.toCancel.length === 0);
  check('sessionSig is stable and order-insensitive on packages',
    sessionSig({ startAtMs: 1, endsAtMs: 2, blocked: ['a', 'b'], title: 't', lang: 'en' }) === sessionSig({ startAtMs: 1, endsAtMs: 2, blocked: ['b', 'a'], title: 't', lang: 'en' }));
}

console.log('\n5. The words — both languages\n');
{
  check('Hebrew list: אינסטגרם, וואטסאפ וטיקטוק', joinNames(namesOf(DEFAULT_APP_IDS, 'he'), 'he') === 'אינסטגרם, וואטסאפ וטיקטוק', joinNames(namesOf(DEFAULT_APP_IDS, 'he'), 'he'));
  check('English list: Instagram, WhatsApp and TikTok', joinNames(namesOf(DEFAULT_APP_IDS, 'en'), 'en') === 'Instagram, WhatsApp and TikTok');
  check('a Latin name after "and" takes a hyphen in Hebrew', joinNames(['אינסטגרם', 'X'], 'he') === 'אינסטגרם ו-X', joinNames(['אינסטגרם', 'X'], 'he'));
  check('more than three → "and N more"', joinNames(['a', 'b', 'c', 'd', 'e'], 'en') === 'a, b, c and 2 more');
  const heN = startNotice(DEFAULT_APP_IDS, at('2026-10-17', '19:45'), 'he');
  check('start notice (he): 📚 מתחילים ללמוד — חסמתי את אינסטגרם…', heN.title === '📚 מתחילים ללמוד' && heN.body === 'חסמתי את אינסטגרם, וואטסאפ וטיקטוק · עד 19:45', heN.body);
  const enN = startNotice(DEFAULT_APP_IDS, at('2026-10-17', '19:45'), 'en');
  check('start notice (en)', enN.title === '📚 Study time' && enN.body === 'I blocked Instagram, WhatsApp and TikTok · until 19:45', enN.body);

  // The strings of the panel: same keys, none empty, in both languages.
  const en = focusStrings('en') as Record<string, unknown>;
  const he = focusStrings('he') as Record<string, unknown>;
  check('focusStrings: the same keys in both languages', JSON.stringify(Object.keys(en)) === JSON.stringify(Object.keys(he)));
  const text = (v: unknown): string => (typeof v === 'function' ? String((v as (...a: number[]) => string)(7, 7 as never)) : String(v));
  check('...none empty', Object.keys(en).every((k) => text(en[k]).trim() && text(he[k]).trim()));
  check('...Hebrew actually Hebrew', Object.keys(he).filter((k) => !['menuRow'].includes(k)).some((k) => /[֐-׿]/.test(text(he[k]))));
  check('the Start button names the minutes', (en.start as (m: number) => string)(45) === 'Start learning · 45 min'
    && /45/.test((he.start as (m: number) => string)(45)));
  check('End early names the wait', /10/.test(String(en.endEarly)) && /10/.test(String(he.endEarly)));

  // The Play prominent disclosure: same shape in both languages, and it says the four things
  // the policy asks for — what is seen, what for, that it stays on the phone, how to turn it off.
  const dEn = focusDisclosure('en');
  const dHe = focusDisclosure('he');
  check('disclosure: the same number of lines in both languages', dEn.lines.length === dHe.lines.length && dEn.lines.length >= 4);
  check('...names both accesses (en)', /Usage access/.test(dEn.lines.join(' ')) && /Display over other apps/.test(dEn.lines.join(' ')));
  check('...names both accesses (he)', /גישת שימוש/.test(dHe.lines.join(' ')) && /הצגה מעל אפליקציות/.test(dHe.lines.join(' ')));
  check('...says it stays on the phone', /stays on your phone/.test(dEn.lines.join(' ')) && /נשאר בטלפון/.test(dHe.lines.join(' ')));
  check('...says how to turn it off', /Settings/.test(dEn.lines.join(' ')) && /הגדרות/.test(dHe.lines.join(' ')));
  check('...says it is only during a session', /only during a learning session/.test(dEn.lines[0]) && /רק בזמן סשן/.test(dHe.lines[0]));
  check('...has an explicit go-on and a way out', Boolean(dEn.accept && dEn.decline && dHe.accept && dHe.decline));
  check('...every line short (Lumi speaks short)', [...dEn.lines, ...dHe.lines].every((l) => l.length <= 120));
  check('disclosure_needed has words, and no fix button (the card is the fix)', failureText('disclosure_needed', 'en').fix === 'none' && /[֐-׿]/.test(failureText('disclosure_needed', 'he').title));

  // Every failure says why and names the fix (rule 3).
  const reasons: Array<[string, string]> = [
    ['native_unavailable', 'none'], ['no_usage_access', 'usage'], ['no_overlay', 'overlay'],
    ['nothing_to_block', 'none'], ['bad_window', 'none'], ['window_over', 'none'],
    ['service_start_refused:ForegroundServiceStartNotAllowedException', 'none'],
    ['alarm_refused:SecurityException', 'none'], ['settings_refused:ActivityNotFoundException', 'none'],
    ['native_error:boom', 'none'],
  ];
  for (const [reason, fix] of reasons) {
    for (const lang of ['en', 'he'] as const) {
      const f = failureText(reason, lang);
      check(`${reason} (${lang}) has words and fix=${fix}`, f.title.length > 3 && f.body.length > 3 && f.fix === fix);
    }
  }
  check('usage access and overlay read differently (different fixes)',
    failureText('no_usage_access', 'en').title !== failureText('no_overlay', 'en').title);
}

console.log('\n6. Without the native module every call says so — never "nothing"\n');
{
  check('the module reports itself unavailable here', FocusGuard.isAvailable() === false);
  check('...and says why', typeof FocusGuard.unavailableDetail() === 'string');
  const perms = FocusGuard.permissions();
  check('permissions(): native=false with a reason', perms.native === false && perms.reason === 'native_unavailable');
  const calls: Array<[string, { ok: boolean; reason?: string }]> = [
    ['openUsageAccessSettings', FocusGuard.openUsageAccessSettings()],
    ['openOverlaySettings', FocusGuard.openOverlaySettings()],
    ['installedPackages', FocusGuard.installedPackages(['com.whatsapp'])],
    ['startSession', FocusGuard.startSession({ endsAtMs: Date.now() + 6e5, blocked: ['com.whatsapp'], title: 't', lang: 'en' })],
    ['stopSession', FocusGuard.stopSession()],
    ['endSessionEarly', FocusGuard.endSessionEarly()],
    ['getSession', FocusGuard.getSession()],
    ['lastSession', FocusGuard.lastSession()],
    ['scheduleSession', FocusGuard.scheduleSession({ id: 'x', startAtMs: 1, endsAtMs: 2, blocked: [], title: '', lang: 'en', startTitle: '', startBody: '', sig: 's' })],
    ['cancelScheduled', FocusGuard.cancelScheduled('x')],
    ['listScheduled', FocusGuard.listScheduled()],
    ['drainIncidents', FocusGuard.drainIncidents()],
    ['reconcile', FocusGuard.reconcile()],
  ];
  for (const [name, r] of calls) {
    check(`${name} → {ok:false, reason:'native_unavailable'}`, r.ok === false && r.reason === 'native_unavailable', JSON.stringify(r));
  }
  FocusGuard.usageSummary(0, 1).then((r) => {
    check('usageSummary → native_unavailable', r.ok === false && r.reason === 'native_unavailable');
    finish();
  });
}

function finish() {
  console.log('\n7. The rules that live in Kotlin and the manifest (checked on the source)\n');
  const ktBlock = KT('FocusBlockActivity.kt');
  const ktService = KT('FocusService.kt');
  const ktSched = KT('FocusScheduler.kt');
  const manifest = read('modules/focus-guard/android/src/main/AndroidManifest.xml');
  const cfg = JSON.parse(read('modules/focus-guard/expo-module.config.json'));

  const secs = /END_EARLY_COUNTDOWN_SECONDS\s*=\s*(\d+)/.exec(ktBlock)?.[1];
  check('the block screen waits 10 seconds before "End early"', secs === '10', String(secs));
  check('...the same 10 as the sheet', Number(secs) === END_EARLY_SECONDS && END_EARLY_SECONDS === 10);
  check('...the button is disabled while counting', /isEnabled = false/.test(ktBlock) && /countingDown\(/.test(ktBlock));
  check('...and ending is routed through the service (recorded as ended early)', /ACTION_END_EARLY/.test(ktBlock));
  check('Back never reveals the blocked app (goes Home)', /onBackPressed[\s\S]{0,80}goHome\(\)/.test(ktBlock));
  check('the block screen has "Back to learning" and "End early"', /backToLearning/.test(ktBlock) && /endEarly\(/.test(ktBlock));

  check('the service polls about every 700 ms', /POLL_MS = 700L/.test(ktService));
  check('it reads the foreground app from UsageStatsManager events', /queryEvents/.test(KT('FocusUsage.kt')));
  check('it is sticky (restarts until endsAt)', /START_STICKY/.test(ktService));
  check('it starts as a specialUse foreground service on Android 14+', /FOREGROUND_SERVICE_TYPE_SPECIAL_USE/.test(ktService));
  check('the session is persisted so a restart resumes it', /saveSession/.test(ktService) || /saveSession/.test(KT('FocusStore.kt')));
  check('the block screen is launched NEW_TASK | CLEAR_TOP', /FLAG_ACTIVITY_NEW_TASK or Intent\.FLAG_ACTIVITY_CLEAR_TOP/.test(ktService));
  check('permissions are re-checked on every tick (mid-session revoke)', /hasUsageAccess[\s\S]{0,200}canDrawOverlays/.test(ktService) && /permission_revoked/.test(ktService));
  check('the alarm is exact when allowed, else setAndAllowWhileIdle', /setExactAndAllowWhileIdle/.test(ktSched) && /setAndAllowWhileIdle/.test(ktSched));
  check('alarms are re-armed after a reboot / app update', /BOOT_COMPLETED/.test(manifest) && /MY_PACKAGE_REPLACED/.test(manifest) && /rearmAll/.test(ktSched));

  for (const p of ['PACKAGE_USAGE_STATS', 'SYSTEM_ALERT_WINDOW', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_SPECIAL_USE', 'POST_NOTIFICATIONS', 'RECEIVE_BOOT_COMPLETED']) {
    check(`manifest declares ${p}`, new RegExp(`android\\.permission\\.${p}"`).test(manifest));
  }
  check('PACKAGE_USAGE_STATS is marked tools:ignore="ProtectedPermissions"', /PACKAGE_USAGE_STATS"\s+tools:ignore="ProtectedPermissions"|tools:ignore="ProtectedPermissions"[\s\S]{0,80}PACKAGE_USAGE_STATS/.test(manifest));
  check('the service is foregroundServiceType="specialUse" with the subtype property',
    /foregroundServiceType="specialUse"/.test(manifest) && /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/.test(manifest));
  for (const comp of ['.FocusService', '.FocusBlockActivity', '.FocusAlarmReceiver', '.FocusBootReceiver']) {
    check(`manifest declares ${comp}`, manifest.includes(`android:name="${comp}"`));
  }
  check('the block screen stays out of Recents', /excludeFromRecents="true"/.test(manifest));
  const allPackages = FOCUS_APPS.flatMap((a) => a.packages);
  for (const p of allPackages) check(`<queries> lists ${p} (so "installed?" works)`, manifest.includes(`<package android:name="${p}" />`));
  check('the module is declared for autolinking', cfg.platforms.includes('android') && cfg.android.modules.includes('expo.modules.focusguard.FocusGuardModule'));

  const app = JSON.parse(read('app.json')).expo;
  check('SYSTEM_ALERT_WINDOW is not blocked in app.json (it would strip the module\'s permission)',
    !(app.android.blockedPermissions ?? []).some((p: string) => p.endsWith('SYSTEM_ALERT_WINDOW')));

  console.log('\n8. Every trigger exists in the file that owns it (rule 7)\n');
  check('calendar sync (every path, incl. the closed-app job) schedules study sessions',
    /focusTick\(/.test(read('src/services/CalendarAutoSync.ts')));
  check('focusTick schedules them and collects bypasses',
    /scheduleStudySessions\(/.test(read('src/services/FocusBypassService.ts')) && /collectBypasses\(/.test(read('src/services/FocusBypassService.ts')));
  check('the app root mounts the host that runs it on every return to the front',
    /<FocusLectureHost \/>/.test(read('App.tsx')) && /AppState\.addEventListener\('change'/.test(read('src/components/FocusLectureHost.tsx')));
  check('Menu › Helpers has the chooser row', /Learning sessions — blocked apps/.test(read('src/screens/ProfileEditScreen.tsx')) && /FocusSessionSheet/.test(read('src/screens/ProfileEditScreen.tsx')));
  check('FocusNow has the start button panel', /<FocusSessionPanel/.test(read('src/screens/FocusNowScreen.tsx')));
  check('the panel re-checks permissions when the app returns from Settings', /AppState\.addEventListener\('change'/.test(read('src/components/FocusSessionPanel.tsx')));
  check('the panel shows the failure AND the fix button (rule 3)', /failure\.fix !== 'none'/.test(read('src/components/FocusSessionPanel.tsx')));
  check('the panel shows the Play disclosure before Settings', /<FocusDisclosureCard/.test(read('src/components/FocusSessionPanel.tsx')) && /disclosure_needed/.test(read('src/components/FocusSessionPanel.tsx')));
  check('the lecture\'s fix button shows it too', /<FocusDisclosureCard/.test(read('src/components/FocusLectureHost.tsx')) && /disclosure_needed/.test(read('src/components/FocusLectureHost.tsx')));
  check('Settings opens only from requestPermission, which gates on the disclosure',
    !/open(UsageAccess|Overlay)Settings\(/.test(read('src/components/FocusSessionPanel.tsx') + read('src/components/FocusLectureHost.tsx') + read('src/components/FocusSessionSheet.tsx'))
    && /disclosureAccepted\(\)\)\)[\s\S]{0,200}openUsageAccessSettings/.test(read('src/services/FocusSessionService.ts')));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}
