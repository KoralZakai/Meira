/**
 * CalendarConnections — Menu → Calendars & mail. Every row is real.
 *
 * It replaced three rows (Google Calendar, Gmail, Contacts) whose onPress was
 * `() => {}` — a button that cannot fail is rule 3's exact bug. Each row here
 * shows what is TRUE right now (connected to whom, how many events on the
 * last run, when, or the reason it read nothing) and a tap does the thing:
 * connect, or sync now and say what arrived.
 *
 *   📱 Phone calendars   — DeviceCalendarSync: every account on the phone
 *                          (private and work Gmail, Outlook app, Samsung)
 *   📅 Google accounts   — GoogleService + GoogleSync, ONE ROW PER ACCOUNT
 *                          (6.10: "private and work Gmail"), each with its own
 *                          📅 calendar / ✉️ mail switches, status and Disconnect
 *   🟦 Outlook · Teams   — OutlookService (Microsoft Graph)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Switch } from 'react-native';

import { BRAND, FONTS } from '../constants/theme';
import { GoogleService, type GoogleAccount } from '../services/GoogleService';
import { syncCalendarNow, lastSyncAt, type CalendarSyncResult } from '../services/CalendarAutoSync';
import { calendarErrorsByAccount } from '../services/GoogleSync';
import {
  deviceCalendarsEnabled, enableDeviceCalendars, disableDeviceCalendars, listDeviceCalendars,
  setDeviceCalendarIncluded, lastDeviceCalendarResult,
  type DeviceCalendarInfo, type DeviceCalendarResult, type DeviceCalendarFailure,
} from '../services/DeviceCalendarSync';
import {
  outlookConfigured, outlookConnected, outlookAccount, outlookAccounts, signInWithMicrosoft, signOutMicrosoft,
  lastOutlookResult, type OutlookSyncResult, type OutlookFailure,
} from '../services/OutlookService';
import { useAppLanguage } from '../hooks/useAppLanguage';
import { GMAIL_ENABLED, gmailOffShort } from '../utils/gmailAccess';

function clock(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // Rule 4: something from another day shows its day.
  return d.toDateString() === today.toDateString() ? hm : `${d.getDate()}.${d.getMonth() + 1} ${hm}`;
}

export function deviceFailureText(e?: DeviceCalendarFailure, he = false): string {
  if (!e) return '';
  if (e === 'off') return he ? 'כבוי' : 'Off';
  if (e === 'permission_denied') return he ? 'הגישה ליומן כבויה — לאשר בהגדרות אנדרואיד ← אפליקציות ← Meira' : 'Calendar access is off — allow it in Android Settings → Apps → Meira';
  if (e === 'no_calendars') return he ? 'אין יומנים בטלפון' : 'No calendars on this phone';
  if (e === 'all_excluded') return he ? 'כל היומנים כבויים למטה' : 'Every calendar is switched off below';
  if (e === 'expo_go') return he ? 'צריך את האפליקציה המותקנת, לא Expo Go' : 'Needs the installed app, not Expo Go';
  return `${he ? 'לא נקרא' : 'Could not read'}: ${e.replace(/^read_failed: /, '')}`;
}

export function outlookFailureText(e?: OutlookFailure, he = false): string {
  if (!e) return '';
  if (e === 'not_configured') return he ? 'לא מוגדר בגרסה הזאת' : 'Not set up in this build (no Microsoft app id)';
  if (e === 'not_connected') return he ? 'לא מחובר' : 'Not connected';
  if (e === 'cancelled') return he ? 'ההתחברות בוטלה' : 'Sign-in was cancelled';
  if (e === 'reconnect') return he ? 'מיקרוסופט ניתקה — לחצי להתחבר שוב' : 'Microsoft signed us out — tap to sign in again';
  return e;
}

function googleFailureText(e: string | null | undefined, he = false): string {
  if (!e) return '';
  if (e === 'not_connected') return he ? 'לא מחובר' : 'Not connected';
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(e)) return he ? 'ה-Calendar API כבוי ב-Google Cloud' : 'Calendar API is off in Google Cloud';
  if (/http_401|http_403|invalid_grant/i.test(e)) return he ? 'גוגל סירבה — לחצי להתחבר מחדש' : 'Google refused us — tap to sign in again';
  return e.slice(0, 80);
}

function summarize(r: CalendarSyncResult, he: boolean): string {
  const lines = [he ? `${r.added} אירועים חדשים או מתוקנים.` : `${r.added} new or corrected event(s).`];
  if (r.error && r.error !== 'not_connected') lines.push(`Google: ${googleFailureText(r.error, he)}`);
  if (r.device && r.device.error !== 'off') {
    lines.push(r.device.ok
      ? (he ? `יומני הטלפון: ${r.device.events} אירועים ב-${r.device.calendarsRead} יומנים` : `Phone calendars: ${r.device.events} event(s) in ${r.device.calendarsRead} calendar(s)`)
      : `${he ? 'יומני הטלפון' : 'Phone calendars'}: ${deviceFailureText(r.device.error, he)}`);
  }
  if (r.outlook && r.outlook.error !== 'not_connected' && r.outlook.error !== 'not_configured') {
    lines.push(r.outlook.ok ? `Outlook: ${r.outlook.events} ${he ? 'אירועים' : 'event(s)'}` : `Outlook: ${outlookFailureText(r.outlook.error, he)}`);
  }
  return lines.join('\n');
}

export default function CalendarConnections() {
  const { he } = useAppLanguage();
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const [busy, setBusy] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [gErrors, setGErrors] = useState<Record<string, string>>({});
  const [syncedAt, setSyncedAt] = useState(0);
  const [deviceOn, setDeviceOn] = useState(false);
  const [device, setDevice] = useState<DeviceCalendarResult | null>(null);
  const [cals, setCals] = useState<DeviceCalendarInfo[]>([]);
  const [showCals, setShowCals] = useState(false);
  const [outlook, setOutlook] = useState<{ connected: boolean; account: string | null; accounts: string[]; last: OutlookSyncResult | null }>(
    { connected: false, account: null, accounts: [], last: null });

  const refresh = useCallback(async () => {
    const [gAccounts, at, dOn, dLast, oConnected, oAccount, oLast, oAccounts] = await Promise.all([
      GoogleService.listGoogleAccounts().catch((e) => { console.warn('[Calendars] accounts unreadable', e); return [] as GoogleAccount[]; }),
      lastSyncAt(),
      deviceCalendarsEnabled(),
      lastDeviceCalendarResult(),
      outlookConnected(),
      outlookAccount(),
      lastOutlookResult(),
      outlookAccounts().catch(() => [] as string[]),
    ]);
    setAccounts(gAccounts);
    setGErrors(calendarErrorsByAccount());
    setSyncedAt(at);
    setDeviceOn(dOn);
    setDevice(dLast);
    setOutlook({ connected: oConnected, account: oAccount, accounts: oAccounts, last: oLast });
    if (dOn) {
      const l = await listDeviceCalendars();
      setCals(l.calendars);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const syncAll = async (who: string) => {
    setBusy(who);
    try {
      const r = await syncCalendarNow(undefined, `menu:${who}`);
      await refresh();
      Alert.alert(T('Calendars synced', 'היומנים סונכרנו'), summarize(r, he));
    } catch (e) {
      Alert.alert(T('Sync failed', 'הסנכרון נכשל'), String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const onAddGoogle = async () => {
    // 5.10: connecting Google asks for Gmail + Calendar, which Google has not
    // verified for Meira yet. Phone calendars read every Google account's
    // calendar with no such screen; this is the deliberate, explained opt-in
    // for reading MAIL (and for a calendar the phone does not carry).
    const choice = await new Promise<'device' | 'google' | null>((resolve) => {
      Alert.alert(
        T('Add a Google account', 'הוספת חשבון Google'),
        T('Every Google account on this phone already reaches Meira through "Phone calendars" — no sign-in needed.\n\n'
          + (GMAIL_ENABLED
            ? 'Adding it here also lets Meira read that account\'s Gmail for events. Google will warn that Meira is not verified yet, '
              + 'and a work account may be blocked by its company.'
            : 'Adding it here reads that account\'s calendar directly (Gmail is not read in this version). '
              + 'A work account may be blocked by its company.'),
        'כל חשבון Google שמחובר לטלפון כבר מגיע למאירה דרך "יומני הטלפון" — בלי התחברות.\n\n'
          + (GMAIL_ENABLED
            ? 'הוספה כאן מאפשרת למאירה גם לקרוא את ה-Gmail של החשבון ולמצוא בו אירועים. גוגל תזהיר שמאירה עוד לא מאומתת, '
              + 'וחשבון עבודה עלול להיחסם על ידי החברה.'
            : 'הוספה כאן קוראת את היומן של החשבון ישירות (Gmail לא נקרא בגרסה הזו). '
              + 'חשבון עבודה עלול להיחסם על ידי החברה.')),
        [
          { text: T('Use phone calendars', 'יומני הטלפון'), onPress: () => resolve('device') },
          { text: T('Add the account', 'להוסיף את החשבון'), onPress: () => resolve('google') },
          { text: T('Cancel', 'ביטול'), style: 'cancel', onPress: () => resolve(null) },
        ],
        { cancelable: true, onDismiss: () => resolve(null) },
      );
    });
    if (choice === 'device') { await onDevice(); return; }
    if (choice !== 'google') return;
    setBusy('google');
    const ok = await GoogleService.signInWithGoogle();
    setBusy(null);
    if (!ok) {
      const why = GoogleService.lastSignInError();
      Alert.alert('Google', why === 'admin_blocked'
        ? T('This account\'s company blocks apps Google has not verified. Its calendar still reaches Meira through "Phone calendars" if the account is on this phone; its mail I cannot read.',
          'החברה של החשבון הזה חוסמת אפליקציות שגוגל לא אימתה. היומן שלו עדיין מגיע למאירה דרך "יומני הטלפון" אם החשבון מחובר לטלפון; את המייל שלו אין לי איך לקרוא.')
        : T(`Sign-in did not finish (${why || 'cancelled'}). Nothing was connected.`, `ההתחברות לא הושלמה (${why || 'בוטלה'}). שום דבר לא חובר.`));
      await refresh();
      return;
    }
    await syncAll('google');
  };

  const onAccount = (a: GoogleAccount) => {
    const name = a.email || T('this account', 'החשבון הזה');
    Alert.alert(name, T('Sync now, sign in again, or disconnect it from Meira.', 'לסנכרן עכשיו, להתחבר מחדש, או לנתק אותו ממאירה.'), [
      { text: T('Sync now', 'לסנכרן עכשיו'), onPress: () => syncAll('google') },
      { text: T('Sign in again', 'להתחבר מחדש'), onPress: async () => {
        setBusy('google');
        const ok = await GoogleService.signInWithGoogle();
        setBusy(null);
        if (ok) await syncAll('google'); else await refresh();
      } },
      { text: T('Disconnect', 'לנתק'), style: 'destructive', onPress: async () => {
        await GoogleService.disconnectGoogleAccount(a.email);
        await refresh();
      } },
      { text: T('Close', 'סגירה'), style: 'cancel' },
    ]);
  };

  const setUse = async (a: GoogleAccount, use: { calendar?: boolean; mail?: boolean }) => {
    await GoogleService.setGoogleAccountUse(a.email, use);
    await refresh();
  };

  const onDevice = async () => {
    if (!deviceOn) {
      setBusy('device');
      const r = await enableDeviceCalendars();
      setBusy(null);
      if (!r.ok) { Alert.alert(T('Phone calendars', 'יומני הטלפון'), deviceFailureText(r.error, he)); await refresh(); return; }
      await syncAll('device');
      setShowCals(true);
      return;
    }
    setShowCals((v) => !v);
  };

  const addOutlook = async () => {
    if (!outlookConfigured()) {
      Alert.alert('Outlook · Teams', T('This build has no Microsoft app id yet (EXPO_PUBLIC_MS_CLIENT_ID).\n\n'
        + 'Meanwhile, "Phone calendars" already reads Outlook if the Outlook app is on this phone.',
      'בגרסה הזאת עוד אין מזהה אפליקציה של מיקרוסופט.\n\nבינתיים "יומני הטלפון" כבר קוראים את Outlook אם אפליקציית Outlook מותקנת בטלפון.'));
      return;
    }
    setBusy('outlook');
    const r = await signInWithMicrosoft();
    setBusy(null);
    if (!r.ok) { Alert.alert('Outlook · Teams', outlookFailureText(r.error, he)); await refresh(); return; }
    await syncAll('outlook');
  };

  const onOutlookAccount = (account: string) => {
    Alert.alert(account || 'Outlook', T('Sync now, sign in again, or disconnect it from Meira.', 'לסנכרן עכשיו, להתחבר מחדש, או לנתק אותו ממאירה.'), [
      { text: T('Sync now', 'לסנכרן עכשיו'), onPress: () => syncAll('outlook') },
      { text: T('Disconnect', 'לנתק'), style: 'destructive', onPress: async () => { await signOutMicrosoft(account); await refresh(); } },
      { text: T('Close', 'סגירה'), style: 'cancel' },
    ]);
  };

  const deviceStatus = !deviceOn
    ? T('Off — every account on this phone: private and work Gmail, Outlook app, Samsung', 'כבוי — כל החשבונות בטלפון: Gmail פרטי ועבודה, Outlook, סמסונג')
    : device?.ok
      ? T(`On ✓ · ${device.calendarsRead} calendar(s) · ${device.events} event(s) · ${clock(device.at)}`,
        `פעיל ✓ · ${device.calendarsRead} יומנים · ${device.events} אירועים · ${clock(device.at)}`)
      : device?.error ? deviceFailureText(device.error, he) : T('On — not synced yet', 'פעיל — עוד לא סונכרן');

  const outlookStatus = !outlookConfigured()
    ? T('Not set up in this build', 'לא מוגדר בגרסה הזאת')
    : !outlook.connected
      ? T('Not connected — add an account below', 'לא מחובר — אפשר להוסיף חשבון למטה')
      : outlook.last?.error
        ? outlookFailureText(outlook.last.error, he)
        : `${outlook.account || T('Connected', 'מחובר')} ✓${outlook.last ? ` · ${outlook.last.events} ${T('event(s)', 'אירועים')} · ${clock(outlook.last.at)}` : ''}`;

  const failed = (s: string) => /refused|off in|could not|signed us out|access is off|סירבה|כבוי ב-|לא נקרא|ניתקה|הגישה/i.test(s);

  // Which phone accounts have calendars on this phone — so the list can say
  // "work@… is already read through the phone" without any sign-in.
  const phoneAccounts = [...new Set(cals.filter((c) => c.accountType === 'com.google').map((c) => c.account))];

  return (
    <View>
      {/* Phone calendars first: they include every Google account's calendar
          with no unverified-app screen (5.10). */}
      <Row icon="📱" title={T('Phone calendars', 'יומני הטלפון')} status={deviceStatus} bad={failed(deviceStatus)}
        busy={busy === 'device'} onPress={onDevice} chevron={deviceOn ? (showCals ? '⌄' : '›') : '›'} />
      {deviceOn && showCals && (
        <View style={styles.calList}>
          {cals.map((c) => (
            <View key={c.id} style={styles.calRow}>
              <View style={[styles.dot, { backgroundColor: c.color || BRAND.line }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.calTitle} numberOfLines={1}>{c.title}</Text>
                {c.googleUnsure ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={async () => { await GoogleService.identifyGoogleAccount(true); await refresh(); }}>
                    <Text style={[styles.calSub, styles.calSubWarn]} numberOfLines={2}>
                      {T(`${c.account} · can't tell which Google account is connected — tap to check`,
                        `${c.account} · לא ברור איזה חשבון Google מחובר — לחצי לבדיקה`)}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.calSub} numberOfLines={1}>
                    {c.readByGoogle ? T(`${c.account} · read through Google below`, `${c.account} · נקרא דרך Google למטה`) : c.account}
                  </Text>
                )}
              </View>
              <Switch
                value={c.included}
                disabled={c.readByGoogle}
                onValueChange={async (v) => {
                  await setDeviceCalendarIncluded(c.id, v);
                  setCals((xs) => xs.map((x) => (x.id === c.id ? { ...x, included: v } : x)));
                }}
                trackColor={{ false: BRAND.line, true: BRAND.amber }}
                thumbColor={c.included ? BRAND.sunGold : BRAND.inkSoft}
              />
            </View>
          ))}
          <View style={styles.calActions}>
            <TouchableOpacity onPress={() => syncAll('device')}><Text style={styles.link}>{T('Sync now', 'לסנכרן עכשיו')}</Text></TouchableOpacity>
            <TouchableOpacity onPress={async () => { await disableDeviceCalendars(); setShowCals(false); await refresh(); }}>
              <Text style={[styles.link, { color: BRAND.inkSoft }]}>{T('Turn off', 'לכבות')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.groupHead}>
        <Text style={styles.title}>{T('📅 Google accounts', '📅 חשבונות Google')}</Text>
        <Text style={styles.status}>
          {accounts.length
            ? T(`${accounts.length} connected${syncedAt ? ` · synced ${clock(syncedAt)}` : ''}`, `${accounts.length} מחוברים${syncedAt ? ` · סונכרן ${clock(syncedAt)}` : ''}`)
            : T('None — phone calendars already read them', 'אין — יומני הטלפון כבר קוראים אותם')}
        </Text>
      </View>
      {accounts.map((a) => {
        const err = gErrors[a.email];
        return (
          <View key={a.key} style={styles.account}>
            <TouchableOpacity onPress={() => onAccount(a)} accessibilityRole="button" style={{ flex: 1 }}>
              <Text style={styles.calTitle} numberOfLines={1}>{a.email || T('Account not identified yet', 'חשבון שעוד לא זוהה')}</Text>
              <Text style={[styles.calSub, err && { color: BRAND.danger }]} numberOfLines={2}>
                {err ? googleFailureText(err, he) : T('✓ connected · tap for more', '✓ מחובר · לחצי לעוד')}
              </Text>
            </TouchableOpacity>
            <View style={styles.useCol}>
              <Text style={styles.useLabel}>📅</Text>
              <Switch value={a.calendar} onValueChange={(v) => setUse(a, { calendar: v })}
                trackColor={{ false: BRAND.line, true: BRAND.amber }} thumbColor={a.calendar ? BRAND.sunGold : BRAND.inkSoft}
                accessibilityLabel={T(`Read ${a.email}'s calendar`, `לקרוא את היומן של ${a.email}`)} />
            </View>
            {GMAIL_ENABLED ? (
              <View style={styles.useCol}>
                <Text style={styles.useLabel}>✉️</Text>
                <Switch value={a.mail} onValueChange={(v) => setUse(a, { mail: v })}
                  trackColor={{ false: BRAND.line, true: BRAND.amber }} thumbColor={a.mail ? BRAND.sunGold : BRAND.inkSoft}
                  accessibilityLabel={T(`Read ${a.email}'s mail`, `לקרוא את המייל של ${a.email}`)} />
              </View>
            ) : (
              // A switch that reads nothing would be a fake switch; this says it is off, and why is on the Add dialog.
              <View style={styles.useCol}>
                <Text style={styles.useLabel}>✉️</Text>
                <Text style={styles.useLabel}>{gmailOffShort(he)}</Text>
              </View>
            )}
          </View>
        );
      })}
      {phoneAccounts.filter((p) => !accounts.some((a) => a.email.toLowerCase() === p.toLowerCase())).map((p) => (
        <Text key={p} style={[styles.calSub, styles.phoneNote]} numberOfLines={2}>
          {T(`${p} · its calendar comes through the phone`, `${p} · היומן שלו מגיע דרך הטלפון`)}
        </Text>
      ))}
      <TouchableOpacity style={styles.add} onPress={onAddGoogle} disabled={busy === 'google'} accessibilityRole="button">
        {busy === 'google' ? <ActivityIndicator color={BRAND.sunGold} />
          : <Text style={styles.link}>{T('+ Add Google account', '+ הוספת חשבון Google')}</Text>}
      </TouchableOpacity>

      <View style={styles.groupHead}>
        <Text style={styles.title}>🟦 Outlook · Teams</Text>
        <Text style={[styles.status, failed(outlookStatus) && { color: BRAND.danger }]} numberOfLines={2}>{outlookStatus}</Text>
      </View>
      {outlook.accounts.map((a) => (
        <TouchableOpacity key={a || 'unknown'} style={styles.account} onPress={() => onOutlookAccount(a)} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={styles.calTitle} numberOfLines={1}>{a || T('Account not identified yet', 'חשבון שעוד לא זוהה')}</Text>
            <Text style={styles.calSub}>{T('✓ connected · tap for more', '✓ מחובר · לחצי לעוד')}</Text>
          </View>
          <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={styles.add} onPress={addOutlook} disabled={busy === 'outlook'} accessibilityRole="button">
        {busy === 'outlook' ? <ActivityIndicator color={BRAND.sunGold} />
          : <Text style={styles.link}>{T('+ Add Outlook account', '+ הוספת חשבון Outlook')}</Text>}
      </TouchableOpacity>
    </View>
  );
}

function Row({ icon, title, status, bad, busy, onPress, chevron = '›' }: {
  icon: string; title: string; status: string; bad?: boolean; busy?: boolean; onPress: () => void; chevron?: string;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7} disabled={busy}>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{icon} {title}</Text>
        <Text style={[styles.status, bad && { color: BRAND.danger }]} numberOfLines={2}>{status}</Text>
      </View>
      {busy ? <ActivityIndicator color={BRAND.sunGold} /> : <Text style={styles.arrow}>{chevron}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: BRAND.line,
  },
  title: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  status: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft, marginTop: 2 },
  arrow: { fontSize: 20, color: BRAND.inkSoft, marginLeft: 8 },
  calList: { paddingLeft: 12, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  calRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  calTitle: { fontSize: 13, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  calSubWarn: { color: BRAND.goldInk },
  calSub: { fontSize: 11, fontFamily: FONTS.body, color: BRAND.inkSoft },
  calActions: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  link: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.goldInk },
  groupHead: { paddingTop: 14, paddingBottom: 6 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingLeft: 12, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  useCol: { alignItems: 'center' },
  useLabel: { fontSize: 12 },
  phoneNote: { paddingLeft: 12, paddingVertical: 4 },
  add: { paddingVertical: 12, paddingLeft: 12, borderBottomWidth: 1, borderBottomColor: BRAND.line },
});
