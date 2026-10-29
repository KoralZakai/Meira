/**
 * ChangeSuggestService — the wiring behind the chips on a Today change card (19.10).
 *
 * Ask the server for a free hour (POST /app/change/suggest), then save what she accepts:
 * the study block in her diary and local reminders at the nudge level she chose in Profile.
 * The decisions and the words are in utils/changeSuggestion (tested with fake hands); this
 * file only hands it the real ones.
 *
 * TRIGGER (rule 7): the card is on Today, so asking happens when the card is drawn; nothing
 * here runs unseen. A server that cannot be reached is returned as a reason, never as "no hour".
 */
import { getAllTasks, addTask, deleteTasks } from './TaskStorage';
import { scheduleReminderAt, cancelTaskNotifications } from './NotificationService';
import { applyGapIdea, GapIdea, ideaTitle, suggestForGap } from './GapFillService';
import type { DayGap } from '../utils/findGaps';
import { loadProfile } from './UserProfileStorage';
import { changeSuggest, Reasoned } from './LumiServer';
import { ChangeRecord } from '../utils/changeRecord';
import { BookDeps, BookResult, SuggestResponse, bookStudy, bookWake } from '../utils/changeSuggestion';
import { nudgeLevelOf } from '../utils/nudgeLevel';
import { AppLanguage } from '../types/index';
import { getTodayString } from '../utils/timeUtils';

const cache = new Map<string, Reasoned<SuggestResponse>>();

/** The server's proposal for this change. Cached per card; a failure is not cached. */
export async function suggestionFor(rec: ChangeRecord, retry = false): Promise<Reasoned<SuggestResponse>> {
  const hit = cache.get(rec.key);
  if (hit && !retry) return hit;
  const today = getTodayString();
  const all = await getAllTasks().catch((e) => { console.warn('[ChangeSuggest] tasks unreadable', e); return []; });
  // The days that could hold the study block: today up to the day before the event.
  const rows = all
    .filter((t) => t.id !== rec.taskId && t.date >= today && t.date < rec.after.date && t.status !== 'complete')
    .slice(0, 60)
    .map((t) => ({
      id: t.id, date: t.date, fixed_time: t.fixedTime || t.scheduledTime, duration_minutes: t.durationMinutes,
      status: t.status, category: t.category,
    }));
  const res = await changeSuggest({
    task: { id: rec.taskId, category: rec.category, text: rec.title },
    before: rec.before, after: rec.after, rows,
  });
  if (res.ok) cache.set(rec.key, res);
  return res;
}

async function deps(): Promise<BookDeps> {
  const profile = await loadProfile().catch(() => null);
  return {
    addTask,
    scheduleReminderAt: (when, text) => scheduleReminderAt(when, text, { source: 'change-suggest' }),
    level: nudgeLevelOf(profile),
    now: new Date(),
  };
}

export async function acceptStudy(rec: ChangeRecord, day: string, hhmm: string, minutes: number, language: AppLanguage): Promise<BookResult> {
  return bookStudy(await deps(), rec, day, hhmm, minutes, language);
}

export async function acceptWake(rec: ChangeRecord, hhmm: string, language: AppLanguage): Promise<BookResult> {
  return bookWake(await deps(), rec, hhmm, language);
}

// ── a cancelled event ───────────────────────────────────────────────────────

/** Remove the cancelled event from her day, and the prep blocks that were for it. Says what really went. */
export async function removeCancelled(rec: ChangeRecord, language: AppLanguage): Promise<{ ok: boolean; line: string }> {
  const he = language === 'he';
  try {
    const ids = [rec.taskId, ...(rec.orphanIds ?? [])];
    const all = await getAllTasks();
    for (const t of all.filter((x) => ids.includes(x.id))) {
      await cancelTaskNotifications(t).catch((e) => console.warn('[ChangeSuggest] alerts not cancelled', t.id, e));
    }
    const removed = await deleteTasks(ids);
    if (!removed) return { ok: false, line: he ? 'לא מצאתי מה להסיר 🙈' : 'Nothing to remove was found 🙈' };
    const extra = removed - 1;
    return { ok: true, line: he
      ? `הסרתי את ${rec.titleHe}${extra > 0 ? ` ו-${extra} הכנות שלו` : ''} ✓`
      : `Removed ${rec.title}${extra > 0 ? ` and ${extra} prep block${extra === 1 ? '' : 's'}` : ''} ✓` };
  } catch (e) {
    console.warn('[ChangeSuggest] removal failed', e);
    return { ok: false, line: he ? 'לא הצלחתי להסיר 🙈 נסי שוב.' : "I couldn't remove it 🙈 Try again." };
  }
}

export interface FillOffer { idea: GapIdea; gap: DayGap; label: string }

/** The best thing for the window the cancellation left, or null (then the card simply says nothing). */
export async function fillOfferFor(rec: ChangeRecord, language: AppLanguage): Promise<FillOffer | null> {
  if (!rec.freed) return null;
  const gap: DayGap = { start: rec.freed.start, end: rec.freed.end, minutes: rec.freed.minutes, endsAtDeparture: false };
  try {
    const ideas = await suggestForGap(gap, { today: rec.before.date, language });
    const idea = ideas[0];
    if (!idea) return null;
    return { idea, gap, label: `${ideaTitle(idea, language)} · ${idea.startAt || gap.start}` };
  } catch (e) {
    console.warn('[ChangeSuggest] no fill idea', e);
    return null;
  }
}

export async function acceptFill(rec: ChangeRecord, offer: FillOffer, language: AppLanguage): Promise<{ ok: boolean; line: string }> {
  const he = language === 'he';
  try {
    await applyGapIdea(offer.idea, offer.gap, rec.before.date);
    return { ok: true, line: he ? `הוספתי: ${offer.label} ✓` : `Added: ${offer.label} ✓` };
  } catch (e) {
    console.warn('[ChangeSuggest] fill not saved', e);
    return { ok: false, line: he ? 'לא הצלחתי להוסיף 🙈' : "I couldn't add it 🙈" };
  }
}
