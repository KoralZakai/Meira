/**
 * routineDays — "קיקבוקס 20:30–21:30: every day, or on certain days?"
 *
 * The first of Meira's questions (6.10). A routine she wrote with an hour but
 * no day used to be read as every day, silently. Now it is detected here,
 * asked once (QuestionService decides when), and her answer is written into
 * the line WHERE IT LIVES — her Routines box on this phone, what she told
 * Meira on the server, or both — so every reader sees the same days.
 */
import { loadProfile, saveProfile } from '../../services/UserProfileStorage';
import { answerQuestion, QuestionAnswerInput, RoutineDaysAnswer } from '../../services/LumiServer';
import { Routine, withDays } from '../../utils/routines';
import { routineTitle } from '../../utils/routineRows';
import { addMinutes } from '../../utils/timeUtils';
import { AnswerResult, MeiraQuestion, failureOf } from '../types';

export const KIND = 'routineDays' as const;

/** The routine's key: the same `title|HH:MM` its row on Today carries. */
export function subjectOf(r: Routine): string {
  return `${routineTitle(r).title.toLowerCase()}|${r.time || ''}`;
}

export function detectRoutineDays(routines: Routine[]): MeiraQuestion[] {
  const seen = new Set<string>();
  const out: MeiraQuestion[] = [];
  for (const r of routines) {
    if (r.source !== 'notes' || !r.time || r.daysFrom !== 'unsaid' || !r.origin?.length) continue;
    const subject = subjectOf(r);
    if (seen.has(subject)) continue;
    seen.add(subject);
    const end = addMinutes(r.time, r.durationMinutes || 60);
    out.push({
      key: `${KIND}:${subject}`,
      kind: KIND,
      subject,
      title: `${routineTitle(r).title} · ${r.time}–${end}`,
      ask: r.perWeek
        ? { en: `You said ${r.perWeek}× a week — which days?`, he: `אמרת ${r.perWeek} פעמים בשבוע — באילו ימים?` }
        : { en: 'Every day, or on certain days?', he: 'כל יום, או בימים מסוימים?' },
      context: { line: r.text, origin: r.origin, ...(r.perWeek ? { perWeek: r.perWeek } : {}) },
    });
  }
  return out;
}

function daysOf(a: RoutineDaysAnswer): number[] | 'varies' {
  if (a.choice === 'varies') return 'varies';
  if (a.choice === 'every_day') return [0, 1, 2, 3, 4, 5, 6];
  return a.days;
}

/** Rewrite the line in her Routines box on this phone. false = the line is not there any more. */
async function rewriteBoxLine(line: string, next: string): Promise<boolean> {
  const profile = await loadProfile();
  const notes = String((profile as any)?.routinesNotes || '');
  const at = notes.indexOf(line);
  if (!profile || at < 0) return false;
  await saveProfile({ ...profile, routinesNotes: notes.slice(0, at) + next + notes.slice(at + line.length) } as any);
  return true;
}

export interface RoutineDaysApply {
  result: AnswerResult;
  /** The server part, when it must be retried (QuestionService's outbox). */
  retry?: QuestionAnswerInput;
}

export async function applyRoutineDays(q: MeiraQuestion, a: RoutineDaysAnswer): Promise<RoutineDaysApply> {
  const next = withDays(q.context.line, daysOf(a));
  let savedLocally = false;
  let localGone = false;
  if (q.context.origin.includes('box')) {
    try {
      savedLocally = await rewriteBoxLine(q.context.line, next);
      localGone = !savedLocally;
    } catch (e) {
      console.warn('[Questions] Routines box not rewritten', e);
      return { result: { ok: false, savedLocally: false, reason: 'local' } };
    }
  }
  const input: QuestionAnswerInput = {
    kind: 'routine_days',
    subject: q.subject,
    line: q.context.line,
    answer: a,
    rewrite_told: q.context.origin.includes('told'),
  };
  const sent = await answerQuestion(input);
  if (!sent.ok) {
    const reason = failureOf(sent.reason);
    // Bad sign-in or no such route yet: retrying will not help until she acts or we deploy.
    const retry = reason === 'offline' || reason === 'server' ? input : undefined;
    console.warn('[Questions] answer not saved with Meira:', sent.reason);
    return { result: { ok: false, savedLocally, queued: Boolean(retry), reason }, retry };
  }
  const server = sent.data;
  const gone = localGone && !q.context.origin.includes('told');
  if (!server.ok || gone) {
    return { result: { ok: false, savedLocally, reason: 'line_changed', effect: server.effect, proposal: server.proposal } };
  }
  return { result: { ok: true, savedLocally, effect: server.effect, proposal: server.proposal } };
}

/** For the background retry: the answer already applied on the phone, sent again. */
export async function resendRoutineDays(input: QuestionAnswerInput): Promise<'done' | 'retry' | 'drop'> {
  const sent = await answerQuestion(input);
  if (sent.ok) return 'done';
  const reason = failureOf(sent.reason);
  return reason === 'offline' || reason === 'server' ? 'retry' : 'drop';
}

