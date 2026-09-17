/**
 * MorningBriefingService — the spoken "wake-up call": composes a motivational
 * greeting + today's task list and (a) speaks it aloud via TTS, (b) schedules
 * an alarm-style notification that fires with sound even while the phone is
 * locked, carrying the same text.
 *
 * IMPORTANT constraint: TTS (expo-speech) only runs while the app's JS is
 * running. A locked-screen notification can play a sound and show the briefing
 * text, but it cannot make the phone SPEAK on its own — the speaking happens
 * when the app is open (the alarm tap routes here from App.tsx). A fully
 * self-speaking locked alarm would need a native alarm module outside Expo.
 *
 * Dependencies: SpeechService.speak (TTS), TaskStorage (getTasksForDate,
 * toDateKey, getSettings), UserProfileStorage.loadProfile (name/language),
 * constants/strings (motivational lines), NotificationService (alarm channel).
 * Consumed by SettingsScreen (test button) and App.tsx (morning alarm tap).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { speak } from './SpeechService';
import { getTasksForDate, toDateKey, getSettings } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { EXTENDED_STRINGS } from '../constants/strings';
import { scheduleWakeAlarm, PENDING_WAKE_BRIEFING_KEY } from './NotificationService';
import { AppLanguage } from '../types/models';

/** Pick a random motivational line for the given language. */
function motivation(language: AppLanguage): string {
  const lines = EXTENDED_STRINGS[language]?.motivational ?? EXTENDED_STRINGS.en.motivational;
  return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * Compose the spoken briefing text (pure — no I/O).
 * e.g. "Good morning Koral! Such a great day to be productive 💪
 *       Today you've got: continue working on Lumi, learn interviews, PPO HW."
 */
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "Monday, July 20, and it's 07:45" / "יום שני, 20 ביולי, השעה 07:45". */
function dayDateHour(language: AppLanguage, now: Date): string {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (language === 'he') {
    return `היום יום ${DAYS_HE[now.getDay()]}, ${now.getDate()}.${now.getMonth() + 1}, השעה ${hhmm}.`;
  }
  return `It's ${DAYS_EN[now.getDay()]}, ${MONTHS_EN[now.getMonth()]} ${now.getDate()}, ${hhmm}.`;
}

export function buildMorningBriefing(
  name: string,
  taskTitles: string[],
  language: AppLanguage,
  now: Date = new Date(),
): string {
  const who = name && name !== 'there' ? ` ${name}` : '';
  const dateLine = dayDateHour(language, now);
  // Big-event morning (interview/exam): a dedicated pep line after the list.
  const big = taskTitles.find((t) => /interview|exam|test|ראיון|מבחן|בחינה/i.test(t));
  if (language === 'he') {
    const greet = `בוקר טוב${who}! ${dateLine} ${motivation('he')}`;
    const pep = big ? ` היום ${big} — נשמת/ה עמוק, את/ה מוכן/ה לזה. בהצלחה! 🚀` : '';
    if (!taskTitles.length) return `${greet} אין משימות קבועות להיום — יום פנוי לגמרי!`;
    return `${greet} היום מחכות לך: ${taskTitles.join(', ')}.${pep}`;
  }
  const greet = `Good morning${who}! ${dateLine} ${motivation('en')}`;
  const pep = big ? ` Today is the ${big} — deep breath, you are ready for this. Good luck! 🚀` : '';
  if (!taskTitles.length) return `${greet} No set tasks today — a totally free day!`;
  return `${greet} Today you've got: ${taskTitles.join(', ')}.${pep}`;
}

/** Load today's tasks + profile and return the composed briefing text. */
export async function getTodaysBriefing(): Promise<{ text: string; language: AppLanguage }> {
  const settings = await getSettings();
  const language = settings.language;
  const profile = await loadProfile();
  const tasks = await getTasksForDate(toDateKey());
  const titles = tasks
    .filter((t) => t.status !== 'moved' && t.status !== 'complete')
    .map((t) => t.text);
  return { text: buildMorningBriefing(profile?.name ?? 'there', titles, language), language };
}

/** Speak today's briefing aloud right now. Returns the spoken text (for the test UI). */
export async function speakMorningBriefingNow(): Promise<string> {
  const { text, language } = await getTodaysBriefing();
  await speak(text, language);
  return text;
}

/** How long after the wake alarm an app-open still counts as "waking up". */
const WAKE_BRIEFING_WINDOW_MS = 60 * 60 * 1000;

/**
 * Auto-speak on app-open: if a wake alarm was scheduled (marker written by
 * NotificationService) and it fired within the last hour, recompose TODAY's
 * briefing fresh and speak it — no notification tap needed. Consumes the
 * marker so it speaks at most once per alarm. Called from App.tsx on
 * AppState 'active'. Returns true if it spoke.
 */
export async function maybeSpeakWakeBriefing(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_WAKE_BRIEFING_KEY);
    if (!raw) return false;
    const when = new Date(raw).getTime();
    if (Number.isNaN(when)) {
      await AsyncStorage.removeItem(PENDING_WAKE_BRIEFING_KEY);
      return false;
    }
    const now = Date.now();
    if (now < when) return false; // alarm hasn't fired yet — keep the marker
    await AsyncStorage.removeItem(PENDING_WAKE_BRIEFING_KEY); // consume
    if (now - when > WAKE_BRIEFING_WINDOW_MS) return false; // opened too late
    await speakMorningBriefingNow(); // recomposed fresh — today's actual tasks
    await markMorningSpoken(); // don't double up with the daily greeting
    return true;
  } catch (e) {
    console.log('[MorningBriefing] wake auto-speak failed:', e);
    return false;
  }
}

