/**
 * SettingsMenu — the Menu (30.9 pick "A", built 6.10).
 *
 * Doors, not settings: You · Calendars & mail · Alerts · Helpers, each with a
 * one-line status of what is TRUE behind it, plus Hear / Review my day,
 * Language (drawn here and nowhere else) and More. Every door opens one page
 * of ProfileEditScreen; every setting is drawn on exactly one page, so nothing
 * appears twice (tests/run-menu-map.ts).
 *
 * What it replaced: three switches that saved nothing (wake alarms, deadline
 * reminders, badges), Privacy and Terms rows that did nothing, the calendar
 * and AI-assistant panels duplicated from elsewhere, and an English-only screen.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { BRAND, FONTS, MIN_TOUCH, surf, nline } from '../constants/theme';
import HistorySwitch from '../components/HistorySwitch';
import { loadDemoDay, clearDemoDay } from '../services/DemoDay';
import { loadProfile } from '../services/UserProfileStorage';
import { getSettings, saveSettings } from '../services/TaskStorage';
import { speakMorningBriefingNow } from '../services/MorningBriefingService';
import { deviceCalendarsEnabled } from '../services/DeviceCalendarSync';
import { GoogleService } from '../services/GoogleService';
import { outlookConnected } from '../services/OutlookService';
import { getUserId } from '../services/SupabaseAuthService';
import { loadRoutines } from '../services/GapFillService';
import { normalizeProfile } from '../utils/profileShape';
import { syncCalendarNow } from '../services/CalendarAutoSync';
import { getGmailEventSuggestions } from '../services/GoogleSync';
import { GMAIL_ENABLED } from '../utils/gmailAccess';
import { calendarUpdateLine } from '../utils/calendarUpdateLine';
import { AppLanguage, AppSettings, TimeSetting } from '../types/models';
import { UserProfile } from '../types';
import { WashedSky } from '../components/ui/SkyBackdrop';
import LineIcon, { LineIconName } from '../components/ui/LineIcon';

const PRIVACY_URL = `${process.env.EXPO_PUBLIC_SERVER_URL || 'https://lumi-whatsapp.fly.dev'}/privacy`;
const TRANSPORT_ICON: Record<string, string> = { transit: '🚌', bus: '🚌', car: '🚗', bicycle: '🚴', bike: '🚴', foot: '🚶', walk: '🚶' };

const hhmm = (t?: TimeSetting) => (t ? `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}` : '–');

export default function SettingsMenu({ navigation }: { navigation: any }) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [routineCount, setRoutineCount] = useState<number | null>(null);
  const [calendars, setCalendars] = useState<string>('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const he = settings?.language === 'he';
  const T = (en: string, hebrew: string) => (he ? hebrew : en);

  useFocusEffect(useCallback(() => {
    getSettings().then(setSettings).catch((e) => console.warn('[Menu] settings unreadable', e));
    loadProfile().then((p) => setProfile(normalizeProfile(p))).catch(() => setProfile(null));
    getUserId().then((id) => setSignedIn(Boolean(id))).catch(() => setSignedIn(false));
    loadRoutines().then((rs) => setRoutineCount(rs.filter((r) => r.source === 'notes').length)).catch(() => setRoutineCount(null));
    Promise.all([
      deviceCalendarsEnabled().catch(() => false),
      GoogleService.connectedGoogleAccount().catch(() => ({ connected: false } as { connected: boolean; email?: string })),
      outlookConnected().catch(() => false),
    ]).then(([device, google, outlook]) => {
      const parts = [
        device ? '📱 ✓' : '',
        google.connected ? `Google ✓${google.email ? ` ${google.email}` : ''}` : '',
        outlook ? 'Outlook ✓' : '',
      ].filter(Boolean);
      setCalendars(parts.join(' · '));
    });
  }, []));

  const setLanguage = async (language: AppLanguage) => {
    if (!settings) return;
    const next = { ...settings, language };
    setSettings(next);
    await saveSettings(next).catch((e) => Alert.alert('Language', `Not saved: ${String(e)}`));
  };

  const hearMyDay = async () => {
    setBusy('hear');
    try {
      await speakMorningBriefingNow();
    } catch (e) {
      Alert.alert(T('Hear my day', 'להשמיע את היום'), T(`Couldn't read it out: ${String(e)}`, `לא הצלחתי להקריא: ${String(e)}`));
    } finally {
      setBusy(null);
    }
  };

  // 📅 left Today's header for here (8.10, Koral: "move it into the menu as
  // update calendars"). Every calendar now, past the throttle (she went
  // looking — rule 7), then the mail; it says what happened, a failure too.
  const updateCalendars = async () => {
    setBusy('cal');
    try {
      const lang: AppLanguage = he ? 'he' : 'en';
      const r = await syncCalendarNow(lang, 'menu');
      const found = await getGmailEventSuggestions(lang).catch((e) => {
        console.warn('[Menu] email events failed', e);
        return [];
      });
      // Gmail off in this build: the line says so instead of "0 in your email".
      const line = calendarUpdateLine(r, GMAIL_ENABLED ? found.length : null, he);
      const close = { text: T('OK', 'סגירה'), style: 'cancel' as const };
      if (line.nothingConnected) {
        Alert.alert(line.title, line.body, [close, { text: T('Connect', 'לחבר'), onPress: () => open('calendars') }]);
      } else if (found.length > 0) {
        // The same banner the 📅 used to open: add all, or one by one.
        Alert.alert(line.title, line.body, [close, {
          text: T('Show', 'להציג'),
          onPress: () => navigation.navigate('MainTabs', { screen: 'Today', params: { openEvents: Date.now() } }),
        }]);
      } else {
        Alert.alert(line.title, line.body, [close]);
      }
    } catch (e) {
      Alert.alert(T('Update calendars', 'עדכון יומנים'), T(`Couldn't update: ${String(e)}`, `לא הצלחתי לעדכן: ${String(e)}`));
    } finally {
      setBusy(null);
    }
  };

  // A fresh account (a judge's) gets a real day to try every feature on.
  // Each run says what happened — including when it did not.
  const runDemo = async (load: boolean) => {
    setBusy('demo');
    try {
      if (load) {
        const r = await loadDemoDay(he ? 'he' : 'en');
        Alert.alert(r.error ? 'Demo day — partly loaded' : 'Demo day loaded',
          r.error ? `${r.created} tasks created, then: ${r.error}` : `${r.created} tasks, routes and alerts planned. Open Today.`);
      } else {
        const n = await clearDemoDay();
        Alert.alert('Demo day cleared', `${n} demo tasks removed. Your own tasks were not touched.`);
      }
    } catch (e) {
      Alert.alert('Demo day failed', String(e));
    } finally {
      setBusy(null);
    }
  };

  const open = (section: string) => navigation.navigate('ProfileEdit', { section });
  const transport = TRANSPORT_ICON[String((profile as any)?.transportMode || profile?.transportType || '')] || '';
  const youLine = [
    profile?.homeAddress ? `🏠 ${String(profile.homeAddress).split(',')[0]}` : T('Home not set', 'בית לא הוגדר'),
    transport,
    routineCount != null ? T(`${routineCount} routines`, `${routineCount} שגרות`) : '',
  ].filter(Boolean).join(' · ');
  const alertsLine = settings
    ? `${settings.wakeAlarmEnabled !== false ? T('Wake alarm on', 'שעון מעורר פעיל') : T('Wake alarm off', 'שעון מעורר כבוי')} · ${T('check-ins', 'צ׳ק-אין')} ${hhmm(settings.morningTime)} / ${hhmm(settings.eveningTime)}`
    : '';

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <WashedSky />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={[styles.head, he && styles.rowRtl]}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{profile?.name?.[0]?.toUpperCase() ?? 'M'}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.name, he && styles.rtl]}>{profile?.name || T('Hi there', 'היי')}</Text>
            <Text style={[styles.sub, he && styles.rtl, signedIn === false && { color: BRAND.danger }]}>
              {signedIn == null ? '' : signedIn ? T('Signed in ✓', 'מחוברת ✓') : T('Not signed in — tap More › Account', 'לא מחוברת — עוד › חשבון')}
            </Text>
          </View>
          <TouchableOpacity style={styles.close} onPress={() => navigation.goBack()} accessibilityRole="button"
            accessibilityLabel={T('Close', 'סגירה')}>
            <Text style={styles.closeText}>×</Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.quick, he && styles.rowRtl]}>
          <TouchableOpacity style={styles.quickBtn} onPress={hearMyDay} disabled={busy === 'hear'} accessibilityRole="button">
            {busy === 'hear' ? <ActivityIndicator color={BRAND.goldInk} /> : <Text style={styles.quickText}>{T('🔊 Hear my day', '🔊 להשמיע את היום')}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('DayReview')} accessibilityRole="button">
            <Text style={styles.quickText}>{T('☑️ Review my day', '☑️ סיכום היום')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickBtn} onPress={updateCalendars} disabled={busy === 'cal'} accessibilityRole="button">
            {busy === 'cal' ? <ActivityIndicator color={BRAND.goldInk} /> : <Text style={styles.quickText}>{T('📅 Update calendars', '📅 עדכון יומנים')}</Text>}
          </TouchableOpacity>
        </View>

        <Door he={he} icon="user" title={T('You', 'את')} line={youLine} onPress={() => open('you')} />
        {/* The first meeting, again — a new routine, a new job (8.10): Meira asks only what she
            does not know yet, in her own voice. */}
        <Door he={he} icon="mic" title={T('Tell Meira about you', 'לספר למאירה עלייך')}
          line={T('Morning, routines, work — by voice', 'בוקר, רוטינות, עבודה — בקול')}
          onPress={() => navigation.navigate('Onboarding')} />
        <Door he={he} icon="calendar" title={T('Calendars & mail', 'יומנים ומייל')}
          line={calendars || T('Nothing connected yet', 'עוד לא חובר כלום')} onPress={() => open('calendars')} />
        <Door he={he} icon="bell" title={T('Alerts', 'התראות')} line={alertsLine} onPress={() => open('alerts')} />
        <Door he={he} icon="bot" title={T('Helpers', 'עוזרים')} line={T('Your agents · AI assistants · Learning sessions', 'הסוכנים שלך · עוזרי AI · למידה ממוקדת')}
          onPress={() => open('helpers')} />

        <View style={[styles.langRow, he && styles.rowRtl]}>
          <Text style={styles.langLabel}>{T('🌐 Language', '🌐 שפה')}</Text>
          <View style={styles.seg} accessibilityRole="radiogroup">
            {(['en', 'he'] as AppLanguage[]).map((lang) => (
              <TouchableOpacity key={lang} onPress={() => setLanguage(lang)} accessibilityRole="radio"
                accessibilityState={{ selected: settings?.language === lang }}
                style={[styles.segBtn, settings?.language === lang && styles.segOn]}>
                <Text style={styles.segText}>{lang === 'en' ? 'English' : 'עברית'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <TouchableOpacity style={[styles.more, he && styles.rowRtl]} onPress={() => setMoreOpen((v) => !v)} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={[styles.moreTitle, he && styles.rtl]}>{T('More', 'עוד')}</Text>
            <Text style={[styles.sub, he && styles.rtl]}>{T('Progress · History · Demo day · Privacy · Account', 'התקדמות · היסטוריה · יום הדגמה · פרטיות · חשבון')}</Text>
          </View>
          <Text style={styles.chev}>{moreOpen ? '⌄' : he ? '‹' : '›'}</Text>
        </TouchableOpacity>
        {moreOpen && (
          <View style={styles.moreList}>
            <Row he={he} label={T('📊 Progress', '📊 התקדמות')} onPress={() => navigation.navigate('Analytics')} />
            <Row he={he} label={T('👥 Find time together', '👥 למצוא זמן ביחד')} onPress={() => navigation.navigate('FindTime')} />
            {busy === 'demo' ? <ActivityIndicator color={BRAND.goldInk} style={{ marginVertical: 10 }} /> : (
              <>
                <Row he={he} label={T('✨ Load demo day', '✨ לטעון יום הדגמה')} onPress={() => runDemo(true)} />
                <Row he={he} label={T('🧹 Clear demo day', '🧹 לנקות יום הדגמה')} onPress={() => runDemo(false)} />
              </>
            )}
            <HistorySwitch he={he} />
            <Row he={he} label={T('🔒 Privacy policy', '🔒 מדיניות פרטיות')}
              onPress={() => Linking.openURL(PRIVACY_URL).catch((e) => Alert.alert('Privacy', String(e)))} />
            <Row he={he} label={T('👤 Account · sign in, sign out, delete', '👤 חשבון · התחברות, יציאה, מחיקה')} onPress={() => open('account')} />
            <Text style={[styles.version, he && styles.rtl]}>
              {T('Version', 'גרסה')} {Constants.expoConfig?.version ?? '–'}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Door({ he, icon, title, line, onPress }: { he: boolean; icon: LineIconName; title: string; line: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.door, he && styles.rowRtl]} onPress={onPress} accessibilityRole="button">
      <View style={styles.doorIcon}><LineIcon name={icon} size={22} color={BRAND.goldInk} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.doorTitle, he && styles.rtl]}>{title}</Text>
        {/* A Hebrew address at the front of an English line (or the reverse) made Android lay the whole
            line out the other way round: it takes the direction from the first strong letter. A
            LRM / RLM first pins it to the app's language. Two lines, so the routines count at the
            end of "You" is not the part that is cut. */}
        {line ? <Text style={[styles.doorLine, he && styles.rtl]} numberOfLines={2}>{(he ? '\u200F' : '\u200E') + line}</Text> : null}
      </View>
      <Text style={styles.chev}>{he ? '‹' : '›'}</Text>
    </TouchableOpacity>
  );
}

function Row({ he, label, onPress }: { he: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.row, he && styles.rowRtl]} onPress={onPress} accessibilityRole="button">
      <Text style={[styles.rowText, he && styles.rtl]}>{label}</Text>
      <Text style={styles.chev}>{he ? '‹' : '›'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  scroll: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  rowRtl: { flexDirection: 'row-reverse' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 22, fontFamily: FONTS.display, color: BRAND.onGold },
  name: { fontSize: 22, fontFamily: FONTS.display, color: BRAND.warmInk },
  sub: { fontSize: 12, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: BRAND.creamCard, alignItems: 'center', justifyContent: 'center' },
  // × (U+00D7) is in Inter; the heavy ballot-X this used to draw is not, and fell back to a thin system glyph.
  closeText: { fontSize: 26, lineHeight: 28, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft },
  quick: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  quickBtn: { flex: 1, minHeight: MIN_TOUCH + 8, borderRadius: 16, backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 8 },
  quickText: { fontSize: 14, textAlign: 'center', fontFamily: FONTS.bodyHeavy, color: BRAND.goldInk },
  door: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 78, padding: 14, borderRadius: 22, backgroundColor: surf('rgba(255,255,255,0.92)'), borderWidth: 1, borderColor: nline('rgba(255,255,255,0.9)') },
  doorIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center' },
  doorIconText: { fontSize: 24 },
  doorTitle: { fontSize: 18, fontFamily: FONTS.display, color: BRAND.warmInk },
  doorLine: { fontSize: 13, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft, marginTop: 2 },
  chev: { fontSize: 22, fontFamily: FONTS.bodyHeavy, color: BRAND.goldInk },
  langRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 10 },
  langLabel: { fontSize: 14, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft },
  seg: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 14, backgroundColor: BRAND.goldSoft },
  segBtn: { minHeight: 40, minWidth: 88, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  segOn: { backgroundColor: BRAND.creamCard },
  segText: { fontSize: 13, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  more: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, marginTop: 10, borderTopWidth: 1, borderTopColor: BRAND.line, paddingTop: 10 },
  moreTitle: { fontSize: 15, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  moreList: { borderRadius: 16, backgroundColor: BRAND.creamCard, paddingHorizontal: 14 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  rowText: { flex: 1, fontSize: 14, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  version: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft, paddingVertical: 12 },
});
