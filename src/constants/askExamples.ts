/**
 * askExamples — "what can I ask Meira?" (21.10, Koral: give the user starters, so they know
 * what the chat can do). Each example is a PREFIX: ending in "…" it is put in the box for
 * the user to finish; a whole question is sent as it is. Both languages, same list.
 */
export interface AskExample { id: string; en: string; he: string }
export interface AskGroup { id: string; titleEn: string; titleHe: string; icon: string; examples: AskExample[] }

export const ASK_GROUPS: AskGroup[] = [
  {
    id: 'day', icon: '📅', titleEn: 'My day', titleHe: 'היום שלי',
    examples: [
      { id: 'tomorrow', en: 'What do I have tomorrow?', he: 'מה יש לי מחר?' },
      { id: 'free', en: 'When am I free for…', he: 'מתי אני פנויה ל…' },
      { id: 'plan', en: 'Plan my day', he: 'תכנני לי את היום' },
    ],
  },
  {
    id: 'travel', icon: '🧭', titleEn: 'Getting around', titleHe: 'נסיעות',
    examples: [
      { id: 'home', en: 'When do I get home tomorrow from…', he: 'מתי אני חוזרת הביתה מחר מ…' },
      { id: 'there', en: 'How do I get to…', he: 'איך אני מגיעה ל…' },
      { id: 'nearest', en: 'The nearest … by bike', he: 'הכי קרוב … באופניים' },
    ],
  },
  {
    id: 'change', icon: '🔁', titleEn: 'Change something', titleHe: 'לשנות משהו',
    examples: [
      { id: 'moved', en: 'The … moved to…', he: 'ה… נדחה ל…' },
      { id: 'rename', en: 'Change … to…', he: 'תשני את … ל…' },
      { id: 'cancel', en: 'Cancel …', he: 'תבטלי את …' },
    ],
  },
  {
    id: 'add', icon: '➕', titleEn: 'Add or remember', titleHe: 'להוסיף ולזכור',
    examples: [
      { id: 'have', en: 'I have … on … at…', he: 'יש לי … ביום … ב…' },
      { id: 'remind', en: 'Remind me to … at…', he: 'תזכירי לי … ב…' },
      { id: 'routine', en: 'I have yoga on … at…', he: 'יש לי יוגה ביום … ב…' },
    ],
  },
];

/** A whole question is sent; a starter ending in "…" waits for the user to finish it. */
export const isStarter = (text: string): boolean => /…\s*$/.test(text);
