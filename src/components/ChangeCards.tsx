/**
 * ChangeCards — "the calendar moved something" (19.10, Koral's pick 1: the short card).
 *
 *   🎯 הראיון ב-Workday הוזז                                  ×
 *   ~ב׳ 19.10 13:00~ ← ג׳ 20.10 13:00
 *   הוזז ביומן · יש לך עוד יום להתכונן
 *
 * Visible without a tap (rule 5), always dated (rule 4), closed with a 44dp × and then gone
 * for good. For an interview / exam / class that moved to a later day it also OFFERS, one
 * question at a time: the server proposes a free hour ("study today 20:00?" — services/
 * ChangeSuggestService), then the morning hours (7 / 8 / 9). Every line she reads about what
 * was done comes from the booking itself, so a failed save never shows a ✓. Never a travel
 * question: the way there is travelLadder's, changed on the trip card.
 *
 * Fed by ChangeRecordStore (written by GoogleSync on every sync path). Display + close only.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';
import { closeChange, markSeen, onChangesChanged, openChanges, setChangeUi } from '../services/ChangeRecordStore';
import { acceptFill, acceptStudy, acceptWake, fillOfferFor, FillOffer, removeCancelled, suggestionFor } from '../services/ChangeSuggestService';
import { SuggestResponse, studyChipLabel } from '../utils/changeSuggestion';
import { Reasoned } from '../services/LumiServer';
import { ChangeRecord, effectLine, headline, momentLabel } from '../utils/changeRecord';
import { getTodayString } from '../utils/timeUtils';
import type { AppLanguage } from '../types/index';

export default function ChangeCards({ language }: { language: AppLanguage }) {
  const he = language === 'he';
  const [records, setRecords] = useState<ChangeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await openChanges(getTodayString());
    setRecords(res.records);
    setError(res.error ?? null);
  }, []);

  useEffect(() => {
    load().catch((e) => console.warn('[ChangeCards] load failed', e));
    return onChangesChanged(() => { load().catch(() => {}); });
  }, [load]);

  // Drawn on screen = seen: the closed-app notification about it is no longer needed.
  useEffect(() => { markSeen(records.map((x) => x.key)).catch(() => {}); }, [records]);

  if (error) {
    return (
      <View style={styles.card}>
        <Text style={styles.effect}>
          {he ? 'לא הצלחתי לקרוא את השינויים ביומן. נסי למשוך לרענון.' : "Couldn't read calendar changes. Pull to refresh."}
        </Text>
      </View>
    );
  }
  if (!records.length) return null;

  return (
    <>
      {records.map((r) => <ChangeCard key={r.key} rec={r} language={language} />)}
    </>
  );
}

/** One change, in full — drawn in the 🔔 sheet (28.10: changes live under the bell, not on the day). */
export function ChangeCard({ rec: r, language, onOpen }: { rec: ChangeRecord; language: AppLanguage; onOpen?: (taskId: string) => void }) {
  const he = language === 'he';
  const today = getTodayString();
  const stage = r.ui?.stage ?? 'study';
  const wantsOffer = r.prep && r.kind !== 'sameDay' && r.kind !== 'cancelled' && r.after.date > today && stage === 'study';
  const cancelledAsk = r.kind === 'cancelled' && stage === 'study';
  const [fill, setFill] = useState<FillOffer | null | 'loading'>(null);
  useEffect(() => {
    if (!(r.kind === 'cancelled' && stage === 'fill')) return;
    setFill('loading');
    const nothing = () => { setFill(null); setChangeUi(r.key, { stage: 'done', line: r.ui?.line }).catch(() => {}); };
    fillOfferFor(r, language).then((o) => (o ? setFill(o) : nothing())).catch(nothing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.key, stage]);
  const [sug, setSug] = useState<Reasoned<SuggestResponse> | 'loading' | null>(null);
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const ask = useCallback((retry = false) => {
    setSug('loading');
    suggestionFor(r, retry).then(setSug).catch((e) => setSug({ ok: false, reason: String(e?.message || e) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.key]);   // the key IS the state; a redraw of the same card must not ask again
  useEffect(() => { if (wantsOffer) ask(); }, [wantsOffer, ask]);

  const study = async (day: string, hhmm: string, minutes: number, morning: string[]) => {
    if (busy) return;
    setBusy(true); setFail(null);
    try {
      const res = await acceptStudy(r, day, hhmm, minutes, language);
      if (!res.saved) { setFail(res.line); return; }
      await setChangeUi(r.key, { stage: morning.length ? 'morning' : 'done', line: res.line, morning });
    } finally { setBusy(false); }
  };
  const wake = async (hhmm: string) => {
    if (busy) return;
    setBusy(true); setFail(null);
    try {
      const res = await acceptWake(r, hhmm, language);
      if (!res.saved) { setFail(res.line); return; }
      await setChangeUi(r.key, { stage: 'done', line: [r.ui?.line, res.line].filter(Boolean).join('\n') });
    } finally { setBusy(false); }
  };
  const decline = () => setChangeUi(r.key, { stage: 'done', line: r.ui?.line });
  const removeIt = async () => {
    if (busy) return;
    setBusy(true); setFail(null);
    try {
      const res = await removeCancelled(r, language);
      if (!res.ok) { setFail(res.line); return; }
      await setChangeUi(r.key, { stage: r.freed ? 'fill' : 'done', line: res.line });
    } finally { setBusy(false); }
  };
  const keepIt = () => setChangeUi(r.key, { stage: 'done', line: he ? 'השארתי אותו ביומן שלך' : 'Left it in your day' });
  const addFill = async (offer: FillOffer) => {
    if (busy) return;
    setBusy(true); setFail(null);
    try {
      const res = await acceptFill(r, offer, language);
      if (!res.ok) { setFail(res.line); return; }
      await setChangeUi(r.key, { stage: 'done', line: [r.ui?.line, res.line].filter(Boolean).join('\n') });
    } finally { setBusy(false); }
  };

  const data = sug && sug !== 'loading' && sug.ok ? sug.data : null;
  const proposal = data?.proposal ?? null;

  // The whole card opens the task (28.10: "the whole square, not only the name"); its own buttons still work.
  return (
    <Pressable disabled={!onOpen} onPress={() => onOpen?.(r.taskId)}
      style={[styles.card, r.kind === 'earlier' && r.prep ? styles.cardWarn : null]}
      accessibilityRole={onOpen ? 'button' : undefined}>
      <View style={styles.top}>
        <Text style={[styles.title, he && styles.rtl]} numberOfLines={2}>{`🎯 ${headline(r, language)}${onOpen ? ' ›' : ''}`}</Text>
        <TouchableOpacity
          style={styles.close}
          onPress={() => { closeChange(r.key).then((x) => { if (!x.ok) console.warn('[ChangeCards] close failed', x.error); }); }}
          accessibilityRole="button"
          accessibilityLabel={he ? 'סגירה' : 'Dismiss'}
        >
          <Text style={styles.closeText}>×</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.times}>
        <Text style={styles.old}>{momentLabel(r.before, language)}</Text>
        {r.kind === 'cancelled' ? null : (
          <>
            {he ? '  ←  ' : '  →  '}
            <Text style={styles.new}>{momentLabel(r.after, language)}</Text>
          </>
        )}
      </Text>
      <Text style={styles.effect}>{effectLine(r, language)}</Text>
      {r.ui?.line ? <Text style={styles.done}>{r.ui.line}</Text> : null}
      {fail ? <Text style={styles.fail}>{fail}</Text> : null}

      {wantsOffer && sug === 'loading' ? <ActivityIndicator size="small" color={BRAND.amber} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
      {wantsOffer && sug && sug !== 'loading' && !sug.ok ? (
        <TouchableOpacity style={styles.chipGhost} onPress={() => ask(true)} accessibilityRole="button">
          <Text style={styles.chipGhostText}>
            {he ? 'אין חיבור לשרת — ההצעה תחכה. נסי שוב' : 'No connection to the server — the offer will wait. Try again'}
          </Text>
        </TouchableOpacity>
      ) : null}
      {wantsOffer && data && !proposal ? (
        <Text style={styles.effect}>
          {he ? 'אין חלון פנוי ללימוד לפני — היום מלא.' : 'No free window to study before it — the day is full.'}
        </Text>
      ) : null}
      {wantsOffer && data && proposal && !other ? (
        <View style={styles.chips}>
          <TouchableOpacity style={styles.chip} disabled={busy} accessibilityRole="button"
            onPress={() => study(proposal.date, proposal.time, proposal.minutes, data.morning)}>
            <Text style={styles.chipText}>{studyChipLabel(proposal, today, language)}</Text>
          </TouchableOpacity>
          {data.starts.length > 1 ? (
            <TouchableOpacity style={styles.chipGhost} onPress={() => setOther(true)} accessibilityRole="button">
              <Text style={styles.chipGhostText}>{he ? 'שעה אחרת' : 'Another hour'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.chipGhost} onPress={decline} accessibilityRole="button">
            <Text style={styles.chipGhostText}>{he ? 'לא צריך' : 'No need'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {wantsOffer && data && proposal && other ? (
        <View style={styles.chips}>
          {data.starts.map((h) => (
            <TouchableOpacity key={h} style={styles.chip} disabled={busy} accessibilityRole="button"
              onPress={() => study(proposal.date, h, proposal.minutes, data.morning)}>
              <Text style={styles.chipText}>{h}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.chipGhost} onPress={() => setOther(false)} accessibilityRole="button">
            <Text style={styles.chipGhostText}>{he ? 'חזרה' : 'Back'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {cancelledAsk ? (
        <>
          <Text style={styles.ask}>{he ? 'להסיר אותו מהיום?' : 'Remove it from your day?'}</Text>
          <View style={styles.chips}>
            <TouchableOpacity style={styles.chip} disabled={busy} onPress={removeIt} accessibilityRole="button">
              <Text style={styles.chipText}>{(r.orphanIds?.length ?? 0) > 0 ? (he ? 'להסיר גם את ההכנות' : 'Remove with its prep') : (he ? 'להסיר מהיום' : 'Remove it')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.chipGhost} onPress={keepIt} accessibilityRole="button">
              <Text style={styles.chipGhostText}>{he ? 'להשאיר' : 'Keep it'}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
      {r.kind === 'cancelled' && stage === 'fill' && fill === 'loading' ? <ActivityIndicator size="small" color={BRAND.amber} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
      {r.kind === 'cancelled' && stage === 'fill' && fill && fill !== 'loading' ? (
        <>
          <Text style={styles.ask}>{he ? `יש לך חלון פנוי ${r.freed?.start}–${r.freed?.end}. למלא אותו?` : `You have a free window ${r.freed?.start}–${r.freed?.end}. Fill it?`}</Text>
          <View style={styles.chips}>
            <TouchableOpacity style={styles.chip} disabled={busy} onPress={() => addFill(fill)} accessibilityRole="button">
              <Text style={styles.chipText} numberOfLines={2}>{fill.label}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.chipGhost} onPress={decline} accessibilityRole="button">
              <Text style={styles.chipGhostText}>{he ? 'לא צריך' : 'No need'}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      {stage === 'morning' && r.ui?.morning?.length ? (
        <>
          <Text style={styles.ask}>
            {he ? 'ובבוקר של האירוע — להעיר אותך ללמוד?' : 'On the morning of it — wake you to study?'}
          </Text>
          <View style={styles.chips}>
            {r.ui.morning.map((h) => (
              <TouchableOpacity key={h} style={styles.chip} disabled={busy} accessibilityRole="button" onPress={() => wake(h)}>
                <Text style={styles.chipText}>{h}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.chipGhost} onPress={decline} accessibilityRole="button">
              <Text style={styles.chipGhostText}>{he ? 'לא צריך' : 'No need'}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: 16, padding: 12, marginBottom: 12, gap: 4,
    borderWidth: 1, borderColor: BRAND.line, borderStartWidth: 4, borderStartColor: BRAND.sunGold,
  },
  cardWarn: { borderStartColor: BRAND.danger },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  title: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  close: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', marginVertical: -8 },
  closeText: { fontSize: 22, color: BRAND.inkSoft },
  times: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.warmInk },
  old: { textDecorationLine: 'line-through', color: BRAND.inkFaint },
  new: { fontFamily: FONTS.bodyHeavy },
  effect: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  done: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.success, marginTop: 2 },
  fail: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.danger, marginTop: 2 },
  ask: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk, marginTop: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: { minHeight: MIN_TOUCH, paddingHorizontal: 14, borderRadius: 999, backgroundColor: BRAND.sunGold, justifyContent: 'center' },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold },
  chipGhost: { minHeight: MIN_TOUCH, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.white, justifyContent: 'center', alignSelf: 'flex-start' },
  chipGhostText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft },
});
