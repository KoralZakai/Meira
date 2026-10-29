/**
 * TripTimeline — the way to a task as one short timeline (Koral's pick B, 28.10).
 *
 *   13:36  ⏰  להתארגן
 *   14:21  🚪  יוצאת מהבית · 🚶7′ · בעוד 25 דק׳      ← the only yellow
 *   14:33  🚆  מת״א ההגנה                             ← bold
 *   15:38  ⬇️  יורדת בסבידור · 🚶12′
 *   15:50  📍  דיזנגוף 1 · 10′ לפני
 *
 * When, from where, how, to where — each time once. Shared by the open day
 * card (DayCard) and the task page (TaskDetailScreen), so the two cannot drift.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Task } from '../../types/index';
import { BRAND, FONTS } from '../../constants/theme';
import { addMinutes, timeToMinutes } from '../../utils/timeUtils';
import { RIDE_ICON, ridesOf, journeySteps } from '../../utils/rideLine';
import { formatSpan } from './NowAddRow';
import { readingRow } from './readingRow';
import { originText, shortPlace } from '../../utils/tripPlaces';
import { N } from '../../constants/nightTone';

export const MODE_EMOJI: Record<string, string> = { walk: '🚶', bike: '🚴', bus: '🚌', train: '🚆', car: '🚗' };
export const MODE_LABEL: Record<string, [string, string]> = {
  walk: ['Walk', 'הליכה'], bike: ['Bike', 'אופניים'], bus: ['Bus', 'אוטובוס'],
  train: ['Train', 'רכבת'], car: ['Car', 'רכב'],
};
const RLM = String.fromCharCode(0x200f);
/** Left-to-right mark: an English line holding a Hebrew station name must not flip. */
const LRM = String.fromCharCode(0x200e);

interface Props {
  task: Task;
  he: boolean;
  /** HH:MM now — for "in 25 min" (today only). */
  now?: string;
  /** Wake / get-ready time, when there is one. */
  readyAt?: string;
  wakeMuted?: boolean;
  /** Drawn on a night card (the caller's surface decides — a light sheet passes nothing). */
  night?: boolean;
  /** The transport she just picked, before the route is stored. */
  mode?: string;
}

