/**
 * nightTone — the night palette (Koral, 28.10: "night mode looks really bad —
 * both light and dark, not good"; her pick: a real dark night).
 *
 * The sky went navy after dusk while every card, chip, label and the tab bar
 * kept its daytime cream and dark-brown ink: brown text straight on navy, and
 * white boxes floating on it. At night (useNight) the surfaces become dark
 * glass and the inks turn light — one palette, so no screen drifts.
 * Contrast of each ink on its surface is pinned by tests/run-night-tone.ts.
 */
import { StyleSheet } from 'react-native';
import { NIGHT_COLORS } from './nightColors';

export { NIGHT_COLORS };

/** Style overrides, applied as `night && N.card` after the day style. */
// Android draws a translucent card's elevation shadow THROUGH it (a pale box
// inside the card), so night surfaces carry no shadow.
const FLAT = { elevation: 0, shadowOpacity: 0 } as const;

export const N = StyleSheet.create({
  card: { ...FLAT, backgroundColor: NIGHT_COLORS.card, borderColor: NIGHT_COLORS.cardBorder },
  /** Only the surface — keeps a border colour the day style set (gold "moved", …). */
  surface: { ...FLAT, backgroundColor: NIGHT_COLORS.card },
  cardDim: { ...FLAT, backgroundColor: NIGHT_COLORS.cardDim, borderColor: NIGHT_COLORS.cardBorder },
  chip: { ...FLAT, backgroundColor: NIGHT_COLORS.chip, borderColor: NIGHT_COLORS.chipBorder },
  glass: { ...FLAT, backgroundColor: NIGHT_COLORS.glass, borderColor: NIGHT_COLORS.cardBorder },
  bar: { backgroundColor: NIGHT_COLORS.bar, borderColor: NIGHT_COLORS.cardBorder },
  /** A compact row at night: no box, a hairline under it (WhatsApp's list). */
  row: { ...FLAT, backgroundColor: 'transparent', borderRadius: 0, borderBottomWidth: 1, borderColor: NIGHT_COLORS.line },
  /** …and the row happening now: the surface and a gold edge. */
  rowLive: { ...FLAT, backgroundColor: NIGHT_COLORS.card, borderRadius: 0, borderLeftWidth: 3, borderColor: NIGHT_COLORS.goldInk },
  ink: { color: NIGHT_COLORS.ink },
  inkSoft: { color: NIGHT_COLORS.inkSoft },
  goldInk: { color: NIGHT_COLORS.goldInk },
  purpleInk: { color: NIGHT_COLORS.purpleInk },
  goldSoft: { backgroundColor: NIGHT_COLORS.goldSoft },
  input: { backgroundColor: NIGHT_COLORS.input, borderColor: NIGHT_COLORS.chipBorder, color: NIGHT_COLORS.ink },
});
