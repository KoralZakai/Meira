import { AppLanguage } from '../types/models';

/**
 * "Hear my day", SHORT (13.10, Koral: "it's too long! heavy, repetitive").
 *
 * It used to read the date and the hour, a random motivational line and then
 * EVERY title on the day — the interview, its "Prep for…" block, its "Study
 * for… right up until you leave" block, the same meeting from two calendars —
 * and a pep line with "את/ה". CLAUDE.md: one or two sentences.
 *
 * Now: the greeting; the next timed things still ahead (at most three, each
 * once), the first trip with its leave time; how many more; one wish when
 * there is an interview. Prep blocks are Meira's scaffolding, not her day.
 */
export interface BriefingItem { time?: string; text: string; leaveAt?: string; prep?: boolean; category?: string }

const MAX_SPOKEN = 3;

/** A title fit to be said: the first few words, never a paragraph. */
function spoken(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return t;
  const cut = t.slice(0, 40);
  return cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : 40).trim();
}

export function buildMorningBriefing(
  name: string,
  items: BriefingItem[],
  language: AppLanguage,
  now: Date = new Date(),
): string {
  const he = language === 'he';
  const who = name && name !== 'there' ? ` ${name}` : '';
  const hour = now.getHours();
  const hello = he
    ? (hour < 12 ? `בוקר טוב${who}!` : hour < 18 ? `צהריים טובים${who}!` : `ערב טוב${who}!`)
    : (hour < 12 ? `Good morning${who}!` : hour < 18 ? `Good afternoon${who}!` : `Good evening${who}!`);
  const hhmm = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const seen = new Set<string>();
  const real = items.filter((i) => {
    if (i.prep) return false;
    const key = i.text.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ahead = real.filter((i) => i.time && i.time >= hhmm).sort((a, b) => a.time!.localeCompare(b.time!));
  const untimed = real.filter((i) => !i.time).length;
  if (!ahead.length && !untimed) return he ? `${hello} אין לך עוד משהו קבוע היום.` : `${hello} Nothing else fixed today.`;
  const said = ahead.slice(0, MAX_SPOKEN).map((i, n) => {
    const leave = n === 0 && i.leaveAt ? (he ? `, יוצאים ב-${i.leaveAt}` : `, leave at ${i.leaveAt}`) : '';
    return `${i.time} ${spoken(i.text)}${leave}`;
  });
  const more = ahead.length - said.length + untimed;
  const tail = more > 0 ? (he ? ` ועוד ${more}.` : ` And ${more} more.`) : '';
  const big = ahead.some((i) => i.category === 'interview' || /interview|ראיון|מבחן|exam/i.test(i.text));
  const luck = big ? (he ? ' בהצלחה בראיון!' : ' Good luck at the interview!') : '';
  const list = said.length ? (he ? ` היום: ${said.join('. ')}.` : ` Today: ${said.join('. ')}.`) : '';
  return `${hello}${list}${tail}${luck}`.replace(/\s+/g, ' ').trim();
}
