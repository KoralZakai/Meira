/**
 * MeiraHomePanel — the top of the chat when the chat IS the home screen.
 *
 * Koral, 27.10 (design canvas v4, "the main screen will be the chat"): Meira
 * greets her and says what matters now (utils/homeBrief), offers ONE thing
 * (✨ Meira suggests — the + on Today's own ranking, place-aware first), six
 * equal tiles (my day · tomorrow · another day · add · next task · how do I get
 * there) and a row of things to just ask. Everything else is the free chat
 * under it: she asks, Meira does.
 *
 * Triggers (rule 7): it is drawn whenever the chat is the home tab; the brief
 * and the suggestion are re-read when the tab comes into focus.
 */
import React from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS, SHADOWS } from '../../constants/theme';
import MeiraCoin from '../MeiraCoin';
import { useAddSuggestions } from '../../hooks/useAddSuggestions';
import { useApplySuggestion, Prefill } from '../../hooks/useApplySuggestion';
import { getTodayString } from '../../utils/timeUtils';
import BottomSheet from '../ui/BottomSheet';
import LineIcon from '../ui/LineIcon';
import { contactPhoneOf } from '../../utils/lateNotice';
import { openLocationInMaps } from '../../services/NearbyTaskReminderService';
import type { Task } from '../../types/index';
import { shortPlace } from '../../utils/tripPlaces';

export type HomeTile = 'today' | 'tomorrow' | 'pick' | 'add' | 'next' | 'route' | 'ideas';

interface Props {
  he: boolean;
  name?: string;
  /** What is happening now or next (utils/homeBrief) — its own card. */
  next?: Task;
  leaveAt?: string;
  onTile: (tile: HomeTile) => void;
  /** A whole question is sent; one ending in "…" goes into the box to finish. */
  onAsk: (text: string) => void;
  onPrefill: (a: Prefill) => void;
  onOpenTask: (taskId: string) => void;
  onChanged: () => void;
}

const TILES: Array<{ id: HomeTile; icon: string; bg: string; en: string; he: string }> = [
  { id: 'today', icon: '☀️', bg: '#FFF1C7', en: 'My day', he: 'היום שלי' },
  // A sunrise, not a moon — "tomorrow" read as "night" (Koral, 27.10).
  { id: 'tomorrow', icon: '🌅', bg: '#FFE9D6', en: 'Tomorrow', he: 'מחר' },
  { id: 'pick', icon: '📅', bg: '#E5F0FF', en: 'Another day', he: 'יום אחר' },
  { id: 'add', icon: '➕', bg: '#E6FAF3', en: 'Add', he: 'להוסיף' },
  { id: 'next', icon: '🎯', bg: '#FFE3EA', en: 'Next task', he: 'המשימה הבאה' },
  { id: 'route', icon: '🧭', bg: '#EEF0FF', en: 'How do I get there', he: 'איך מגיעים' },
  // 28.10: Meira's suggestions are a shortcut like the rest, opening the full list.
  { id: 'ideas', icon: '✨', bg: '#F1EDFF', en: 'Suggestions', he: 'הצעות' },
];

export const HOME_ASKS: Array<{ en: string; he: string }> = [
  { en: 'What matters most today?', he: 'מה הכי חשוב היום?' },
  { en: 'What should I do first?', he: 'מה לעשות קודם?' },
  { en: 'When am I free for…', he: 'מתי אני פנויה ל…' },
  { en: 'Nearest parking to the beach by car', he: 'החניה הכי קרובה לחוף באוטו' },
  { en: 'Put in my calendar…', he: 'תסמני לי ביומן…' },
  { en: 'Stop at home before my next task — when do I leave?', he: 'לעבור בבית לפני המשימה הבאה — מתי לצאת?' },
];

