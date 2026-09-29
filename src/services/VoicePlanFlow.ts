/**
 * VoicePlanFlow — she speaks, and the answer is her day.
 *
 *   "I must work today on Meira for the hackathon, also study for the next
 *    interview in Ceva (the second interview)."
 *
 * What has to happen, in the order that makes it fast:
 *
 *   WHILE SHE TALKS (beginVoiceContext — started the moment the mic opens,
 *   because those seconds are otherwise dead time):
 *     • the calendar is re-read, forced past the throttle — an event booked
 *       since the last sync must be in the day before anything is placed
 *     • her position is read — "at home" is an assumption, not a fact
 *
 *   AFTER (runVoicePlan):
 *     1. the agent saves what she said (the same brain WhatsApp uses), told not
 *        to invent clock times
 *     2. preparation is tied to the appointment it prepares for (utils/voicePlan)
 *     3. the planner puts every flexible task into time that is really free —
 *        after journeys, with buffers, before bed (server/day_planner)
 *     4. the Today screen is told (DayEvents), and the report says what went
 *        wrong on the way, if anything did
 *
 * Nothing here decides silently. The calendar error, the location reason and
 * every task that did not fit are carried to the screen (silent-state rule 1).
 *
 * Triggers (rule 7): the tab-bar mic — the only entry, on every screen.
 *
 * Dependencies: CalendarAutoSync, LocationService, LumiBrain, LumiServer,
 * TaskStorage, KnownPlacesStore, DayEvents, utils/voicePlan.
 * Consumed by components/VoiceSheet.
 */
import { AppLanguage, Task } from '../types/index';
import { CalendarSyncResult, syncCalendarNow } from './CalendarAutoSync';
import { HereResult, getAddressFromCoordinates, getHereDetailed } from './LocationService';
import { brainTurn } from './LumiBrain';
import { planDay } from './LumiServer';
import { getAllTasks, getTasksForDate, loadProfile, toDateKey, updateTaskFields } from './TaskStorage';
import { loadKnownPlaces } from './KnownPlacesStore';
import { emitDayPlanned } from './DayEvents';
import { VoicePlanReport, describePlan, linkPrepTasks } from '../utils/voicePlan';

export interface VoiceContext {
  calendar: Promise<CalendarSyncResult>;
  here: Promise<HereResult>;
}

export type PlanStep = 'understanding' | 'planning';

