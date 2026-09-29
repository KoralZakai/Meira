/**
 * CalendarConnections — the Menu's "Calendars" section. Every row is real.
 *
 * It replaced three rows (Google Calendar, Gmail, Contacts) whose onPress was
 * `() => {}` — a button that cannot fail is rule 3's exact bug. Each row here
 * shows what is TRUE right now (connected to whom, how many events on the
 * last run, when, or the reason it read nothing) and a tap does the thing:
 * connect, or sync now and say what arrived.
 *
 *   📅 Google Calendar   — GoogleService + GoogleSync (API, primary calendar)
 *   📱 Phone calendars   — DeviceCalendarSync (Outlook app, Samsung, work, family)
 *   🟦 Outlook · Teams   — OutlookService (Microsoft Graph)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Switch } from 'react-native';

import { BRAND, FONTS } from '../constants/theme';
import { GoogleService } from '../services/GoogleService';
import { syncCalendarNow, lastSyncAt, type CalendarSyncResult } from '../services/CalendarAutoSync';
import { lastCalendarFailure } from '../services/GoogleSync';
import {
  deviceCalendarsEnabled, enableDeviceCalendars, disableDeviceCalendars, listDeviceCalendars,
  setDeviceCalendarIncluded, lastDeviceCalendarResult,
  type DeviceCalendarInfo, type DeviceCalendarResult, type DeviceCalendarFailure,
} from '../services/DeviceCalendarSync';
import {
  outlookConfigured, outlookConnected, outlookAccount, signInWithMicrosoft, signOutMicrosoft,
  lastOutlookResult, type OutlookSyncResult, type OutlookFailure,
} from '../services/OutlookService';

function clock(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // Rule 4: something from another day shows its day.
  return d.toDateString() === today.toDateString() ? hm : `${d.getDate()}.${d.getMonth() + 1} ${hm}`;
}

export function deviceFailureText(e?: DeviceCalendarFailure): string {
  if (!e) return '';
  if (e === 'off') return 'Off';
  if (e === 'permission_denied') return 'Calendar access is off — allow it in Android Settings → Apps → Meira';
  if (e === 'no_calendars') return 'No calendars on this phone';
  if (e === 'all_excluded') return 'Every calendar is switched off below';
  if (e === 'expo_go') return 'Needs the installed app, not Expo Go';
  return `Could not read: ${e.replace(/^read_failed: /, '')}`;
}

export function outlookFailureText(e?: OutlookFailure): string {
  if (!e) return '';
  if (e === 'not_configured') return 'Not set up in this build (no Microsoft app id)';
  if (e === 'not_connected') return 'Not connected';
  if (e === 'cancelled') return 'Sign-in was cancelled';
  if (e === 'reconnect') return 'Microsoft signed us out — tap to sign in again';
  return e;
}

function googleFailureText(e: string | null): string {
  if (!e) return '';
  if (e === 'not_connected') return 'Not connected — tap to connect';
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(e)) return 'Calendar API is off in Google Cloud';
  if (/http_401|http_403|invalid_grant/i.test(e)) return 'Google refused us — tap to sign in again';
  return e.slice(0, 80);
}

function summarize(r: CalendarSyncResult): string {
  const lines = [`${r.added} new or corrected event(s).`];
  if (r.error && r.error !== 'not_connected') lines.push(`Google: ${googleFailureText(r.error)}`);
  if (r.device && r.device.error !== 'off') {
    lines.push(r.device.ok
      ? `Phone calendars: ${r.device.events} event(s) in ${r.device.calendarsRead} calendar(s)`
      : `Phone calendars: ${deviceFailureText(r.device.error)}`);
  }
  if (r.outlook && r.outlook.error !== 'not_connected' && r.outlook.error !== 'not_configured') {
    lines.push(r.outlook.ok ? `Outlook: ${r.outlook.events} event(s)` : `Outlook: ${outlookFailureText(r.outlook.error)}`);
  }
  return lines.join('\n');
}

export default function CalendarConnections() {
  const [busy, setBusy] = useState<string | null>(null);
  const [google, setGoogle] = useState<{ connected: boolean; error: string | null; at: number }>({ connected: false, error: null, at: 0 });
  const [deviceOn, setDeviceOn] = useState(false);
  const [device, setDevice] = useState<DeviceCalendarResult | null>(null);
  const [cals, setCals] = useState<DeviceCalendarInfo[]>([]);
  const [showCals, setShowCals] = useState(false);
  const [outlook, setOutlook] = useState<{ connected: boolean; account: string | null; last: OutlookSyncResult | null }>(
    { connected: false, account: null, last: null });

  const refresh = useCallback(async () => {
    const [gConnected, at, dOn, dLast, oConnected, oAccount, oLast] = await Promise.all([
      GoogleService.isGoogleConnected().catch(() => false),
      lastSyncAt(),
      deviceCalendarsEnabled(),
      lastDeviceCalendarResult(),
      outlookConnected(),
      outlookAccount(),
      lastOutlookResult(),
    ]);
    setGoogle({ connected: gConnected, error: lastCalendarFailure(), at });
    setDeviceOn(dOn);
    setDevice(dLast);
    setOutlook({ connected: oConnected, account: oAccount, last: oLast });
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
      Alert.alert('Calendars synced', summarize(r));
    } catch (e) {
      Alert.alert('Sync failed', String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const onGoogle = async () => {
    if (!google.connected) {
      setBusy('google');
      const ok = await GoogleService.signInWithGoogle();
      setBusy(null);
      if (!ok) { Alert.alert('Google', 'Sign-in did not finish. Nothing was connected.'); return; }
    }
    await syncAll('google');
  };

  const onDevice = async () => {
    if (!deviceOn) {
      setBusy('device');
      const r = await enableDeviceCalendars();
      setBusy(null);
      if (!r.ok) { Alert.alert('Phone calendars', deviceFailureText(r.error)); await refresh(); return; }
      await syncAll('device');
      setShowCals(true);
      return;
    }
    setShowCals((v) => !v);
  };

  const onOutlook = async () => {
    if (!outlookConfigured()) {
      Alert.alert('Outlook · Teams', 'This build has no Microsoft app id yet (EXPO_PUBLIC_MS_CLIENT_ID).\n\n'
        + 'Meanwhile, "Phone calendars" already reads Outlook if the Outlook app is on this phone.');
      return;
    }
    if (!outlook.connected || outlook.last?.error === 'reconnect') {
      setBusy('outlook');
      const r = await signInWithMicrosoft();
      setBusy(null);
      if (!r.ok) { Alert.alert('Outlook · Teams', outlookFailureText(r.error)); return; }
      await syncAll('outlook');
      return;
    }
    Alert.alert('Outlook · Teams', outlook.account || 'Connected', [
      { text: 'Sync now', onPress: () => syncAll('outlook') },
      { text: 'Disconnect', style: 'destructive', onPress: async () => { await signOutMicrosoft(); await refresh(); } },
      { text: 'Close', style: 'cancel' },
    ]);
  };

  const googleStatus = !google.connected
    ? 'Not connected — tap to connect'
    : google.error && google.error !== 'not_connected'
      ? googleFailureText(google.error)
      : `Connected ✓${google.at ? ` · synced ${clock(google.at)}` : ''}`;

  const deviceStatus = !deviceOn
    ? 'Off — Outlook app, Samsung, work, family'
    : device?.ok
      ? `On ✓ · ${device.calendarsRead} calendar(s) · ${device.events} event(s) · ${clock(device.at)}`
      : device?.error ? deviceFailureText(device.error) : 'On — not synced yet';

  const outlookStatus = !outlookConfigured()
    ? 'Not set up in this build'
    : !outlook.connected
      ? 'Not connected — tap to sign in'
      : outlook.last?.error
        ? outlookFailureText(outlook.last.error)
        : `${outlook.account || 'Connected'} ✓${outlook.last ? ` · ${outlook.last.events} event(s) · ${clock(outlook.last.at)}` : ''}`;

  const failed = (s: string) => /refused|off in|could not|signed us out|access is off/i.test(s);

  return (
    <View>
      <Row icon="📅" title="Google Calendar" status={googleStatus} bad={failed(googleStatus)}
        busy={busy === 'google'} onPress={onGoogle} />
      <Row icon="📱" title="Phone calendars" status={deviceStatus} bad={failed(deviceStatus)}
        busy={busy === 'device'} onPress={onDevice} chevron={deviceOn ? (showCals ? '⌄' : '›') : '›'} />
      {deviceOn && showCals && (
        <View style={styles.calList}>
          {cals.map((c) => (
            <View key={c.id} style={styles.calRow}>
              <View style={[styles.dot, { backgroundColor: c.color || BRAND.line }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.calTitle} numberOfLines={1}>{c.title}</Text>
                <Text style={styles.calSub} numberOfLines={1}>
                  {c.readByGoogle ? `${c.account} · read through Google above` : c.account}
                </Text>
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
            <TouchableOpacity onPress={() => syncAll('device')}><Text style={styles.link}>Sync now</Text></TouchableOpacity>
            <TouchableOpacity onPress={async () => { await disableDeviceCalendars(); setShowCals(false); await refresh(); }}>
              <Text style={[styles.link, { color: BRAND.inkSoft }]}>Turn off</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      <Row icon="🟦" title="Outlook · Teams" status={outlookStatus} bad={failed(outlookStatus)}
        busy={busy === 'outlook'} onPress={onOutlook} />
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
  calSub: { fontSize: 11, fontFamily: FONTS.body, color: BRAND.inkSoft },
  calActions: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  link: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.goldInk },
});
