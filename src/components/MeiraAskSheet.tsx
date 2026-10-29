/**
 * MeiraAskSheet — one of Meira's questions, in a sheet from below (6.10, her
 * pick "A": "● Meira asks · 🥊 קיקבוקס · 20:30–21:30 · Every day, or on
 * certain days? [Every day] [day chips] [Changes weekly] [✓ Save] [Not now]").
 *
 * After ✓ it says what the answer WILL change (the server's effect sentence),
 * and only when every part saved. When something did not land it says which
 * part and why, in words that name the fix (CLAUDE.md, silent-state rule 3):
 * saved on the phone but waiting for a connection, sign in again, the server
 * is not updated yet, the line changed. A rule Meira proposes after two same
 * answers is asked here too, and is never made without her yes.
 *
 * The 'place' kind (15.10, "Where is "Space Gym"?") draws up to three radio
 * rows from the map — name over address — plus "✏️ Something else"; Save stays
 * off until a row is chosen, and "Something else" claims no ✓ (nothing was saved).
 *
 * The 'tripOrigin' kind (17.10, "Tomorrow at 10:34 you leave for X. Where will
 * you leave from?") is three stacked buttons — "📍 From here (<where she is>)",
 * "🏠 From home", "Later" — each 44dp or more, the labels clamped to two lines
 * so a long street name shrinks instead of overflowing. Its strings come from
 * questions/kinds/tripOrigin.sheetText, the same ones tests/run-tomorrow-start.ts pins.
 *
 * Display only: MeiraAskHost wires it to QuestionService.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import BottomSheet from './ui/BottomSheet';
import { BRAND, FONTS } from '../constants/theme';
import { sheetText } from '../questions/kinds/tripOrigin';
import { sheetText as routineOriginText } from '../questions/kinds/routineOrigin';
import type { AnswerResult, MeiraQuestion, QuestionAnswer } from '../questions/types';
import type { RuleProposal } from '../services/LumiServer';
import { formatShortDate } from '../utils/timeUtils';

interface Props {
  question: MeiraQuestion | null;
  he: boolean;
  onAnswer: (a: QuestionAnswer) => Promise<AnswerResult>;
  onLater: () => void;
  onClose: () => void;
  onRetry: () => Promise<number>;
  onConfirmRule: (p: RuleProposal, yes: boolean) => Promise<{ ok: boolean; reason?: string }>;
}

type Phase =
  | { at: 'ask' }
  | { at: 'saving' }
  | { at: 'done'; result: AnswerResult }
  | { at: 'rule-saved'; text: string }
  | { at: 'rule-failed'; reason: string };

const LETTERS_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const LETTERS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HEBREW = /[֐-׿]/;

function failureText(r: AnswerResult, he: boolean): string {
  switch (r.reason) {
    case 'offline':
      return r.savedLocally
        ? (he ? 'נשמר בטלפון, עוד לא אצל מאירה — אין חיבור. אנסה שוב לבד.'
          : "Saved on this phone, not with Meira yet — no connection. I'll keep trying.")
        : (he ? 'עוד לא נשמר אצל מאירה — אין חיבור. אנסה שוב לבד.'
          : "Not saved with Meira yet — no connection. I'll keep trying.");
    case 'auth':
      return he ? 'לא נשמר אצל מאירה — צריך להתחבר מחדש (תפריט ← חשבון).'
        : 'Not saved with Meira — sign in again (Menu → Account).';
    case 'deploy':
      return he ? 'השרת עוד לא מעודכן — נשמר רק בטלפון.' : "The server isn't updated yet — saved on this phone only.";
    case 'line_changed':
      return he ? 'השורה הזאת השתנתה בינתיים — אבדוק אותה שוב.' : 'That line changed in the meantime — I’ll check it again.';
    case 'local':
      return he ? 'לא נשמר בטלפון — נסי שוב.' : 'Not saved on this phone — try again.';
    case 'task_gone':
      return he ? 'המשימה הזאת כבר לא קיימת — לא שמרתי כלום.' : "That task isn't there any more — nothing was saved.";
    default:
      return he ? 'לא נשמר אצל מאירה — השרת לא ענה. אנסה שוב לבד.' : "Not saved with Meira — the server didn't answer. I'll keep trying.";
  }
}

export default function MeiraAskSheet({ question, he, onAnswer, onLater, onClose, onRetry, onConfirmRule }: Props) {
  const [phase, setPhase] = useState<Phase>({ at: 'ask' });
  const [days, setDays] = useState<number[]>([]);
  // A place question: the row she picked (an index into its candidates) or 'edit'.
  const [row, setRow] = useState<number | 'edit' | null>(null);
  const [proposal, setProposal] = useState<RuleProposal | null>(null);

  useEffect(() => {
    setPhase({ at: 'ask' });
    setDays([]);
    setRow(null);
    setProposal(null);
  }, [question?.key]);

  if (!question) return null;
  const isPlace = question.kind === 'place' && Boolean(question.place);
  const trip = question.kind === 'tripOrigin' ? question.tripOrigin : undefined;
  const tripWords = trip ? sheetText(trip) : null;
  const afterTrip = question.kind === 'routineOrigin' ? question.routineOrigin : undefined;
  const afterWords = afterTrip ? routineOriginText(afterTrip) : null;
  const letters = he ? LETTERS_HE : LETTERS_EN;
  // Hebrew reads right to left: א׳ sits at the right edge.
  const order = he ? [6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6];

  const send = async (a: QuestionAnswer) => {
    setPhase({ at: 'saving' });
    const result = await onAnswer(a);
    setProposal(result.proposal ?? null);
    setPhase({ at: 'done', result });
  };

  const toggle = (d: number) => setDays((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d].sort()));

  const confirm = async (yes: boolean) => {
    if (!proposal) return;
    const r = await onConfirmRule(proposal, yes);
    if (!r.ok) return setPhase({ at: 'rule-failed', reason: r.reason || '' });
    if (!yes) return onClose();
    setProposal(null);
    setPhase({ at: 'rule-saved', text: he ? proposal.text.he : proposal.text.en });
  };

  return (
    <BottomSheet visible onClose={phase.at === 'ask' ? onLater : onClose}>
      <View style={styles.body}>
        <View style={[styles.head, he && styles.rowRtl]}>
          <View style={styles.orb} />
          <Text style={styles.kicker}>{he ? 'מאירה שואלת' : 'Meira asks'}</Text>
        </View>
        {afterTrip && afterWords ? (
          // "🏠 After the meeting you have yoga at 19:00. Home first, or straight there?" — the question IS the title.
          <>
            <Text style={[styles.title, he && styles.rtl]} numberOfLines={4}>
              {`🏠 ${he ? afterWords.ask.he : afterWords.ask.en}`}
            </Text>
            {/* Dated (rule 4), with where the routine is. */}
            <Text style={[styles.ask, he && styles.rtl]} numberOfLines={2}>
              {[formatShortDate(afterTrip.date, he ? 'he' : 'en'), afterTrip.routineAddress].filter(Boolean).join(' · ')}
            </Text>
          </>
        ) : trip && tripWords ? (
          // "🧭 Tomorrow at 10:34 you leave for X. Where will you leave from?" — the question IS the title.
          <>
            <Text style={[styles.title, he && styles.rtl]} numberOfLines={4}>
              {`🧭 ${he ? tripWords.ask.he : tripWords.ask.en}`}
            </Text>
            {/* Dated, though "tomorrow" says it: anything dated shows its date (rule 4). */}
            <Text style={[styles.ask, he && styles.rtl]} numberOfLines={1}>
              {[formatShortDate(trip.date, he ? 'he' : 'en'), trip.time].filter(Boolean).join(' · ')}
            </Text>
          </>
        ) : isPlace ? (
          // "📍 Where is "Space Gym"?" — the question IS the title.
          <>
            <Text style={[styles.title, (he || HEBREW.test(question.title)) && styles.rtl]} numberOfLines={3}>
              {`📍 ${he ? question.ask.he : question.ask.en}`}
            </Text>
            {/* WHICH task is asking, and when — it may not be today's (rule 4). */}
            <Text style={[styles.ask, he && styles.rtl]} numberOfLines={2}>
              {[question.place!.taskText, formatShortDate(question.place!.date, he ? 'he' : 'en'), question.place!.time]
                .filter((x) => x && x !== question.title).join(' · ')}
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.title, HEBREW.test(question.title) && styles.rtl]}>{`🔁 ${question.title}`}</Text>
            <Text style={[styles.ask, he && styles.rtl]}>{he ? question.ask.he : question.ask.en}</Text>
          </>
        )}

        {phase.at === 'ask' && isPlace && (
          <>
            <View accessibilityRole="radiogroup" style={styles.rows}>
              {question.place!.candidates.map((c, i) => {
                const on = row === i;
                return (
                  <TouchableOpacity key={`${c.lat},${c.lng}`} onPress={() => setRow(i)}
                    style={[styles.pickRow, he && styles.rowRtl, on && styles.pickRowOn]}
                    accessibilityRole="radio" accessibilityState={{ selected: on }}
                    accessibilityLabel={`${c.name}, ${c.address}`}>
                    <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
                    <View style={styles.pickText}>
                      <Text numberOfLines={1} style={[styles.pickName, he && styles.rtl]}>{c.name}</Text>
                      <Text numberOfLines={2} style={[styles.pickAddress, he && styles.rtl]}>{c.address}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity onPress={() => setRow('edit')}
                style={[styles.pickRow, he && styles.rowRtl, row === 'edit' && styles.pickRowOn]}
                accessibilityRole="radio" accessibilityState={{ selected: row === 'edit' }}>
                <View style={[styles.radio, row === 'edit' && styles.radioOn]}>
                  {row === 'edit' ? <View style={styles.radioDot} /> : null}
                </View>
                <View style={styles.pickText}>
                  <Text numberOfLines={1} style={[styles.pickName, he && styles.rtl]}>
                    {`✏️ ${he ? 'משהו אחר' : 'Something else'}`}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
            <View style={[styles.actions, he && styles.rowRtl]}>
              <TouchableOpacity style={[styles.save, row === null && styles.saveOff]} disabled={row === null}
                onPress={() => send(row === 'edit' ? { choice: 'edit' } : { choice: 'pick', index: row as number })}
                accessibilityRole="button">
                <Text style={styles.saveText} numberOfLines={1}>
                  {row === 'edit' ? (he ? 'אתקן בעצמי' : "I'll fix it") : (he ? '✓ שמרי' : '✓ Save')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.later} onPress={onLater} accessibilityRole="button">
                <Text style={styles.laterText} numberOfLines={1}>{he ? 'אחר כך' : 'Later'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {phase.at === 'ask' && trip && tripWords && (
          <View style={styles.tripButtons}>
            <TouchableOpacity style={styles.tripPrimary} onPress={() => send({ choice: 'here' })}
              accessibilityRole="button" accessibilityLabel={he ? tripWords.here.he : tripWords.here.en}>
              <Text style={styles.tripPrimaryText} numberOfLines={2}>{he ? tripWords.here.he : tripWords.here.en}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tripSecondary} onPress={() => send({ choice: 'home' })}
              accessibilityRole="button" accessibilityLabel={he ? tripWords.home.he : tripWords.home.en}>
              <Text style={styles.tripSecondaryText} numberOfLines={1}>{he ? tripWords.home.he : tripWords.home.en}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tripLater} onPress={onLater}
              accessibilityRole="button" accessibilityLabel={he ? tripWords.later.he : tripWords.later.en}>
              <Text style={styles.laterText} numberOfLines={1}>{he ? tripWords.later.he : tripWords.later.en}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase.at === 'ask' && afterTrip && afterWords && (
          <View style={styles.tripButtons}>
            <TouchableOpacity style={styles.tripPrimary} onPress={() => send({ choice: 'direct' })}
              accessibilityRole="button" accessibilityLabel={he ? afterWords.direct.he : afterWords.direct.en}>
              <Text style={styles.tripPrimaryText} numberOfLines={2}>{he ? afterWords.direct.he : afterWords.direct.en}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tripSecondary} onPress={() => send({ choice: 'home' })}
              accessibilityRole="button" accessibilityLabel={he ? afterWords.home.he : afterWords.home.en}>
              <Text style={styles.tripSecondaryText} numberOfLines={1}>{he ? afterWords.home.he : afterWords.home.en}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tripSecondary} onPress={() => send({ choice: 'skip' })}
              accessibilityRole="button" accessibilityLabel={he ? afterWords.skip.he : afterWords.skip.en}>
              <Text style={styles.tripSecondaryText} numberOfLines={1}>{he ? afterWords.skip.he : afterWords.skip.en}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tripLater} onPress={onLater}
              accessibilityRole="button" accessibilityLabel={he ? afterWords.later.he : afterWords.later.en}>
              <Text style={styles.laterText} numberOfLines={1}>{he ? afterWords.later.he : afterWords.later.en}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase.at === 'ask' && !isPlace && !trip && !afterTrip && (
          <>
            {!question.context.perWeek && (
              <TouchableOpacity style={styles.wide} onPress={() => send({ choice: 'every_day' })} accessibilityRole="button">
                <Text style={styles.wideText}>{he ? 'כל יום' : 'Every day'}</Text>
              </TouchableOpacity>
            )}
            <View style={styles.chips} accessibilityLabel={he ? 'בחירת ימים' : 'Choose days'}>
              {order.map((d) => {
                const on = days.includes(d);
                return (
                  <TouchableOpacity key={d} onPress={() => toggle(d)} style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{letters[d]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={styles.wideSoft} onPress={() => send({ choice: 'varies' })} accessibilityRole="button">
              <Text style={styles.wideSoftText}>{he ? 'משתנה כל שבוע' : 'Changes every week'}</Text>
            </TouchableOpacity>
            <View style={[styles.actions, he && styles.rowRtl]}>
              <TouchableOpacity style={[styles.save, !days.length && styles.saveOff]} disabled={!days.length}
                onPress={() => send({ choice: 'days', days })} accessibilityRole="button">
                <Text style={styles.saveText}>{he ? '✓ שמרי' : '✓ Save'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.later} onPress={onLater} accessibilityRole="button">
                <Text style={styles.laterText}>{he ? 'לא עכשיו' : 'Not now'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {phase.at === 'saving' && (
          <View style={styles.status}>
            <ActivityIndicator color={BRAND.goldInk} />
            <Text style={styles.statusText}>{he ? 'שומרת…' : 'Saving…'}</Text>
          </View>
        )}

        {phase.at === 'done' && (
          <View style={styles.result}>
            {phase.result.ok ? (
              <Text style={[styles.effect, he && styles.rtl]}>
                {/* "Something else" saved nothing, so it gets no ✓ (rule 3). */}
                {`${phase.result.skipped ? '' : '✓ '}${(he ? phase.result.effect?.he : phase.result.effect?.en) || (he ? 'נשמר' : 'Saved')}`}
              </Text>
            ) : (
              <>
                <Text style={[styles.warn, he && styles.rtl]}>{failureText(phase.result, he)}</Text>
                {phase.result.queued && (
                  <TouchableOpacity style={styles.wideSoft} accessibilityRole="button" onPress={async () => {
                    setPhase({ at: 'saving' });
                    const left = await onRetry();
                    setPhase({ at: 'done', result: left ? phase.result : { ...phase.result, ok: true, reason: undefined } });
                  }}>
                    <Text style={styles.wideSoftText}>{he ? 'נסי עכשיו' : 'Try now'}</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
            {proposal ? (
              <View style={styles.rule}>
                <Text style={[styles.ruleAsk, he && styles.rtl]}>{`● ${he ? proposal.ask.he : proposal.ask.en}`}</Text>
                <View style={[styles.actions, he && styles.rowRtl]}>
                  <TouchableOpacity style={styles.save} onPress={() => confirm(true)} accessibilityRole="button">
                    <Text style={styles.saveText}>{he ? 'כן, מעכשיו' : 'Yes, from now on'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.later} onPress={() => confirm(false)} accessibilityRole="button">
                    <Text style={styles.laterText}>{he ? 'תמשיכי לשאול' : 'Keep asking'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.later} onPress={onClose} accessibilityRole="button">
                <Text style={styles.laterText}>{he ? 'סגירה' : 'Close'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {phase.at === 'rule-saved' && (
          <View style={styles.result}>
            <Text style={[styles.effect, he && styles.rtl]}>
              {he ? `✓ מעכשיו: ${phase.text}. אפשר לבטל ב„את”.` : `✓ From now on: ${phase.text}. You can undo it in You.`}
            </Text>
            <TouchableOpacity style={styles.later} onPress={onClose} accessibilityRole="button">
              <Text style={styles.laterText}>{he ? 'סגירה' : 'Close'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase.at === 'rule-failed' && (
          <View style={styles.result}>
            <Text style={[styles.warn, he && styles.rtl]}>
              {he ? `הכלל לא נשמר: ${phase.reason}` : `The rule was not saved: ${phase.reason}`}
            </Text>
            <TouchableOpacity style={styles.later} onPress={onClose} accessibilityRole="button">
              <Text style={styles.laterText}>{he ? 'סגירה' : 'Close'}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 4, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowRtl: { flexDirection: 'row-reverse' },
  orb: { width: 18, height: 18, borderRadius: 9, backgroundColor: BRAND.sunGold },
  kicker: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.warmInk },
  ask: { fontFamily: FONTS.body, fontSize: 15, color: BRAND.inkSoft },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  wide: { minHeight: 48, borderRadius: 14, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  wideText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold },
  wideSoft: { minHeight: 44, borderRadius: 14, borderWidth: 1.5, borderColor: BRAND.line, alignItems: 'center', justifyContent: 'center' },
  wideSoftText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  rows: { gap: 8 },
  // minHeight 56 (> 44 touch minimum); the text column shrinks instead of overflowing.
  pickRow: {
    minHeight: 56, borderRadius: 14, borderWidth: 1.5, borderColor: BRAND.line,
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8,
  },
  pickRowOn: { borderColor: BRAND.sunGold, backgroundColor: 'rgba(241,194,78,0.14)' },
  radio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  radioOn: { borderColor: BRAND.goldInk },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND.goldInk },
  pickText: { flex: 1, flexShrink: 1, minWidth: 0 },
  pickName: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  pickAddress: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, marginTop: 1 },
  // The 'tripOrigin' buttons: stacked, ≥ 48dp (> the 44 touch minimum). The label
  // column shrinks (flexShrink / numberOfLines) instead of running off the sheet.
  tripButtons: { gap: 10, marginTop: 4 },
  tripPrimary: {
    minHeight: 52, borderRadius: 14, backgroundColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 8,
  },
  tripPrimaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold, textAlign: 'center', flexShrink: 1 },
  tripSecondary: {
    minHeight: 48, borderRadius: 14, borderWidth: 1.5, borderColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 8,
  },
  tripSecondaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, textAlign: 'center', flexShrink: 1 },
  tripLater: {
    minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14,
  },
  chips: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  chip: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1.5, borderColor: BRAND.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft },
  chipTextOn: { color: BRAND.onGold },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  save: { flex: 1, minHeight: 48, borderRadius: 14, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  saveOff: { opacity: 0.4 },
  saveText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold },
  later: { flex: 1, minHeight: 48, borderRadius: 14, borderWidth: 1.5, borderColor: BRAND.line, alignItems: 'center', justifyContent: 'center' },
  laterText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.inkSoft },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14 },
  statusText: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.inkSoft },
  result: { gap: 10, paddingBottom: 6 },
  effect: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.success },
  warn: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.danger },
  rule: { gap: 8, padding: 12, borderRadius: 16, backgroundColor: 'rgba(241,194,78,0.12)' },
  ruleAsk: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
});
