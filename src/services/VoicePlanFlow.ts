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
import { namesInTitle } from '../utils/namesInTitle';
import { AppLanguage, Task } from '../types/index';
import { CalendarSyncResult, syncCalendarNow } from './CalendarAutoSync';
import { HereResult, getAddressFromCoordinates, getHereDetailed } from './LocationService';
import { brainTurn } from './LumiBrain';
import { planDay } from './LumiServer';
import { getAllTasks, getTasksForDate, loadProfile, toDateKey, updateTaskFields } from './TaskStorage';
import { loadKnownPlaces } from './KnownPlacesStore';
import { PLACE_NAME_CORRECTIONS } from '../utils/fuzzyMatch';
import type { LookupAnswer } from '../utils/answerCard';
import type { ChainAnswer } from '../utils/chainAnswer';
import { emitDayPlanned } from './DayEvents';
import { VoicePlanReport, describePlan, linkPrepTasks } from '../utils/voicePlan';

export interface VoiceContext {
  calendar: Promise<CalendarSyncResult>;
  here: Promise<HereResult>;
  /** The street name for `here` — a nicety for the agent, never waited for. */
  label: Promise<string | null>;
}

export type PlanStep = 'understanding' | 'planning';

/** Start the checks that do not depend on what she says. Call when the mic opens. */
export function beginVoiceContext(lang: AppLanguage): VoiceContext {
  const here = getHereDetailed(8000);
  return {
    calendar: syncCalendarNow(lang, 'voice').catch((e): CalendarSyncResult => {
      console.warn('[VoicePlan] calendar sync threw', e);
      return { added: 0, error: String(e).slice(0, 160), newTasks: [], ran: false };
    }),
    here,
    // Looked up while she talks, not after: it used to start only once the
    // transcript was in, and held the call to Meira for up to 3 s.
    label: here.then((h) => (h.ok ? getAddressFromCoordinates(h.lat, h.lng) : null))
      .catch((e) => { console.warn('[VoicePlan] street name lookup failed', e); return null; }),
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/** A NAME is at most three words; anything longer is a sentence, and the
 * server drops it anyway (stt.clean_prompt) — so it is never sent. */
const asName = (s: string | undefined | null): string | null => {
  const t = (s ?? '').split(',')[0].trim();
  return t && t.split(/\s+/).length <= 3 && !t.includes('?') ? t.slice(0, 40) : null;
};

/**
 * Words Whisper should spell her way — NAMES only: the people and places on
 * what is coming up, the places she goes, her own name. "Ceva", not "Siva";
 * "רעננה", not "ראננה". Task titles used to be sent whole, and every one
 * longer than three words was dropped on the server, so the hint was mostly
 * empty. Started when the mic opens (useVoiceCapture), not after she stops.
 */
export async function buildVoiceHint(): Promise<string> {
  const people: string[] = [];
  const places: string[] = [];
  const titles: string[] = [];
  try {
    const profile = await loadProfile().catch(() => null);
    const me = asName(profile?.name);
    if (me) people.push(me);
    const today = toDateKey();
    const soon = toDateKey(new Date(Date.now() + 14 * 86400000));
    const tasks = (await getAllTasks())
      .filter((t) => t.date >= today && t.date <= soon && t.status !== 'complete')
      .slice(0, 25);
    for (const t of tasks) {
      const who = asName(t.contact?.name);
      if (who) people.push(who);
      // The person inside the title — "שיחה עם דותן" (20.10: heard five ways).
      people.push(...namesInTitle(t.text));
      const loc = t.location;
      const where = typeof loc === 'string'
        ? asName(loc)
        : asName(loc?.displayName) ?? asName(loc?.address);
      if (where) places.push(where);
      const what = asName(t.text);
      if (what) titles.push(what);
    }
    const known = await loadKnownPlaces().catch(() => ({}));
    for (const place of Object.values(known)) {
      const where = asName(place.address);
      if (where) places.push(where);
    }
  } catch (e) {
    console.warn('[VoicePlan] could not build the vocabulary hint', e);
  }
  // Most useful first: the server keeps the first dozen.
  const words = ['Meira', ...people, ...places, ...titles,
    ...Object.values(PLACE_NAME_CORRECTIONS)];
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
): Promise<VoicePlanReport & { reply: string; type?: string; answer?: LookupAnswer; chain?: ChainAnswer }> {
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
    // The coordinates are what the agent routes from; the street name is only
    // a nicety. Take it if the lookup started at mic-open has already landed,
    // never wait for it (it held this call for up to 3 s, 19.10).
    const label = await withTimeout(ctx.label, 0, null);
    hereForAgent = { lat: here.lat, lng: here.lng, ...(label ? { label } : {}) };
    mark(label ? 'street name ready' : 'street name not ready — coordinates only');
  }

  onStep?.('understanding');
  mark('asking Meira');
  const brain = await brainTurn(transcript, { here: hereForAgent, mode: 'voice_plan' });
  const created: Task[] = brain?.tasks ?? [];
  mark(brain ? `Meira answered, ${created.length} task(s)` : 'Meira did NOT answer');
  // What she said and what came back, field by field: on 28.9 reserve duty
  // for 8.10 landed as an undated, hourless task and nothing on the phone
  // could say whether the words, the server or the mapping lost the date.
  // Shapes only — what she said and where she is going stay out of logcat (7.10).
  console.warn('[VoicePlan] heard', transcript.length, 'chars');
  for (const t of created) {
    console.warn('[VoicePlan] saved:', JSON.stringify({ date: t.date, at: t.fixedTime ?? null,
      min: t.durationMinutes, cat: t.category, placed: Boolean(t.location) }));
  }
  if (brain?.text) console.warn('[VoicePlan] reply', brain.text.length, 'chars');

  // Her plan does not wait for Google. The calendar check was started when
  // the mic opened, and has had her whole sentence, the transcription and
  // Meira's turn to finish; if it still has not, it carries on in the
  // background (CalendarAutoSync announces what it lands), and "not finished"
  // is reported as not-run — never as a Google error, which it is not. One
  // more second, not five (19.10): a slow Google must not hold her answer.
  const calendar = await withTimeout<CalendarSyncResult>(ctx.calendar, 1000,
    { added: 0, error: null, newTasks: [], ran: false });
  mark(calendar.ran ? 'calendar checked' : 'calendar still running — not waited for');

  // She ASKED something ("how do I get home?") — nothing to plan, and the
  // answer belongs in the chat (her pick, 7.10). The day is left as it is.
  if (brain?.type === 'answer') {
    mark('an answer, not a plan');
    return {
      created: [], placed: [], unplaced: [], prepLinks: [], plannerOffline: false,
      calendarError: null, calendarAdded: 0, location: here.ok ? 'here' : here.error,
      reply: brain.text, type: 'answer', ...(brain.answer ? { answer: brain.answer } : {}),
      ...(brain.chain ? { chain: brain.chain } : {}),
    };
  }

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
