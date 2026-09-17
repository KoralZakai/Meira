/**
 * briefDigest — the research, delivered when it is still useful.
 *
 * Koral, 2026-09-17, about a phone interview she had that day:
 *
 *   "Insert the Tavily summary about the people the user has meetings with —
 *    collect data from the web, collect data from Gmail, if they had a
 *    conversation there remind what they talked about, prepare the user with
 *    that data a day before the meeting and 1-2 hours before the meeting
 *    (like today i had a phone interview with some Team leader in Ceva about
 *    a DSP C++ role, i expected a preparation about the team leader, about
 *    ceva about the role — inside the task, edit the task and insert a summery
 *    and reminders)."
 *
 * The research already existed. server/meeting_brief.py has been doing it
 * since 2026-09-16, sourced and cited, and MeetingBriefService caches it on
 * the phone. What it did NOT do was arrive anywhere she would see it: it was
 * drawn on one card, on one screen, for the single next meeting, and only if
 * that screen happened to be open. A briefing you have to go and look for is
 * not a briefing.
 *
 * So this module does the last step, and only that step: turn a researched
 * brief into (a) something short enough to survive a notification and (b)
 * something that can sit ON the task, where she will find it when she taps it.
 *
 * TWO MOMENTS, deliberately different in kind:
 *
 *   the night before   the whole shape of it — who, what they do, what you
 *                      already said to each other. There is still time to read
 *                      a paragraph and to prepare.
 *   an hour before     ONE line and the questions. She is about to walk in or
 *                      pick up the phone; anything longer will not be read,
 *                      and a briefing that arrives unread is worse than none
 *                      because it used up the alert.
 *
 * NOTHING IS INVENTED HERE. Every line originates in a bullet the server
 * already refused to emit without a citation. This module only shortens and
 * orders; it never composes. The citation markers ("[1]") ARE stripped for the
 * notification — a source number with no source list to look it up in is
 * noise — but kept in the copy written onto the task, where the sources are.
 *
 * Pure. tests/run-brief-digest.ts covers every branch with no network.
 */
import { AppLanguage } from '../types/index';

/** The shape MeetingBriefService receives from the server. */
export interface BriefLike {
  ok?: boolean;
  headline_he?: string;
  headline_en?: string;
  company_he?: string[];
  company_en?: string[];
  person_he?: string[];
  person_en?: string[];
  history_he?: string[];
  history_en?: string[];
  questions_he?: string[];
  questions_en?: string[];
  confidence?: 'high' | 'medium' | 'low';
  subjects?: { company?: string; person?: string; person_role?: string; role_title?: string };
}

/**
 * The brief as it is stored on the task.
 *
 * Both languages are kept rather than one resolved at fetch time: this is a
 * cache that outlives a settings change, and re-running a Tavily search
 * because she switched the app to English would be a real cost for no reason.
 */
export interface TaskBrief {
  headlineHe?: string;
  headlineEn?: string;
  /** Who and what — company, person, and what they last said to each other. */
  linesHe: string[];
  linesEn: string[];
  questionsHe: string[];
  questionsEn: string[];
  /** Low confidence is shown, never hidden: it changes how much to lean on it. */
  confidence?: 'high' | 'medium' | 'low';
  fetchedAt: number;
}

/** Source markers belong with the source list, not in a notification. */
export function stripCitations(line: string): string {
  return line.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').trim();
}

const take = (xs?: string[] | null, n = 3): string[] =>
  (Array.isArray(xs) ? xs : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, n);

/**
 * A researched brief → the copy stored on the task, or null when there is
 * nothing worth storing.
 *
 * "Nothing worth storing" is a real answer and must stay one. A brief with a
 * headline and no facts is the shape a half-failed research run produces, and
 * writing it onto the task would put a confident empty summary in front of her.
 */