export default function MeiraHomePanel({ he, name, next, leaveAt, onTile, onAsk, onPrefill, onOpenTask, onChanged }: Props) {
  const view = useAddSuggestions(getTodayString());
  const { onPick, takeBack, busyId, used, undo, failed } = useApplySuggestion({ he, onPrefill, onOpenTask, onChanged });
  const [ideasOpen, setIdeasOpen] = React.useState(false);
  const ideas = view.rows.filter((r) => !used.has(r.id));
  const dir = he ? 'row-reverse' : 'row';
  const loc: any = next && typeof next.location === 'object' ? next.location : null;
  const place = loc ? shortPlace(loc.displayName || loc.address) : '';
  const phone = next ? contactPhoneOf(next) : '';
  const at = next ? (next.fixedTime || next.scheduledTime || '') : '';

  return (
    <View style={styles.wrap}>
      {/* 28.10: the greeting alone — what is next is its own card, below. */}
      <View style={[styles.greetRow, { flexDirection: dir }]}>
        <MeiraCoin size={44} glow label="Meira" />
        <Text style={[styles.greet, { flex: 1, minWidth: 0 }, he && styles.rtl]} numberOfLines={2}>
          {he ? `היי${name ? ` ${name}` : ''}, איך אפשר לעזור?` : `Hi${name ? ` ${name}` : ''}, how can I help?`}
        </Text>
      </View>

      {/* הבא בלו״ז — the whole card opens the task; 📍 and 📞 act at once. */}
      {next ? (
        <Pressable style={[styles.next, { flexDirection: dir }]} onPress={() => onOpenTask(next.id)}
          accessibilityRole="button" accessibilityLabel={he ? `הבא בלו״ז: ${next.text}` : `Next: ${next.text}`}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.nextCap, he && styles.rtl]}>{he ? 'הבא בלו״ז' : 'Next up'}</Text>
            <Text style={[styles.nextTitle, he && styles.rtl]} numberOfLines={2}>{`${next.text} ›`}</Text>
            <Text style={[styles.nextWhen, he && styles.rtl]} numberOfLines={1}>
              {[at, leaveAt ? (he ? `צאי ${leaveAt}` : `leave ${leaveAt}`) : '', place].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <View style={[styles.nextIcons, { flexDirection: dir }]}>
            {loc && (loc.lat || loc.address) ? (
              <Pressable style={styles.nextIcon} accessibilityRole="button" accessibilityLabel={he ? 'ניווט' : 'Navigate'}
                onPress={() => { openLocationInMaps(place, loc.lat && loc.lng ? { lat: loc.lat, lng: loc.lng } : undefined).catch(() => {}); }}>
                <LineIcon name="map" size={20} color={BRAND.goldInk} />
              </Pressable>
            ) : null}
            {phone ? (
              <Pressable style={styles.nextIcon} accessibilityRole="button" accessibilityLabel={he ? 'להתקשר' : 'Call'}
                onPress={() => { Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch((e) => console.warn('[Home] call failed', e)); }}>
                <Text style={styles.nextIconText}>📞</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      ) : (
        <View style={styles.next}>
          <Text style={[styles.nextTitle, he && styles.rtl]} numberOfLines={2}>{he ? 'אין עוד משהו בשעה קבועה היום ✓' : 'Nothing else with a set time today ✓'}</Text>
        </View>
      )}

      {undo ? (
        <Pressable style={[styles.undo, { flexDirection: dir }]} onPress={takeBack} accessibilityRole="button">
          <Text style={styles.undoText} numberOfLines={1}>{undo.line}</Text>
          <Text style={styles.undoBtn} numberOfLines={1}>{he ? 'ביטול' : 'Undo'}</Text>
        </Pressable>
      ) : null}
      {failed ? <Text style={[styles.failed, he && styles.rtl]}>{failed}</Text> : null}

      <View style={[styles.grid, { flexDirection: dir }]}>
        {TILES.map((t) => (
          <Pressable key={t.id} style={styles.tile} onPress={() => (t.id === 'ideas' ? setIdeasOpen(true) : onTile(t.id))}
            accessibilityRole="button" accessibilityLabel={he ? t.he : t.en}>
            <View style={[styles.tileIcon, { backgroundColor: t.bg }]}><Text style={styles.tileIconText}>{t.icon}</Text></View>
            <Text style={styles.tileText} numberOfLines={2}>{he ? t.he : t.en}</Text>
            {t.id === 'ideas' && ideas.length ? <View style={styles.tileBadge}><Text style={styles.tileBadgeText}>{ideas.length}</Text></View> : null}
          </Pressable>
        ))}
      </View>

      <View style={[styles.asks, { flexDirection: dir }]}>
        {HOME_ASKS.map((a) => (
          <Pressable key={a.en} style={styles.ask} onPress={() => onAsk(he ? a.he : a.en)} accessibilityRole="button">
            <Text style={styles.askText} numberOfLines={1}>{he ? a.he : a.en}</Text>
          </Pressable>
        ))}
      </View>

      {/* ✨ Meira's suggestions — all of them, each with its own add (was one card + a dead "more"). */}
      <BottomSheet visible={ideasOpen} onClose={() => setIdeasOpen(false)} heightRatio={0.75}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.ideasBody}>
          <Text style={[styles.ideasTitle, he && styles.rtl]}>{he ? '✨ מאירה מציעה' : '✨ Meira suggests'}</Text>
          {view.loading ? <ActivityIndicator color={BRAND.goldInk} /> : null}
          {!view.loading && !ideas.length ? (
            <Text style={[styles.ideasEmpty, he && styles.rtl]}>
              {view.allFailed
                ? (he ? 'לא הצלחתי להביא הצעות עכשיו — נסי שוב עוד מעט.' : "Couldn't fetch suggestions now — try again soon.")
                : (he ? 'אין כרגע הצעות — היום מסודר ✓' : 'No suggestions right now — your day is set ✓')}
            </Text>
          ) : null}
          {ideas.map((r) => (
            <View key={r.id} style={[styles.idea, { flexDirection: dir }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.suggestTitle, he && styles.rtl]} numberOfLines={2}>{`${r.source === 'way' ? '📍 ' : ''}${he ? r.titleHe : r.title}`}</Text>
                <Text style={[styles.suggestWhy, he && styles.rtl]} numberOfLines={2}>{he ? r.whyHe : r.why}</Text>
              </View>
              <Pressable style={styles.btnMain} onPress={() => onPick(r)} accessibilityRole="button" disabled={busyId === r.id}>
                {busyId === r.id ? <ActivityIndicator color={BRAND.white} size="small" />
                  : <Text style={styles.btnMainText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{he ? 'להוסיף' : 'Add'}</Text>}
              </Pressable>
            </View>
          ))}
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

const GAP = 8;
const styles = StyleSheet.create({
  wrap: { gap: 12, paddingBottom: 8 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  greetRow: { alignItems: 'center', gap: 12 },
  next: {
    alignItems: 'center', gap: 10, padding: 14, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 1, borderColor: '#FFFFFF', ...SHADOWS.card,
  },
  nextCap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  nextTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 17, color: BRAND.warmInk, marginTop: 2 },
  nextWhen: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft, marginTop: 2, fontVariant: ['tabular-nums'] },
  nextIcons: { gap: 8 },
  nextIcon: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center' },
  nextIconText: { fontSize: 18 },
  tileBadge: { position: 'absolute', top: 2, right: 10, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#5A4FE0', alignItems: 'center', justifyContent: 'center' },
  tileBadgeText: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.white },
  ideasBody: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  ideasTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 19, color: BRAND.warmInk },
  ideasEmpty: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.inkSoft },
  idea: { alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: BRAND.line },
  greetBubble: {
    flex: 1, minWidth: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 20, padding: 14, ...SHADOWS.card,
  },
  greet: { fontFamily: FONTS.bodyHeavy, fontSize: 20, color: BRAND.warmInk },
  brief: { fontFamily: FONTS.bodySemi, fontSize: 13, color: '#463FB8', marginTop: 4, lineHeight: 19 },
  suggest: { backgroundColor: 'rgba(255,253,240,0.95)', borderRadius: 20, padding: 12, gap: 10, borderWidth: 1, borderColor: '#FFFFFF' },
  suggestHead: { gap: 10, alignItems: 'flex-start' },
  suggestIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#6C63FF', alignItems: 'center', justifyContent: 'center' },
  suggestIconText: { fontSize: 17 },
  suggestCap: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: '#5850DB' },
  suggestTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, marginTop: 2 },
  suggestWhy: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft, marginTop: 2 },
  suggestBtns: { gap: 8 },
  btnMain: { minHeight: MIN_TOUCH, paddingHorizontal: 16, borderRadius: RADIUS.pill, backgroundColor: '#5A4FE0', alignItems: 'center', justifyContent: 'center' },
  btnMainText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.white },
  btnSoft: { minHeight: MIN_TOUCH, paddingHorizontal: 16, borderRadius: RADIUS.pill, backgroundColor: 'rgba(20,27,46,0.06)', alignItems: 'center', justifyContent: 'center' },
  btnSoftText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  undo: { alignItems: 'center', gap: 10, backgroundColor: '#1A1A2E', borderRadius: 16, paddingHorizontal: 14, minHeight: MIN_TOUCH },
  undoText: { flex: 1, fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.white },
  undoBtn: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.sunGold },
  failed: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.lateInk },
  grid: { flexWrap: 'wrap', rowGap: 10 },
  // 28.10 (Koral): an icon and its word under it, no frame around — the frame cut the word ("Tomorro w").
  tile: { width: '25%', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 2 },
  tileIcon: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  tileIconText: { fontSize: 24 },
  tileText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, lineHeight: 16, color: BRAND.warmInk, textAlign: 'center' },
  asks: { flexWrap: 'wrap', gap: 6 },
  ask: {
    minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)',
  },
  askText: { fontFamily: FONTS.bodySemi, fontSize: 12, color: '#2F3B57' },
});
