/**
 * TransitOptionsList — "here are your next three, pick one".
 *
 * Written to replace three different cramped renderings of the same idea. The
 * old one was a single TouchableOpacity holding one long sentence —
 * "🚌 176 · direct · 32 min · leave 09:15, arrive 10:05" — with `flex: 1` and
 * a "use" label competing for the same row. In Hebrew, at any real line name,
 * the sentence wrapped and the two clock times were the first thing pushed out
 * of sight. The times are the entire point of the list.
 *
 * So the layout guarantees them structurally rather than hoping they fit:
 *
 *   row 1  [09:15] → [10:05]                          [ Use ]
 *   row 2  🚆 המכבים · direct · 50 min · 7 min early
 *
 * Row 1 holds only things that must never shrink (flexShrink: 0 on the times
 * and on the button, a flexible spacer between them). Everything that CAN be
 * abbreviated lives on row 2, where it is free to wrap to two lines. There is
 * no fixed height anywhere and no `overflow: hidden` on a row, so text that
 * grows makes the card taller instead of disappearing.
 *
 * The pick target is the button, not the whole row: tapping a row to commit to
 * a departure is too easy to do by accident while scrolling, and an explicit
 * control is what the request asked for.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { AppLanguage, TransitPlan } from '../types';
import {
  DepartureOption, changesLabel, slackLabel, vehicleLabel, boardLabel, urgencyLabel,
  minutesToDecide, departureUncatchable,
} from '../utils/departureOptions';
import { BRAND, FONTS, RADIUS } from '../constants/theme';

interface Props {
  options: DepartureOption[];
  language: AppLanguage;
  loading?: boolean;
  /** Shown instead of the list when there is nothing to offer. */
  emptyNote?: string;
  /** Where these times were measured from — "from home" vs "from here". */
  originNote?: string;
  onPick: (plan: TransitPlan) => void | Promise<void>;
  /** The one being applied right now, so its button can say so. */
  pickingDeparture?: string | null;
  /**
   * The current HH:MM. Passing it (and changing it) is what makes the
   * countdown live: a list of departures with no clock against it is a
   * photograph, and this list is read exactly when a photograph is useless.
   */
  now?: string;
}

export default function TransitOptionsList({
  options, language, loading, emptyNote, originNote, onPick, pickingDeparture, now,
}: Props) {
  const he = language === 'he';
  // Every caller gets the clock whether or not it passes one. A caller that
  // does pass one (Today, which ticks) gets a countdown that moves; a caller
  // that does not still cannot render a train that has already left, which is
  // the failure this list was reported for.
  const clock = now ?? new Date().toTimeString().slice(0, 5);
  const live = options.filter((o) => !departureUncatchable(o, clock));

  if (loading) {
    return (
      <View style={styles.box}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={BRAND.goldInk} />
          <Text style={styles.hint}>{he ? 'מחפשת את הבאות…' : 'finding the next ones…'}</Text>
        </View>
      </View>
    );
  }

  if (!live.length) {
    return (
      <View style={styles.box}>
        <Text style={styles.hint}>
          {options.length
            ? (he ? 'הנסיעות שהצעתי כבר יצאו — מחפשת את הבאות…'
              : 'The ones I offered have gone — finding the next…')
            : (emptyNote ?? (he ? 'לא מצאתי נסיעה הבאה 🙁' : "Couldn't find a next departure 🙁"))}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.box}>
      {originNote ? <Text style={styles.originNote}>{originNote}</Text> : null}
      {live.map((o, i) => {
        const busy = pickingDeparture === o.departAt;
        const left = minutesToDecide(o, clock);
        const urgent = left !== undefined && left <= 5;
        return (
          <View
            key={`${o.departAt}-${o.arriveAt}-${i}`}
            style={[
              styles.row,
              o.current && styles.rowCurrent,
              o.late && styles.rowLate,
              urgent && styles.rowUrgent,
            ]}
          >
            {/* Row 1 — the two numbers she is choosing between, and the way to
                take one. Nothing here is allowed to shrink. */}
            <View style={styles.timesLine}>
              <Text style={styles.depart}>{o.departAt}</Text>
              <Text style={styles.arrow}>→</Text>
              <Text style={[styles.arrive, o.late && styles.arriveLate]}>{o.arriveAt}</Text>
              <View style={styles.spacer} />
              {o.current ? (
                <View style={styles.currentPill}>
                  <Text style={styles.currentPillText}>{he ? 'נבחר' : 'current'}</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.pickBtn, busy && styles.pickBtnBusy]}
                  onPress={() => onPick(o.plan)}
                  disabled={busy}
                  activeOpacity={0.85}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.pickBtnText} numberOfLines={1}>
                    {busy ? (he ? '…' : '…') : (he ? 'קחי את זו' : 'Take it')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Row 2 — everything that may safely wrap. */}
            <Text style={styles.detail} numberOfLines={2}>
              {vehicleLabel(o, he)}
              {' · '}{changesLabel(o, he)}
              {' · '}{o.durationMinutes} {he ? 'דק׳' : 'min'}
              {slackLabel(o, he) ? ` · ${slackLabel(o, he)}` : ''}
            </Text>

            {/* Row 3 — the walk and the vehicle's own clock. Row 1 gives
                door-to-door, which answers "when am I there" and not "which
                train is this, and can I still reach the platform". Its own
                line rather than more text on row 2: this is what she reads
                while deciding whether to run. */}
            {boardLabel(o, he) ? (
              <Text style={styles.board} numberOfLines={2}>
                {boardLabel(o, he)}
                {urgencyLabel(o, clock, he) ? `  ·  ${urgencyLabel(o, clock, he)}` : ''}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: BRAND.cream, borderRadius: RADIUS.chip + 2,
    borderWidth: 1, borderColor: BRAND.line, padding: 8, gap: 8,
    // No height, no clipping: a third option or a wrapped line grows the box.
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 4 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5, color: BRAND.inkSoft, flex: 1 },
  originNote: {
    fontFamily: FONTS.bodySemi, fontSize: 11, color: BRAND.inkFaint,
    paddingHorizontal: 2,
  },
  row: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 10, paddingVertical: 9, gap: 4,
  },
  board: {
    fontFamily: FONTS.bodySemi, fontSize: 11.5, color: BRAND.goldInk, lineHeight: 16,
  },
  // Five minutes or less to be out of the door: the row says so in colour as
  // well as in words, because at that point she is scanning, not reading.
  rowUrgent: { borderColor: BRAND.danger, borderWidth: 1.5 },
  rowCurrent: { borderColor: BRAND.sunGold, backgroundColor: BRAND.goldSoft },
  rowLate: { borderColor: '#E4C7BC' },
  timesLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // flexShrink: 0 is the whole fix — these were what got squeezed away.
  depart: {
    flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.warmInk,
    letterSpacing: 0.2,
  },
  arrow: { flexShrink: 0, fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkFaint },
  arrive: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.success },
  arriveLate: { color: BRAND.danger },
  spacer: { flex: 1, minWidth: 8 },
  pickBtn: {
    flexShrink: 0, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.pill,
    paddingHorizontal: 14, paddingVertical: 7, minWidth: 74, alignItems: 'center',
  },
  pickBtnBusy: { opacity: 0.6 },
  pickBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 12.5, color: BRAND.onGold },
  currentPill: {
    flexShrink: 0, borderRadius: RADIUS.pill, borderWidth: 1.5, borderColor: BRAND.sunGold,
    paddingHorizontal: 12, paddingVertical: 6, minWidth: 74, alignItems: 'center',
  },
  currentPillText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  detail: {
    fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft, lineHeight: 17,
  },
});
