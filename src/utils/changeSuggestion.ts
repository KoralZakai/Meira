/**
 * changeSuggestion — the offer on the Today card: "study today at 20:00?" (19.10).
 *
 * The SERVER proposes the hour (POST /app/change/suggest → reschedule.suggest_for_change:
 * a window that is really free the day before). The PHONE books it: a task in her diary and
 * a local reminder at the level of nudging she chose. This file is the booking, with its
 * hands injected so a failure can be tested: nothing is claimed that did not save —
 * "added ✓" only when the task saved, "🔔" only when a reminder was really scheduled
 * (silent-state rule 3). No travel question lives here: the way there is travelLadder's.
 *
 * Pure but for the deps. tests/run-change-suggestion.ts.
 */
import type { AppLanguage, Task } from '../types/index';
import { ChangeRecord, momentLabel } from './changeRecord';
import { NudgeLevel, nudgesFor } from './nudgeLevel';

export interface Proposal { date: string; time: string; minutes: number; windows: Array<{ start: string; end: string }> }

export interface SuggestResponse {
  ok: boolean;
  prep: boolean;
  kind: 'later' | 'earlier' | 'sameDay';
  proposal: Proposal | null;
  /** Whole-hour starts that fit, for "another hour". */
  starts: string[];
  /** 7 / 8 / 9 as far as the trip allows; [] when the event is too early. */
  morning: string[];
}

export interface BookDeps {
  addTask: (draft: Omit<Task, 'id' | 'createdAt' | 'completedAt'>) => Promise<Task>;
  /** null = it could not be scheduled; callers may not say it was. */
  scheduleReminderAt: (when: Date, text: string) => Promise<string | null>;
  level: NudgeLevel;
  now: Date;
}

export interface BookResult { saved: boolean; reminded: boolean; line: string }

const HHMM = /^\d{2}:\d{2}$/;

/** "היום" / "מחר" / "ד׳ 21.10" — always something she can place (rule 4). */
export function whenWord(day: string, today: string, language: AppLanguage): string {
  const dn = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
  const delta = dn(day) - dn(today);
  if (delta === 0) return language === 'he' ? 'היום' : 'today';
  if (delta === 1) return language === 'he' ? 'מחר' : 'tomorrow';
  return momentLabel({ date: day }, language);
}

export function studyChipLabel(p: Pick<Proposal, 'date' | 'time'>, today: string, language: AppLanguage): string {
  return language === 'he'
    ? `לימוד ${whenWord(p.date, today, 'he')} ${p.time}`
    : `Study ${whenWord(p.date, today, 'en')} ${p.time}`;
}

function lowerFirst(s: string): string { return s ? s[0].toLowerCase() + s.slice(1) : s; }

export function studyLabel(rec: ChangeRecord, language: AppLanguage): string {
  return language === 'he' ? `לימוד לקראת ${rec.titleHe}` : `Study for ${lowerFirst(rec.title)}`;
}

function at(day: string, hhmm: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi, 0, 0);
}

/** The diary entry. `prepForTaskId` marks it as preparation FOR the interview, so the interview
 *  rule never prepares for the preparation (interviewPrep.isPrepBlock); `pickedAt` makes it hers. */
export function studyDraft(rec: ChangeRecord, day: string, hhmm: string, minutes: number, language: AppLanguage, now = Date.now()) {
  return {
    text: studyLabel(rec, language),
    category: 'course' as const,
    priority: 'have_to' as const,
    isFixed: true,
    fixedTime: hhmm,
    durationMinutes: minutes,
    date: day,
    status: 'pending' as const,
    source: 'suggested',
    prepForTaskId: rec.taskId,
    pickedAt: now,
    historicalDurations: [] as number[],
  } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>;
}

/** Save the study block and the reminders. Says only what landed. */
export async function bookStudy(
  deps: BookDeps, rec: ChangeRecord, day: string, hhmm: string, minutes: number, language: AppLanguage,
): Promise<BookResult> {
  const he = language === 'he';
  if (!HHMM.test(hhmm) || at(day, hhmm).getTime() <= deps.now.getTime()) {
    return { saved: false, reminded: false, line: he ? 'השעה הזאת כבר עברה 🙈' : 'That time has passed 🙈' };
  }
  try {
    await deps.addTask(studyDraft(rec, day, hhmm, minutes, language, deps.now.getTime()));
  } catch (e) {
    console.warn('[changeSuggestion] study block not saved', e);
    return { saved: false, reminded: false, line: he ? 'לא הצלחתי לשמור את הלימוד 🙈 נסי שוב.' : "I couldn't save the study time 🙈 Try again." };
  }
  const label = studyLabel(rec, language);
  let reminded = false;
  for (const n of nudgesFor(deps.level, hhmm, label, he)) {
    const when = at(day, n.at);
    if (when.getTime() <= deps.now.getTime()) continue;
    const id = await deps.scheduleReminderAt(when, n.text).catch((e) => { console.warn('[changeSuggestion] reminder failed', e); return null; });
    if (n.at === hhmm && id) reminded = true;
  }
  const when = momentLabel({ date: day, time: hhmm }, language);
  return { saved: true, reminded, line: `${he ? 'הוספתי ליומן' : 'Added to your diary:'} ${label} · ${when} ✓${reminded ? ' 🔔' : ''}` };
}

/** The wake-up on the day of the event: a reminder only — the phone already mints its own morning
 *  prep block for an interview, and a second diary entry would be a twin. */
export async function bookWake(
  deps: BookDeps, rec: ChangeRecord, hhmm: string, language: AppLanguage,
): Promise<BookResult> {
  const he = language === 'he';
  const label = he ? `ללמוד לפני ${rec.titleHe}` : `Study before ${lowerFirst(rec.title)}`;
  let reminded = false;
  for (const n of nudgesFor(deps.level, hhmm, label, he)) {
    const when = at(rec.after.date, n.at);
    if (when.getTime() <= deps.now.getTime()) continue;
    const id = await deps.scheduleReminderAt(when, n.text).catch((e) => { console.warn('[changeSuggestion] wake reminder failed', e); return null; });
    if (n.at === hhmm && id) reminded = true;
  }
  if (!reminded) return { saved: false, reminded: false, line: he ? 'לא הצלחתי לקבוע את התזכורת 🙈' : "I couldn't set that reminder 🙈" };
  return { saved: true, reminded: true, line: he
    ? `אעיר אותך ב-${hhmm} ב${momentLabel({ date: rec.after.date }, 'he')} 🔔`
    : `I'll wake you at ${hhmm} on ${momentLabel({ date: rec.after.date }, 'en')} 🔔` };
}
