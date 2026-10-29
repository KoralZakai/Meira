/**
 * MorningAlarmPill — the ⏰ at the top of Today, and the hour sheet behind it.
 *
 * Koral, 20.10 (option C): a pill that never disappears — when its hour goes
 * by it moves on to the next morning — plus a small ⏰ on the task it wakes
 * her for. Tap = on/off for that morning. Long press = another hour. Meira
 * picks the hour by herself (utils/morningAlarm).
 *
 * `useMorningAlarm` holds the state so TodaySchedule can hand the same answer
 * to the owning DayCard; the pill and the card call the same toggle/sheet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import { onTasksWritten } from '../../services/TaskStorage';
import { chooseMorningAlarm, currentMorningAlarm } from '../../services/MorningAlarmService';
import { MorningPlan, alarmTimeChoices, morningAlarmLabel, wakeOptions } from '../../utils/morningAlarm';

function subMin(hhmm: string, m: number): string {
  const [h, mm] = hhmm.split(':').map(Number);
  const t = (((h * 60 + mm - m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function tomorrowKey(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface MorningAlarmState {
  plan: MorningPlan | null;
  error?: string;
  toggle: () => void;
  openSheet: () => void;
  sheet: React.ReactNode;
  /** What she has to do in Clock, after she turned one off or moved it. */
  note?: string;
}

