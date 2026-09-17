/**
 * fuzzyMatch — Hebrew/English fuzzy scoring, name variants, and the
 * PLACE_NAME_CORRECTIONS map ("space gym" -> "Space Gym", "biniamina" -> "בנימינה").
 * Dependencies: none (pure). Consumed by ContactService, SpeechService,
 * GoogleService.
 */
export const fuzzyScore = (a: string, b: string): number => {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  let matches = 0;
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
};

/**
 * Word-overlap similarity between two task texts (0..1), containment-biased:
 * "interview tomorrow in Ramat Gan" vs "interview tomorrow in Ramat Gan at
 * 11:30, bring CV" scores ~1 because the shorter is contained in the longer.
 * Time tokens (11:30) and one-letter words are ignored. Used to detect that
 * two differently-worded tasks are the SAME task (dedupe/merge, not add).
 */
export const textSimilarity = (a: string, b: string): number => {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/\d{1,2}:\d{2}/g, ' ')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    );
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
};

export const findBestMatch = (
  query: string,
  candidates: string[]
): { match: string; score: number; index: number } => {
  let best = { match: '', score: 0, index: -1 };
  candidates.forEach((c, i) => {
    const score = fuzzyScore(query, c);
    if (score > best.score) best = { match: c, score, index: i };
  });
  return best;
};

// Hebrew <-> English name variants for contact matching
export const HEBREW_NAME_VARIANTS: Record<string, string[]> = {
  'דני': ['Danny', 'Dani', 'Daniel', 'דניאל'],
  'יוסי': ['Yossi', 'Yosef', 'Joseph', 'יוסף'],
  'משה': ['Moshe', 'Moshi', 'Moses'],
  'שרה': ['Sarah', 'Sara'],
  'רחל': ['Rachel', 'Racheli'],
  'מירי': ['Miri', 'Miriam', 'מרים'],
  'איתי': ['Itay', 'Itai'],
  'רון': ['Ron', 'Roni', 'רוני'],
  'גל': ['Gal'],
  'תום': ['Tom', 'Tomer', 'תומר'],
  'נועה': ['Noa', 'Noah'],
  'עידו': ['Ido', 'Eido'],
  'אבי': ['Avi', 'Avraham', 'אברהם'],
  'ליאור': ['Lior'],
  'עמית': ['Amit'],
};

export const getNameVariants = (name: string): string[] => {
  const lower = name.toLowerCase();
  for (const [heb, variants] of Object.entries(HEBREW_NAME_VARIANTS)) {
    if (lower === heb || variants.map(v => v.toLowerCase()).includes(lower)) {
      return [heb, ...variants];
    }
  }
  return [name];
};

// Known place name corrections for Israeli locations
export const PLACE_NAME_CORRECTIONS: Record<string, string> = {
  'igal alon': 'יגאל אלון',
  'איגל אלון': 'יגאל אלון',
  'even gvirol': 'אבן גבירול',
  'dizengof': 'דיזנגוף',
  'biniamina': 'בנימינה',
  'binimina': 'בנימינה',
  'space gym': 'Space Gym',
  'kickbox': 'קיקבוקס',
};

/**
 * Apply the spoken-form corrections above — on WHOLE WORDS only.
 *
 * Without the boundaries this replaced inside words, and Google's own answer
 * was the victim: "igal alon" matched the tail of "Yigal Alon Street", so a
 * correctly geocoded address came back as "Yיגאל אלון Street" and was stored
 * that way on a real task. A correction that corrupts the authoritative
 * address is worse than no correction at all.
 *
 * \b does not work here — half the replacements are Hebrew, and Hebrew letters
 * are not \w — so the boundary is "not a letter or digit" in any script.
 */
export const correctPlaceName = (text: string): string => {
  let result = text;
  for (const [wrong, correct] of Object.entries(PLACE_NAME_CORRECTIONS)) {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    result = result.replace(regex, correct);
  }
  return result;
};
