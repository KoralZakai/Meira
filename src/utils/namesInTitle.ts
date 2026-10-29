/**
 * namesInTitle — the PEOPLE in a task title, for Whisper's spelling hint.
 *
 * 20.10: "שיחה עם דותן" was heard five different ways. The voice hint sent
 * names only (a title longer than three words is dropped on the server), and
 * the person lived INSIDE the title — so the one word that mattered never
 * reached Whisper. This pulls it out: the word after עם / אצל / את, a glued ל
 * after "call"-words ("להתקשר לדותן"), and English "with / call / meet X".
 */
const NOT_A_NAME = new Set([
  'מחר', 'היום', 'הערב', 'בבוקר', 'זום', 'בזום', 'הרופא', 'הרופאה', 'הבוס', 'הצוות', 'הלקוח',
  'הלקוחה', 'החברה', 'המשפחה', 'כולם', 'אמא', 'אבא', 'זה', 'זאת', 'הזמנה',
]);
const EN_NOT = new Set(['the', 'my', 'a', 'an', 'team', 'boss', 'client', 'doctor', 'zoom', 'everyone', 'tomorrow', 'today']);

export function namesInTitle(text: string | undefined | null): string[] {
  const s = String(text || '');
  const out: string[] = [];
  const add = (w?: string) => {
    const name = (w || '').trim();
    if (name.length < 2) return;
    if (NOT_A_NAME.has(name) || EN_NOT.has(name.toLowerCase())) return;
    if (!out.includes(name)) out.push(name);
  };
  for (const m of s.matchAll(/(?:^|\s)(?:עם|אצל|את)\s+([א-ת]{2,})/g)) add(m[1]);
  for (const m of s.matchAll(/(?:להתקשר|התקשרות|לדבר|לפגוש|לכתוב|להזכיר)\s+ל([א-ת]{2,})/g)) add(m[1]);
  for (const m of s.matchAll(/\b(?:with|call|meet|text|email)\s+([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-]+)?)/g)) add(m[1]);
  return out;
}