// Daily morning greeting: FIRST app open of the day inside the morning window
// speaks the briefing (day, date, hour, today's tasks) — no alarm needed.
const MORNING_SPOKEN_KEY = 'lumi.morningSpokenDate.v1';

async function markMorningSpoken(): Promise<void> {
  await AsyncStorage.setItem(MORNING_SPOKEN_KEY, toDateKey()).catch(() => {});
}

export async function maybeSpeakDailyMorningBriefing(): Promise<boolean> {
  try {
    const settings = await getSettings();
    const hour = new Date().getHours();
    const from = settings.androidMorningWindowStart ?? 6;
    const to = settings.androidMorningWindowEnd ?? 10;
    if (hour < from || hour >= Math.max(to, from + 1) + 2) return false; // window + grace
    if ((await AsyncStorage.getItem(MORNING_SPOKEN_KEY)) === toDateKey()) return false;
    await markMorningSpoken(); // set BEFORE speaking — never double-fire
    await speakMorningBriefingNow();
    return true;
  } catch (e) {
    console.log('[MorningBriefing] daily auto-speak failed:', e);
    return false;
  }
}

/**
 * Schedule a one-off wake-up alarm at a specific clock time (defaults to the
 * next 09:00). The notification body IS the briefing so it shows/sounds even
 * locked; opening it makes Lumi read the list aloud.
 * ponytail: composes from TODAY's tasks at schedule time — fine for a test;
 * a production daily alarm would recompose each morning.
 */
export async function scheduleWakeUpTest(hour = 9, minute = 0): Promise<Date> {
  const { text, language } = await getTodaysBriefing();
  const when = new Date();
  when.setHours(hour, minute, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1); // next occurrence
  const title = language === 'he' ? '⏰ בוקר טוב מלומי' : '⏰ Good morning from Lumi';
  // checkInType routes the tap to the morning screen; briefing tells App.tsx to speak.
  await scheduleWakeAlarm(title, text, when, { checkInType: 'morning', briefing: true });
  return when;
}

// Self-check (run with: npx tsx src/services/MorningBriefingService.ts)
if (typeof require !== 'undefined' && require.main === module) {
  const en = buildMorningBriefing('Koral', ['continue Lumi', 'interviews', 'PPO HW'], 'en');
  console.assert(en.includes('Koral') && en.includes('PPO HW'), 'en briefing has name + tasks');
  const empty = buildMorningBriefing('there', [], 'en');
  console.assert(/free day/i.test(empty), 'empty-day fallback');
  const he = buildMorningBriefing('קורל', ['ללמוד'], 'he');
  console.assert(he.includes('בוקר טוב') && he.includes('ללמוד'), 'he briefing');
  console.log('MorningBriefingService self-check OK');
}
