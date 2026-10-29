/**
 * readingRow — the flex direction in which a row of siblings READS in a language.
 *
 * English reads left to right, Hebrew right to left, and a row of separate
 * `Text`s (a label and a time, an arrow and a word) is not bidi-reordered by
 * anything: the first child is simply drawn first, on whichever side the row's
 * direction puts it. The app mirrors by hand (`he && styles.rowRtl`, a
 * `row-reverse`), but on a phone whose own language is Hebrew React Native has
 * ALREADY flipped every `row`, and a hand-made reverse on top of that puts the
 * order straight back.
 *
 * `he === I18nManager.isRTL` is the one test that lands on the same physical
 * side in all four combinations of (app language) x (phone layout direction):
 *
 *   app    phone   result
 *   en     LTR     'row'          first child on the left
 *   he     LTR     'row-reverse'  first child on the right
 *   he     RTL     'row'          React Native flips it: first child on the right
 *   en     RTL     'row-reverse'  React Native flips it back: first child on the left
 */
import { I18nManager } from 'react-native';

export function readingRow(he: boolean): 'row' | 'row-reverse' {
  return he === I18nManager.isRTL ? 'row' : 'row-reverse';
}

/**
 * The arrow between two SEPARATE boxes in a plain `row` ("09:15 → 10:05" as two
 * Texts and an arrow). A plain `row` is flipped by React Native on a Hebrew
 * phone, so there the second box is on the LEFT and the arrow must point left;
 * a → there points back at the time it came from. (Inside ONE string the arrow
 * is the bidi algorithm's business, not this — see neighbourLine.)
 */
export function flowArrow(): '→' | '←' {
  return I18nManager.isRTL ? '←' : '→';
}
