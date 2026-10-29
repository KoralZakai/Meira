/**
 * tripPlaces — how a trip's two ends are named on screen (TripTimeline, 28.10).
 * Pure, so it is tested without React Native.
 */

/** "1, Diezengoff Street, Tel Aviv" → "Diezengoff Street 1" — never a bare house number. */
export function shortPlace(text?: string): string {
  const parts = String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  return /^\d+[א-תa-z]?$/i.test(parts[0]) && parts[1] ? `${parts[1]} ${parts[0]}` : parts[0];
}

/** The origin's name: home, a named place, or "where you are" for a live fix. */
export function originText(label: string | undefined, he: boolean): string {
  const l = String(label || '').trim();
  if (!l || /^home$/i.test(l) || l === 'הבית' || l === 'בית') return he ? 'הבית' : 'home';
  if (/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(l)) return he ? 'המקום שבו את' : 'where you are';
  return shortPlace(l);
}