export function digestFromBrief(brief: BriefLike | null | undefined, now = Date.now()): TaskBrief | null {
  if (!brief || brief.ok === false) return null;
  // History first: what she and this person already agreed outranks what the
  // company's website says about itself.
  const linesHe = [...take(brief.history_he, 2), ...take(brief.company_he, 2), ...take(brief.person_he, 2)];
  const linesEn = [...take(brief.history_en, 2), ...take(brief.company_en, 2), ...take(brief.person_en, 2)];
  const questionsHe = take(brief.questions_he, 3);
  const questionsEn = take(brief.questions_en, 3);
  if (!linesHe.length && !linesEn.length && !questionsHe.length && !questionsEn.length) return null;
  return {
    headlineHe: brief.headline_he?.trim() || undefined,
    headlineEn: brief.headline_en?.trim() || undefined,
    linesHe, linesEn, questionsHe, questionsEn,
    confidence: brief.confidence,
    fetchedAt: now,
  };
}

const pick = (he: boolean, hebrew: string[], english: string[]): string[] =>
  (he && hebrew.length ? hebrew : english.length ? english : hebrew);

/** The one-sentence version. Falls back across languages before giving up. */
export function briefHeadline(brief: TaskBrief | null | undefined, lang: AppLanguage): string | undefined {
  if (!brief) return undefined;
  const he = lang === 'he';
  const first = he ? brief.headlineHe : brief.headlineEn;
  return stripCitations(first || brief.headlineEn || brief.headlineHe || '') || undefined;
}

/**
 * The body of a pre-meeting notification.
 *
 * `when` decides how much of it survives, because the two moments are not the
 * same moment. Returns undefined when there is nothing to say — a notification
 * with an empty body is a notification that taught her to dismiss the next one.
 */
export function briefAlertBody(
  brief: TaskBrief | null | undefined,
  lang: AppLanguage,
  when: 'day-before' | 'hour-before',
): string | undefined {
  if (!brief) return undefined;
  const he = lang === 'he';
  const headline = briefHeadline(brief, lang);
  const lines = pick(he, brief.linesHe, brief.linesEn).map(stripCitations).filter(Boolean);
  const questions = pick(he, brief.questionsHe, brief.questionsEn).map(stripCitations).filter(Boolean);

  if (when === 'hour-before') {
    // One line, and ONE question. She is about to pick up the phone.
    const parts = [headline, questions[0] ? (he ? `לשאול: ${questions[0]}` : `Ask: ${questions[0]}`) : ''];
    const body = parts.filter(Boolean).join(' · ');
    return body || undefined;
  }

  const parts = [headline, ...lines.slice(0, 3)];
  if (questions.length) {
    parts.push(he ? `לשאול: ${questions[0]}` : `Ask: ${questions[0]}`);
  }
  const body = parts.filter(Boolean).join(' · ');
  return body || undefined;
}

/**
 * The brief as it is written INTO the task, citations and all.
 *
 * This is the copy she reads with the source list in front of her, so the
 * markers stay: "Ceva makes DSP cores [2]" is checkable and "Ceva makes DSP
 * cores" is something she has to take on trust. Given what this app has got
 * wrong before — an invented address — checkable is the whole point.
 */
export function briefNote(brief: TaskBrief | null | undefined, lang: AppLanguage): string | undefined {
  if (!brief) return undefined;
  const he = lang === 'he';
  const lines = pick(he, brief.linesHe, brief.linesEn);
  const questions = pick(he, brief.questionsHe, brief.questionsEn);
  const headline = he ? brief.headlineHe : brief.headlineEn;
  const out: string[] = [];
  if (headline) out.push(headline);
  if (lines.length) out.push('', ...lines.map((l) => `• ${l}`));
  if (questions.length) {
    out.push('', he ? 'שאלות לשאול:' : 'Questions to ask:', ...questions.map((q) => `– ${q}`));
  }
  if (brief.confidence === 'low') {
    out.push('', he
      ? '⚠️ לא בטוח שזיהיתי נכון את החברה/האדם — כדאי לאמת'
      : "⚠️ Not certain this is the right company/person — worth checking");
  }
  return out.length ? out.join('\n') : undefined;
}
