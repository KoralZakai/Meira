/**
 * localTaskExtract — understanding a message when the server cannot be reached.
 *
 * Koral, 2026-09-17: "i added again יוגה ב 11 בבוקר ביגאל אלון 94 and Meira
 * answers correctly! but now i see that nothing have been saved?! why? where
 * is the clock alarm the route the task?..."
 *
 * She was told her task was understood, and it was thrown away. Here is the
 * whole path, and every step of it looks like success:
 *
 *   CoachChatScreen  →  brainTurn()            → null, silently
 *                    →  coachTurn()            ← "the local fallback"
 *                    →  extractTasks()
 *                    →  extractServerTasks()   ← THE SERVER AGAIN
 *                                              → null
 *                    →  []
 *                    →  chit(language)         ← small talk, savedCount 0
 *
 * The fallback was not a fallback. LumiCoachEngine.extractTasks imports
 * `extractTasks as extractServerTasks from './LumiServer'` and has no other
 * source, so when the backend is unreachable — asleep on the free tier, a
 * stale token, a tunnel — a sentence that is unmistakably a task gets a warm
 * conversational reply and is discarded. Both doors out of the chat led to the
 * same lie, and neither logged anything.
 *
 * WHAT MAKES THIS FIXABLE IS THAT THE PARSER ALREADY EXISTS. Her exact
 * sentence was verified today against the on-device parsers:
 *
 *     extractHebrewPlaceParts  →  "יגאל אלון 94"   (stops before the hour)
 *     parseTimeExpression      →  11:00
 *     inferTaskDetails         →  category, duration, priority
 *
 * hooks/useTasks.addManualTask uses all three. The CHAT used none of them. So
 * this is not new understanding — it is the understanding the app already had,
 * wired to the one path that could not reach it.
 *
 * DELIBERATELY CONSERVATIVE. This runs only when the server gave nothing, and
 * it extracts at most ONE task from a message. The server's extractor splits
 * "tomorrow: gym, dentist, call mum" into three; guessing at that locally
 * would turn one honest failure into three wrong tasks. One task, or none and
 * say so.
 *
 * Pure. tests/run-local-extract.ts drives it with no device and no network.
 */
import { TaskCategory } from '../types/index';

export interface LocalExtracted {
  text: string;
  category: TaskCategory;
  priority: 'must' | 'have_to' | 'need_to' | 'nice_to_do';
  fixedTime?: string;
  durationMinutes?: number;
  location?: string;
  date: string;
  /** True when the message named an hour or a place — i.e. it is really a task. */
  confident: boolean;
}

/** Everything this needs from the app's existing parsers, injected so it stays pure. */
export interface LocalParsers {
  time: (text: string, referenceDate: string) => {
    type: string; fixedTime?: string; durationMinutes?: number; deadline?: string;
  };
  place: (text: string) => { place: string | null; activity: string | null };
  details: (text: string) => {
    category: TaskCategory; priority: 'must' | 'have_to' | 'need_to' | 'nice_to_do';
    durationMinutes: number;
  };
}

/**
 * Words that mean this is a question or a remark, not something to do.
 *
 * Without this, "מה יש לי מחר?" becomes a task called "מה יש לי מחר?" — which
 * is a worse failure than saving nothing, because she now has to delete it.
 */
const NOT_A_TASK = [
  /^\s*(מה|מתי|איפה|למה|איך|כמה|האם|מי)\b/,
  /^\s*(what|when|where|why|how|who|is|are|do|does|did|can|could|should)\b/i,
  /\?\s*$/,
  /^\s*(תודה|יופי|מעולה|אוקיי|אוקי|בסדר|כן|לא)\s*$/,
  /^\s*(thanks|thank you|ok|okay|great|nice|yes|no|sure)\s*$/i,
];

export function looksLikeAQuestion(text: string): boolean {
  const s = String(text || '').trim();
  return NOT_A_TASK.some((re) => re.test(s));
}

/**
 * One task out of one message, using only what is on the device — or null.
 *
 * Null is a real answer and the caller must say so out loud. "I could not
 * reach the server and I could not work this out myself" is a sentence she can
 * act on; a warm reply that saved nothing is not.
 */
export function extractLocally(
  input: string, today: string, parsers: LocalParsers,
): LocalExtracted | null {
  const text = String(input || '').trim();
  if (text.length < 3) return null;
  if (looksLikeAQuestion(text)) return null;

  const time = parsers.time(text, today);
  const { place } = parsers.place(text);
  const details = parsers.details(text);

  // An hour or a place is what makes a sentence a commitment rather than a
  // remark. Without either, this is too thin to save behind her back — the
  // server would have had context (her history, the conversation) that this
  // does not, and inventing a task from "אולי אלך להתאמן" is how a task list
  // stops being trusted.
  const confident = Boolean(time.fixedTime || place);
  if (!confident) return null;

  return {
    text,
    category: details.category,
    priority: details.priority,
    fixedTime: time.fixedTime,
    durationMinutes: time.durationMinutes ?? details.durationMinutes,
    location: place ?? undefined,
    date: /^\d{4}-\d{2}-\d{2}$/.test(time.deadline || '') ? time.deadline! : today,
    confident,
  };
}

/** What to say when the server was unreachable — honest, and short. */
export function describeLocalSave(
  saved: LocalExtracted | null, he: boolean,
): string {
  if (saved) {
    const when = saved.fixedTime ? ` ב-${saved.fixedTime}` : '';
    const whenEn = saved.fixedTime ? ` at ${saved.fixedTime}` : '';
    return he
      ? `שמרתי${when} — לא הצלחתי להגיע לשרת, אז זה נשמר על המכשיר. המסלול יחושב כשהחיבור יחזור.`
      : `Saved${whenEn} — I couldn't reach the server, so this is on the device. The route will be worked out when the connection is back.`;
  }
  return he
    ? '⚠️ לא הצלחתי להגיע לשרת ולא הצלחתי להבין את זה לבד — לא שמרתי כלום. נסי שוב, או הוסיפי ידנית.'
    : "⚠️ I couldn't reach the server and couldn't work this out myself — nothing was saved. Try again, or add it manually.";
}