/** Start the checks that do not depend on what she says. Call when the mic opens. */
export function beginVoiceContext(lang: AppLanguage): VoiceContext {
  return {
    calendar: syncCalendarNow(lang, 'voice').catch((e): CalendarSyncResult => {
      console.warn('[VoicePlan] calendar sync threw', e);
      return { added: 0, error: String(e).slice(0, 160), newTasks: [], ran: false };
    }),
    here: getHereDetailed(8000),
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/**
 * Words Whisper should spell her way: the names on what is coming up and the
 * places she goes. "Ceva", not "Siva"; "רעננה", not "ראננה".
 */
export async function buildVoiceHint(): Promise<string> {
  const words: string[] = ['Meira'];
  try {
    const today = toDateKey();
    const soon = toDateKey(new Date(Date.now() + 14 * 86400000));
    const tasks = (await getAllTasks())
      .filter((t) => t.date >= today && t.date <= soon && t.status !== 'complete')
      .slice(0, 25);
    for (const t of tasks) words.push(t.text.slice(0, 40));
    const places = await loadKnownPlaces().catch(() => ({}));
    for (const place of Object.values(places)) {
      if (place.address) words.push(place.address.slice(0, 40));
    }
  } catch (e) {
    console.warn('[VoicePlan] could not build the vocabulary hint', e);
  }
  return Array.from(new Set(words)).join(', ').slice(0, 400);
}

/**
 * Plan today as it stands: tie any new preparation to its appointment, put
 * every flexible task into real free time, save the slots.
 *
 * Shared by the voice flow and the Today screen's "✨ Plan my day", so a day
 * planned by tapping and a day planned by speaking are the same day.
 */
export async function planTodayNow(
  lang: AppLanguage,
  created: Task[] = [],
): Promise<Pick<VoicePlanReport, 'placed' | 'unplaced' | 'prepLinks' | 'plannerOffline'>> {
  const today = toDateKey();
  const all = await getAllTasks();
  const prepLinks = linkPrepTasks(created, all.filter((t) => t.date >= today), today);
  for (const link of prepLinks) {
    await updateTaskFields(link.taskId, link.patch).catch((e) =>
      console.warn('[VoicePlan] could not link prep task', link.taskId, e));
  }

  const profile = await loadProfile().catch(() => null);
  const dayTasks = await getTasksForDate(today);
  const ask = () => planDay(today, dayTasks, {
    wakeTime: profile?.defaultWakeTime,
    sleepTime: profile?.sleepTime,
    language: lang,
  });
  let plan = await ask();
  if (plan === null) {
    // The planner is arithmetic and answers in milliseconds; a miss means the
    // server was busy finishing the chat turn that just saved these tasks
    // (2026-09-28: timed out 7 s after Meira answered). Once more, a beat later.
    console.warn('[VoicePlan] planner did not answer — once more');
    await new Promise((r) => setTimeout(r, 3000));
    plan = await ask();
  }
  if (plan) {
    for (const p of plan.placed) {
      await updateTaskFields(p.id, { scheduledTime: p.start }).catch((e) =>
        console.warn('[VoicePlan] could not save a planned slot', p.id, e));
    }
  }
  return {
    placed: plan?.placed ?? [],
    unplaced: plan?.unplaced ?? [],
    prepLinks,
    plannerOffline: plan === null,
  };
}

/** After the transcript: save, link, plan, tell the screen. */
export async function runVoicePlan(
  transcript: string,
  ctx: VoiceContext,
  lang: AppLanguage,
  onStep?: (step: PlanStep) => void,
): Promise<VoicePlanReport & { reply: string }> {
  const he = lang === 'he';
  // Rule 10, on our side: every step says how long it took. On 2026-09-28 a
  // voice plan sat on "Understanding…" for 2.7 minutes and nothing could say
  // which step it was waiting on.
  const t0 = Date.now();
  const mark = (step: string) => console.warn(`[VoicePlan] ${step} +${Date.now() - t0}ms`);

  // Where she is. Started when the mic opened; normally already resolved.
  const here = await ctx.here;
  mark(`position ${here.ok ? 'ok' : here.error}`);
  let hereForAgent: { lat: number; lng: number; label?: string } | undefined;
  if (here.ok) {
    const label = await withTimeout(
      getAddressFromCoordinates(here.lat, here.lng).catch(() => null), 3000, null);
    hereForAgent = { lat: here.lat, lng: here.lng, ...(label ? { label } : {}) };
  }

  onStep?.('understanding');
  mark('asking Meira');
  const brain = await brainTurn(transcript, { here: hereForAgent, mode: 'voice_plan' });
  const created: Task[] = brain?.tasks ?? [];
  mark(brain ? `Meira answered, ${created.length} task(s)` : 'Meira did NOT answer');
  // What she said and what came back, field by field: on 28.9 reserve duty
  // for 8.10 landed as an undated, hourless task and nothing on the phone
  // could say whether the words, the server or the mapping lost the date.
  console.warn('[VoicePlan] heard:', JSON.stringify(transcript.slice(0, 200)));
  for (const t of created) {
    console.warn('[VoicePlan] saved:', JSON.stringify({ text: t.text, date: t.date, at: t.fixedTime ?? null,
      min: t.durationMinutes, cat: t.category, place: typeof t.location === 'string' ? t.location : t.location?.address ?? null }));
  }
  if (brain?.text) console.warn('[VoicePlan] reply:', JSON.stringify(brain.text.slice(0, 300)));

  // Her plan does not wait for Google. The calendar check was started when
  // the mic opened; if it has not finished by now it carries on in the
  // background (CalendarAutoSync announces what it lands), and "not finished"
  // is reported as not-run — never as a Google error, which it is not.
  const calendar = await withTimeout<CalendarSyncResult>(ctx.calendar, 5000,
    { added: 0, error: null, newTasks: [], ran: false });
  mark(calendar.ran ? 'calendar checked' : 'calendar still running — not waited for');

  onStep?.('planning');
  const planned = brain === null
    ? { placed: [], unplaced: [], prepLinks: [], plannerOffline: false }
    : await planTodayNow(lang, created);

  const report: VoicePlanReport = {
    created,
    ...planned,
    calendarError: calendar.error,
    calendarAdded: calendar.added,
    location: here.ok ? 'here' : here.error,
  };
  const { headline, problems } = describePlan(report, he, brain?.text ?? '', toDateKey());
  if (brain === null) {
    problems.unshift(he
      // Not "nothing was saved": after OUR timeout the server keeps working and
      // does save — the tasks then arrive with the next sync (rule 3).
      ? '🧠 מאירה לא ענתה בזמן — מה שנשמר יופיע כאן בעוד רגע. אפשר גם בצ׳אט'
      : "🧠 Meira didn't answer in time — anything she saved will appear here shortly. Or use the chat");
  }
  mark(`planned: ${report.placed?.length ?? 0} placed, ${report.unplaced?.length ?? 0} not`);
  emitDayPlanned({ date: toDateKey(), report, headline, problems });
  return { ...report, reply: brain?.text ?? '' };
}