export default function TripTimeline({ task, he, now, readyAt, wakeMuted, mode: modeOverride, night }: Props) {
  const loc: any = task.location && typeof task.location === 'object' ? task.location : undefined;
  const place = shortPlace(loc?.displayName || loc?.address);
  const leave: string | undefined = loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt;
  if (!leave) return null;
  const travel: number | undefined = loc?.transitPlan?.totalDurationMinutes ?? loc?.travelMinutes;
  const mode: string | undefined = modeOverride ?? loc?.transportType;
  const rides: any[] = ridesOf(task);
  const transit = rides.length > 0 || mode === 'bus' || mode === 'train';
  // A timetable says when it lands; anything else lands at leave + ride (DayCard's rule).
  const arrive: string | undefined = transit
    ? (rides.length ? loc?.transitPlan?.arriveAt : undefined)
    : (travel ? addMinutes(leave, travel) : loc?.transitPlan?.arriveAt);
  const start = task.fixedTime || task.scheduledTime || '';
  const earlyBy = arrive && start ? timeToMinutes(start) - timeToMinutes(arrive) : undefined;
  const untilLeave = now ? timeToMinutes(leave) - timeToMinutes(now) : undefined;

  const rows: Array<{ at?: string; icon: string; text: string; strong?: boolean; leaveRow?: boolean; soft?: boolean }> = [];
  // A get-ready time that has already gone is not a step any more.
  if (readyAt && !(now && timeToMinutes(readyAt) < timeToMinutes(now))) {
    rows.push({ at: readyAt, icon: wakeMuted ? '🔕' : '⏰', soft: true,
      text: wakeMuted ? (he ? 'שעון כבוי' : 'Alarm off') : (he ? 'להתארגן' : 'Get ready') });
  }
  // Where she leaves FROM — the plan's origin, never the boarding stop (that is the ride's row).
  const fromText = originText(loc?.transitPlan?.originLabel, he);
  const steps = journeySteps(loc?.transitPlan?.legs, place || (he ? 'היעד' : 'the place'), leave);
  const firstWalk = steps[0]?.kind === 'walk' ? (steps[0] as any) : null;
  rows.push({ at: leave, icon: '🚪', leaveRow: true,
    text: `${he ? `יוצאת מ${fromText}` : `Leave ${fromText}`}${firstWalk ? ` · 🚶${firstWalk.minutes}′` : ''}${untilLeave !== undefined && untilLeave > 1 ? (he ? ` · בעוד ${formatSpan(untilLeave, true)}` : ` · in ${formatSpan(untilLeave, false)}`) : ''}` });
  steps.forEach((st: any, k) => {
    if (st.kind !== 'ride') return;
    const leg = st.leg;
    rows.push({ at: leg.departureTime, icon: RIDE_ICON[leg.type] || '🚌', strong: true,
      text: `${leg.lineNumber ? `${leg.lineNumber} · ` : ''}${he ? 'מ' : 'from '}${leg.stopName || leg.from}` });
    const after: any = steps[k + 1];
    rows.push({ at: leg.arrivalTime, icon: '⬇️', soft: true,
      text: `${he ? 'יורדת ב' : 'Off at '}${leg.to}${after && after.kind === 'walk' ? ` · 🚶${after.minutes}′` : ''}` });
  });
  if (!rides.length) {
    rows.push({ icon: MODE_EMOJI[mode || ''] || '🧭', soft: true,
      text: `${(MODE_LABEL[mode || ''] || ['Route', 'מסלול'])[he ? 1 : 0]}${travel ? ` · ${he ? `${travel} דק׳` : `${travel} min`}` : ''}${transit ? (he ? ' · אין עדיין שעת יציאה מדויקת' : ' · no exact departure yet') : ''}` });
  }
  if (arrive) {
    rows.push({ at: arrive, icon: '📍',
      text: `${place || (he ? 'היעד' : 'there')}${earlyBy !== undefined ? (earlyBy >= 0 ? (he ? ` · ${earlyBy}′ לפני` : ` · ${earlyBy}′ early`) : (he ? ` · ${-earlyBy}′ איחור` : ` · ${-earlyBy}′ late`)) : ''}` });
  }
  // Google's train times are live predictions — say when these were taken (rule 4).
  const fetchedAt: number | undefined = loc?.transitPlan?.fetchedAt;
  const checked = rides.length && fetchedAt
    ? new Date(fetchedAt).toTimeString().slice(0, 5) : '';
  return (
    <View style={styles.tl}>
      {rows.map((row, k) => (
        <View key={k} style={[styles.row, { flexDirection: readingRow(he) }]}>
          <Text style={[styles.time, night && N.ink, row.leaveRow && styles.leave, row.soft && styles.softTime, row.soft && night && N.inkSoft]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{row.at ?? ''}</Text>
          <Text style={styles.icon}>{row.icon}</Text>
          <Text style={[styles.text, night && N.ink, row.strong && styles.strong, row.soft && styles.soft, row.soft && night && N.inkSoft, he && styles.rtl]} numberOfLines={2}>
            {(he ? RLM : LRM) + row.text}
          </Text>
        </View>
      ))}
      {checked ? (
        <Text style={[styles.checked, night && N.inkSoft, he && styles.rtl]} numberOfLines={1}>
          {he ? `לפי Google · נבדק ב-${checked}` : `Per Google · checked ${checked}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tl: { gap: 6, marginBottom: 8 },
  row: { alignItems: 'center', gap: 10, minHeight: 32 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  time: { minWidth: 54, paddingHorizontal: 4, textAlign: 'center', fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  leave: { backgroundColor: BRAND.sunGold, color: BRAND.onGold, borderRadius: 10, overflow: 'hidden', paddingVertical: 3 },
  softTime: { color: BRAND.inkSoft, fontSize: 14 },
  icon: { width: 22, textAlign: 'center', fontSize: 16 },
  text: { flex: 1, minWidth: 0, fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.warmInk },
  strong: { fontFamily: FONTS.bodyHeavy, fontSize: 15 },
  soft: { color: BRAND.inkSoft, fontSize: 13 },
  checked: { fontFamily: FONTS.bodySemi, fontSize: 11.5, color: BRAND.inkSoft, marginTop: 2 },
});