export function useMorningAlarm(he: boolean, refreshKey?: unknown): MorningAlarmState {
  const [plan, setPlan] = useState<MorningPlan | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const reload = useCallback(() => {
    currentMorningAlarm().then((r) => { setPlan(r.plan); setError(r.error); });
  }, []);

  useEffect(() => {
    reload();
    const off = onTasksWritten(reload);
    // Its hour passing is what moves it on — re-read once a minute.
    const tick = setInterval(reload, 60_000);
    return () => { off(); clearInterval(tick); };
  }, [reload, refreshKey]);

  const choose = useCallback((date: string, choice: { on?: boolean; at?: string; beforeMin?: number }) => {
    setPlan((p) => {
      if (!p || p.date !== date) return p;
      const counted = p.anchor && choice.beforeMin != null ? subMin(p.anchor.at, choice.beforeMin) : undefined;
      const at = counted ?? choice.at ?? (choice.on === false ? p.at : p.autoAt ?? p.at);
      return { ...p, at, on: choice.on ?? true, custom: Boolean(at !== p.autoAt), beforeMin: choice.beforeMin ?? p.beforeMin };
    });
    setNote(undefined);
    chooseMorningAlarm(date, choice)
      .then(({ dismissed }) => {
        // Samsung's Clock opens its list instead of removing the alarm by
        // itself — so say exactly what is left for her to do there.
        if (dismissed.length) {
          const which = dismissed.map((t) => `Meira · ${t}`).join(', ');
          setNote(he ? `בשעון: כבי את ${which}` : `In Clock: turn off ${which}`);
          // The header has no room kept for it — a minute is enough to read it.
          setTimeout(() => setNote(undefined), 60_000);
        }
      })
      .catch((e) => { console.warn('[MorningAlarm] choice not applied', e); setError(String(e?.message || e)); })
      .finally(reload);
  }, [reload, he]);

  const toggle = useCallback(() => {
    if (!plan) { setSheetOpen(true); return; }
    choose(plan.date, { on: !plan.on });
  }, [plan, choose]);

  const date = plan?.date ?? tomorrowKey();
  const anchor = plan?.anchor;
  // With a trip or a start to count back from, the options ARE "N min before
  // you leave" (Koral, 20.10: "depends on the bus time") and her pick is kept as
  // minutes, so a moved bus moves the alarm. Only a taskless morning picks a bare hour.
  const options: { at: string; before?: number; auto: boolean }[] = plan && anchor
    ? wakeOptions(plan)
    : alarmTimeChoices(plan ?? { at: '07:00', autoAt: '07:00' }).map((at) => ({ at, auto: at === plan?.autoAt }));
  const ride = anchor?.ride;
  const what = plan?.task ? `${plan.task.text} · ${plan.task.fixedTime || plan.task.scheduledTime || ''}` : '';
  const sub = anchor?.kind === 'leave'
    ? `🚪 ${he ? 'לצאת' : 'Leave'} ${anchor.at}${ride ? ` · ${ride.icon} ${ride.line ? `${ride.line} ` : ''}${ride.time || ''}${ride.stop ? ` ${he ? 'מ' : 'from '}${ride.stop}` : ''}` : ''}\n${what}`
    : plan?.task ? `${he ? 'לפני' : 'Before'}: ${what}` : (he ? 'מחר בבוקר' : 'Tomorrow morning');
  const beforeWord = (b: number) => (anchor?.kind === 'leave'
    ? (he ? `${b} דק׳ לפני היציאה` : `${b} min before leaving`)
    : (he ? `${b} דק׳ לפני` : `${b} min before`));
  const sheet = (
    <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
      <Pressable style={styles.scrim} onPress={() => setSheetOpen(false)}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={[styles.sheetTitle, he && styles.rtl]}>
            {anchor?.kind === 'leave'
              ? (he ? '⏰ כמה זמן לפני היציאה להעיר אותך?' : '⏰ How long before you leave should I wake you?')
              : (he ? '⏰ מתי להעיר אותך?' : '⏰ When should I wake you?')}
          </Text>
          <Text style={[styles.sheetSub, he && styles.rtl]} numberOfLines={3}>{sub}</Text>
          <View style={styles.grid}>
            {options.map((o) => {
              const on = plan?.on && o.at === plan.at;
              return (
                <TouchableOpacity key={`${o.at}-${o.before ?? ''}`} style={[styles.opt, on && styles.optOn]} activeOpacity={0.8}
                  onPress={() => {
                    setSheetOpen(false);
                    choose(date, o.auto ? { on: true, at: undefined, beforeMin: undefined }
                      : o.before != null ? { on: true, at: undefined, beforeMin: o.before } : { on: true, at: o.at });
                  }}
                  accessibilityRole="button" accessibilityState={{ selected: Boolean(on) }}>
                  <Text style={[styles.optText, on && styles.optTextOn]}>{o.at}</Text>
                  {o.before != null ? <Text style={[styles.optAuto, on && styles.optTextOn]}>{beforeWord(o.before)}</Text> : null}
                  {o.auto ? <Text style={[styles.optAuto, on && styles.optTextOn]}>{he ? 'מאירה ממליצה' : "Meira's pick"}</Text> : null}
                </TouchableOpacity>
              );
            })}
          </View>
          {plan?.on ? (
            <TouchableOpacity style={styles.offBtn} onPress={() => { setSheetOpen(false); choose(date, { on: false }); }}>
              <Text style={styles.offText}>
                {`🔕 ${he ? 'בלי שעון מעורר' : 'No alarm'} · ${morningAlarmLabel(plan, new Date(), he)}`}
              </Text>
            </TouchableOpacity>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );

  return { plan, error, toggle, openSheet: () => setSheetOpen(true), sheet, note };
}

export default function MorningAlarmPill({ he, state }: { he: boolean; state: MorningAlarmState }) {
  const { plan, error } = state;
  const label = error
    ? (he ? '⚠️ לא הצלחתי לבדוק את השעון המעורר' : "⚠️ Couldn't check the alarm")
    : plan
      ? `${plan.on ? '⏰' : '🔕'} ${morningAlarmLabel(plan, new Date(), he)}${plan.custom ? (he ? ' · שלך' : ' · yours') : ''}`
      : (he ? '⏰ אין שעון מעורר השבוע · לחיצה ארוכה לכוון' : '⏰ No alarm this week · hold to set one');
  const owner = plan?.task?.text;
  return (
    <>
    <View style={[styles.row, { flexDirection: he ? 'row-reverse' : 'row' }]}>
      <TouchableOpacity style={[styles.pill, plan?.on ? styles.pillOn : styles.pillOff]} activeOpacity={0.75}
        onPress={state.toggle} onLongPress={state.openSheet} delayLongPress={350}
        accessibilityRole="switch" accessibilityState={{ checked: Boolean(plan?.on) }}
        accessibilityHint={he ? 'לחיצה מדליקה או מכבה, לחיצה ארוכה משנה שעה' : 'Tap to turn on or off, hold to change the time'}>
        <Text style={[styles.pillText, !plan?.on && styles.pillTextOff]} numberOfLines={1}>{label}</Text>
      </TouchableOpacity>
      {owner && !error ? (
        <Text style={[styles.owner, he && styles.rtl]} numberOfLines={1}>
          {`${he ? 'ל' : 'for '}${owner}`}
        </Text>
      ) : null}
      {state.sheet}
    </View>
    {state.note ? <Text style={[styles.note, he && styles.rtl]}>{state.note}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 8, marginTop: 8 },
  pill: { minHeight: MIN_TOUCH - 8, borderRadius: 999, paddingHorizontal: 12, justifyContent: 'center', flexShrink: 0, maxWidth: '75%' },
  pillOn: { backgroundColor: BRAND.sunGold },
  pillOff: { backgroundColor: BRAND.goldSoft, borderWidth: 1, borderColor: BRAND.honey },
  pillText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  pillTextOff: { color: BRAND.goldInk },
  note: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.goldInk, marginTop: 2 },
  owner: { flexShrink: 1, fontFamily: FONTS.body, fontSize: 12, color: BRAND.goldInk },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFDF5', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32 },
  sheetTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.warmInk },
  sheetSub: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.goldInk, marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  opt: { minWidth: 96, minHeight: MIN_TOUCH, borderRadius: 14, borderWidth: 1, borderColor: BRAND.honey,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, backgroundColor: '#fff' },
  optOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  optText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  optTextOn: { color: BRAND.onGold },
  optAuto: { fontFamily: FONTS.body, fontSize: 10, color: BRAND.goldInk },
  offBtn: { marginTop: 16, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  offText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk },
});
