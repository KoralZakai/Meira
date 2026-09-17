/**
 * ProfileEditScreen — edit profile fields; registers the Expo push token with
 * the backend when a WhatsApp phone is saved (so server reminders reach the phone).
 * Also: Google connect, Goals entry, hobbies/routines, and system alarm-clock card.
 * Dependencies: UserProfileStorage, PushService (registerPush), TaskStorage,
 * GoogleService, AlarmService.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, Switch, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, LEVELS, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import {
  getSettings, loadStats, saveSettings, saveSettingsChecked, getTasksForDate,
} from '../services/TaskStorage';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import { searchPlaces } from '../services/RoutePlanner';
import { getCurrentLocationDetails } from '../services/NearbyTaskReminderService';
import { registerPush, verifyPhoneLink } from '../services/PushService';
import { deleteAccountEverywhere, describeOutcome } from '../services/AccountDeletion';
import {
  signInWithGoogle, getVerifiedUser, signOut as supabaseSignOut, lastAuthStage,
} from '../services/SupabaseAuthService';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { GoogleService } from '../services/GoogleService';
import { syncCalendarToday, calendarDiagnostics } from '../services/GoogleSync';
import { setSystemAlarm } from '../services/AlarmService';
import { getTomorrowString } from '../utils/timeUtils';
import { AppSettings, TimeSetting, AppLanguage } from '../types/models';
import { UserStats } from '../types';
import { UserProfile, TransportMode, blankProfile } from '../models/UserProfile';

/** HH:MM minus N minutes, wrapping at midnight (for the wake-time fallback). */
function hhmmMinus(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fmtTime(t: TimeSetting) {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function shiftTime(t: TimeSetting, delta: number): TimeSetting {
  const total = (t.hour * 60 + t.minute + delta + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function TimeRow({ label, value, onChange }: { label: string; value: TimeSetting; onChange: (t: TimeSetting) => void }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.timeControl}>
        <TouchableOpacity style={styles.stepBtn} onPress={() => onChange(shiftTime(value, -15))}>
          <Text style={styles.stepBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.timeVal}>{fmtTime(value)}</Text>
        <TouchableOpacity style={styles.stepBtn} onPress={() => onChange(shiftTime(value, 15))}>
          <Text style={styles.stepBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ProfileEditScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);

  useFocusEffect(useCallback(() => {
    Promise.all([getSettings(), loadProfile(), loadStats()]).then(([s, p, st]) => {
      setSettings(s);
      setProfile(p);
      setStats(st);
    });
  }, []));

  const patchSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  };

  const setLanguage = (lang: AppLanguage) => patchSettings({ language: lang });

  const [phone, setPhone] = useState('');
  const [linking, setLinking] = useState(false);
  useEffect(() => { if (settings?.whatsAppPhone) setPhone(settings.whatsAppPhone); }, [settings?.whatsAppPhone]);

  // ── Calendar diagnostics ──
  const [cal, setCal] = useState<{
    connected: boolean; eventsFound: number; daysScanned: number; imported: number;
  } | null>(null);
  const [calChecking, setCalChecking] = useState(false);

  const runCalendarCheck = async () => {
    setCalChecking(true);
    try {
      // Force past the 30-minute throttle: this tap means "look now".
      const added = await syncCalendarToday(settings?.language ?? 'en', true).catch(() => 0);
      const result = await calendarDiagnostics();
      setCal(result);
      Alert.alert(
        'Calendar',
        !result.connected
          ? 'Not connected. Tap 🔗 Google below to connect.'
          : `${result.eventsFound} event(s) found in the next ${result.daysScanned} days.\n`
            + `${result.imported} already imported as tasks`
            + (added > 0 ? `, ${added} just added.` : '.')
            + (result.eventsFound === 0
              ? '\n\nNothing in your calendar for this window — check you added them to the same Google account.'
              : ''),
      );
    } finally {
      setCalChecking(false);
    }
  };

  const linkPhoneAlerts = async () => {
    const clean = phone.replace(/[^\d]/g, '');
    if (!clean) { Alert.alert('Phone alerts', 'Enter your WhatsApp number first (the one you message Lumi from).'); return; }
    setLinking(true);
    // Order matters: the number must reach Supabase FIRST — the server resolves
    // this phone to an account by reading app_settings."whatsAppPhone". Then the
    // push token, then confirm the link resolved and release anything queued.
    const next = { ...(settings as AppSettings), whatsAppPhone: clean };
    setSettings(next);
    const sync = await saveSettingsChecked(next);
    const ok = await registerPush(clean);
    const flushed = sync.cloudSynced ? await verifyPhoneLink(clean) : null;
    setLinking(false);

    // The number never reached the cloud — say WHY. This used to show a generic
    // "couldn't link yet" while the real error sat in a console nobody reads.
    if (!sync.cloudSynced) {
      Alert.alert(
        'Phone alerts',
        `Saved on this phone, but it didn't reach the cloud:\n\n${sync.reason}\n\n` +
        'The WhatsApp sync needs that, so tasks stay queued until it works.\n\n' +
        'Use ☁️ Cloud sync just above to sign in, then tap 🔗 Link again.',
      );
      return;
    }

    if (flushed === null) {
      Alert.alert(
        'Phone alerts',
        'Your number saved, but the server could not match it yet.\n\n' +
        "Make sure you've messaged Lumi on WhatsApp from this exact number, " +
        'then tap this again.',
      );
      return;
    }
    Alert.alert(
      'Phone alerts',
      `Linked ✓${ok ? ' Reminders will also ping this phone.' : ''}` +
      (flushed > 0 ? `\n\n${flushed} task${flushed === 1 ? '' : 's'} from WhatsApp just synced across.` : ''),
    );
  };

  const handleSignOut = () => {
    Alert.alert('Sign out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => navigation.navigate('Onboarding') },
    ]);
  };

  /**
   * "Delete my account" — irreversible, so it asks twice.
   *
   * The first prompt says what goes; the second is the one that acts, and it
   * is separate on purpose. This button sits directly under "Sign out" (where
   * people look for it), the two read almost the same at a glance, and only
   * one of them can be undone.
   */
  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete my account',
      'This permanently deletes your tasks, conversations, profile, goals and '
      + 'location history — on this phone and in the cloud. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => Alert.alert(
            'Are you sure?',
            'There is no way to get any of this back.',
            [
              { text: 'Keep my account', style: 'cancel' },
              {
                text: 'Delete everything',
                style: 'destructive',
                onPress: async () => {
                  const outcome = await deleteAccountEverywhere();
                  const { title, body } = describeOutcome(outcome, false);
                  Alert.alert(title, body, [{
                    text: 'OK',
                    onPress: () => {
                      // Only leave the screen when there is nothing left to
                      // show. On a partial or failed delete she stays here, so
                      // she can retry rather than be dropped into onboarding
                      // with her data still in the cloud.
                      if (outcome.status === 'deleted') navigation.navigate('Onboarding');
                    },
                  }]);
                },
              },
            ],
          ),
        },
      ],
    );
  };

  // ── Cloud account ──
  // Linking the phone fails with "not signed in", and until now there was no
  // way to act on that from this screen — the only sign-in entry point was a
  // banner on Today. Put the fix next to the failure.
  const [cloudId, setCloudId] = useState<string | null>(null);
  const [cloudEmail, setCloudEmail] = useState<string | undefined>();
  const [signingIn, setSigningIn] = useState(false);
  useFocusEffect(useCallback(() => {
    // Verified against the server, not read from the cache — see getVerifiedUser.
    getVerifiedUser().then((u) => { setCloudId(u?.id ?? null); setCloudEmail(u?.email); })
      .catch(() => setCloudId(null));
  }, []));

  // Signed in but nothing syncing? Let her drop the session and start over,
  // instead of being stuck behind a tick she cannot press.
  const switchAccount = () => {
    Alert.alert(
      'Cloud sync',
      `Signed in as ${cloudEmail || 'this account'}.`,
      [
        { text: 'Close', style: 'cancel' },
        {
          text: 'Sign out & sign in again',
          onPress: async () => {
            await supabaseSignOut().catch(() => {});
            setCloudId(null); setCloudEmail(undefined);
            signIn();
          },
        },
      ],
    );
  };

  const signIn = async () => {
    if (signingIn) return;
    if (!isSupabaseConfigured) {
      Alert.alert(
        'Cloud account',
        'This build shipped without the cloud settings, so it cannot sign in at all. '
        + 'It needs rebuilding with npm run android:local.',
      );
      return;
    }
    setSigningIn(true);
    try {
      const session = await signInWithGoogle();
      if (session) {
        setCloudId(session.user?.id ?? null);
        setCloudEmail(session.user?.email ?? undefined);
        return;
      }
      // signInWithGoogle returns null when the browser closed without landing
      // on lumi://auth/callback. That reads to the user as "I tapped it and
      // nothing happened" — the tap was silently doing nothing at all. The
      // overwhelmingly common cause is Supabase refusing the redirect because
      // the scheme is not in its allow-list, in which case it sends the user to
      // the Site URL instead and the app never sees a code.
      // Report the last step reached. Without this the button just went quiet,
      // and three separate guesses at the cause were all wrong.
      Alert.alert(
        'Cloud account',
        `Sign-in did not complete.\n\nLast step: ${lastAuthStage}\n\n`
        + 'If you cancelled the window, tap again. Otherwise send this line to Claude.',
      );
    } catch (err: any) {
      Alert.alert(
        'Cloud account',
        `${err?.message || String(err)}\n\nLast step: ${lastAuthStage}`,
      );
    } finally {
      // Always clears, so a failure can never leave the row stuck on
      // "Signing in…" — which is itself indistinguishable from "nothing
      // happened", because the row is disabled while it is true.
      setSigningIn(false);
    }
  };

  // ── Google account (Calendar + Gmail intake) ──
  const [googleConnected, setGoogleConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  useFocusEffect(useCallback(() => {
    GoogleService.isGoogleConnected().then(setGoogleConnected).catch(() => {});
  }, []));

  const connectGoogle = async () => {
    if (connecting) return;
    setConnecting(true);
    const ok = await GoogleService.signInWithGoogle();
    setConnecting(false);
    setGoogleConnected(ok);
    if (ok) {
      Alert.alert('Google', 'Connected! Calendar events and event emails will show up on your Today screen. ✓');
    } else {
      Alert.alert(
        'Google',
        "Couldn't connect. Google sign-in needs the installed (EAS) app — and the OAuth client must be configured for this build.",
      );
    }
  };

  // ── Hobbies / routines (free text, saved on blur) ──
  const [hobbies, setHobbies] = useState('');
  const [routinesNotes, setRoutinesNotes] = useState('');
  useEffect(() => {
    if (profile) {
      setHobbies(profile.hobbies ?? '');
      setRoutinesNotes(profile.routinesNotes ?? '');
    }
  }, [profile?.lastUpdated]);

  // Falls back to a blank profile instead of returning: loadProfile() is null
  // until onboarding completes, and this screen is exactly where someone who
  // skipped onboarding comes to set their home address. It used to no-op.
  const saveProfileText = async (patch: Partial<UserProfile>) => {
    const base = profile ?? blankProfile();
    const next = { ...base, ...patch, lastUpdated: new Date().toISOString() };
    setProfile(next);
    await saveProfile(next);
  };

  // ── Home address ──
  // Without it RoutePlanner has no origin, so no wake time, no leave time and
  // no route can be computed at all — and nothing in the UI ever said so.
  const [homeQuery, setHomeQuery] = useState('');
  const [homeHits, setHomeHits] = useState<{ name: string; address: string; lat: number; lng: number }[]>([]);
  const [homeBusy, setHomeBusy] = useState(false);
  useEffect(() => { if (profile?.homeAddress) setHomeQuery(profile.homeAddress); }, [profile?.homeAddress]);

  const runHomeSearch = async () => {
    const q = homeQuery.trim();
    if (!q || homeBusy) return;
    setHomeBusy(true);
    try {
      const hits = await searchPlaces(q);
      setHomeHits(hits.slice(0, 4));
      if (!hits.length) {
        Alert.alert('Home address', `No place matched "${q}". Try adding the city, or tap 📍 to use where you are now.`);
      }
    } finally {
      setHomeBusy(false);
    }
  };

  // Store the coordinates too — geocoding on every route lookup is slow, and
  // saveProfile only geocodes when homeLatLng is absent.
  const pickHome = async (hit: { address: string; lat: number; lng: number }) => {
    setHomeHits([]);
    setHomeQuery(hit.address);
    await saveProfileText({ homeAddress: hit.address, homeLatLng: { lat: hit.lat, lng: hit.lng } });
  };

  const useCurrentAsHome = async () => {
    if (homeBusy) return;
    setHomeBusy(true);
    try {
      const here = await getCurrentLocationDetails();
      if (!here) {
        Alert.alert('Home address', 'Could not read your location — allow location access and try again.');
        return;
      }
      setHomeHits([]);
      setHomeQuery(here.label);
      await saveProfileText({ homeAddress: here.label, homeLatLng: { lat: here.lat, lng: here.lng } });
    } finally {
      setHomeBusy(false);
    }
  };

  // ── System alarm clock (real Android Clock-app alarm) ──
  const [alarmTime, setAlarmTime] = useState<TimeSetting>({ hour: 7, minute: 0 });

  const alarmLimitationAlert = () =>
    Alert.alert(
      '⏰ Alarm',
      "System alarms need the installed (EAS) app on Android, and can only be set up to 24h ahead — try again this evening.",
    );

  const setManualAlarm = async () => {
    const hhmm = fmtTime(alarmTime);
    const ok = await setSystemAlarm(hhmm, 'Lumi wake-up ☀️');
    ok ? Alert.alert('⏰ Alarm', `System alarm set for ${hhmm} ✓ (check your Clock app)`) : alarmLimitationAlert();
  };

  const setAlarmForTomorrowsFirstTask = async () => {
    const tomorrow = getTomorrowString();
    const tasks = (await getTasksForDate(tomorrow)).filter((t: any) => t.fixedTime && t.status !== 'complete');
    if (tasks.length === 0) {
      Alert.alert('⏰ Alarm', 'No fixed-time tasks tomorrow yet — add one first.');
      return;
    }
    const first = tasks.sort((a: any, b: any) => (a.fixedTime! < b.fixedTime! ? -1 : 1))[0];
    const loc = first.location && typeof first.location === 'object' ? first.location : undefined;
    // Prefer the computed wake time from the transit plan; else fixedTime − routine − 30m travel pad.
    const wake = loc?.wakeUpBy ?? hhmmMinus(first.fixedTime!, (profile?.totalMorningRoutineMinutes ?? 30) + 30);
    const ok = await setSystemAlarm(wake, `${first.text} @ ${first.fixedTime}`, tomorrow);
    ok
      ? Alert.alert('⏰ Alarm', `Alarm set for ${wake} — "${first.text}" at ${first.fixedTime} ✓`)
      : alarmLimitationAlert();
  };

  if (!settings) return <View style={[styles.root, { paddingTop: insets.top }]} />;

  const levelInfo = stats
    ? ([...LEVELS].reverse().find((l) => stats.totalPoints >= l.minPoints) ?? LEVELS[0])
    : LEVELS[0];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Avatar + name */}
        <View style={styles.profileHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{profile?.name?.[0]?.toUpperCase() ?? 'L'}</Text>
          </View>
          <Text style={styles.profileName}>{profile?.name ?? 'Lumi User'}</Text>
          <Text style={styles.profileLevel}>{levelInfo.titleEn}</Text>
        </View>

        {/* Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SETTINGS</Text>
          <View style={styles.card}>
            <TimeRow
              label="Wake time"
              value={settings.morningTime}
              onChange={(v) => patchSettings({ morningTime: v })}
            />
            <View style={styles.rowDiv} />
            <TimeRow
              label="Sleep time"
              value={settings.eveningTime}
              onChange={(v) => patchSettings({ eveningTime: v })}
            />
            <View style={styles.rowDiv} />

            {/* Language */}
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Language</Text>
              <View style={styles.pillRow}>
                {(['en', 'he'] as AppLanguage[]).map((lang) => (
                  <TouchableOpacity
                    key={lang}
                    style={[styles.pill, settings.language === lang && styles.pillActive]}
                    onPress={() => setLanguage(lang)}
                  >
                    <Text style={[styles.pillText, settings.language === lang && styles.pillTextActive]}>
                      {lang === 'en' ? 'EN' : 'HE'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.rowDiv} />

            {/* Cloud account — everything below depends on it */}
            {/* Only ever disabled WHILE signing in. Disabling it when signed in
                is what made a stale session unrecoverable: the tick said all was
                well and the tap did nothing. */}
            <TouchableOpacity style={styles.settingRow} onPress={cloudId ? switchAccount : signIn} disabled={signingIn}>
              <Text style={styles.settingLabel}>☁️ Cloud sync</Text>
              <Text
                style={[styles.settingLabel, cloudId ? { color: BRAND.sunGold } : { color: BRAND.danger }]}
                numberOfLines={1}
              >
                {signingIn ? 'Signing in…' : cloudId ? `${cloudEmail || 'Signed in'} ✓` : 'Not signed in — tap ›'}
              </Text>
            </TouchableOpacity>

            <View style={styles.rowDiv} />

            {/* WhatsApp phone alerts */}
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>WhatsApp #</Text>
              <TextInput
                style={styles.phoneInput}
                value={phone}
                onChangeText={setPhone}
                onBlur={() => patchSettings({ whatsAppPhone: phone.replace(/[^\d]/g, '') })}
                placeholder="9725XXXXXXXX"
                placeholderTextColor={BRAND.inkSoft}
                keyboardType="phone-pad"
              />
            </View>
            <TouchableOpacity style={styles.linkBtn} onPress={linkPhoneAlerts} disabled={linking}>
              <Text style={styles.linkBtnText}>{linking ? 'Linking…' : '🔔 Enable phone alerts'}</Text>
            </TouchableOpacity>

            <View style={styles.rowDiv} />

            {/* Calendar: connected / found / imported, and a forced sync.
                "I added events and don't see them" is impossible to diagnose
                from outside the app — not-connected, connected-but-empty, and
                imported-but-hidden all look the same. */}
            <TouchableOpacity style={styles.settingRow} onPress={runCalendarCheck} disabled={calChecking}>
              <Text style={styles.settingLabel}>📅 Calendar</Text>
              <Text style={styles.linkChevron}>
                {calChecking ? '…' : cal
                  ? (cal.connected
                    ? `${cal.eventsFound} events · ${cal.imported} imported`
                    : 'not connected')
                  : 'check ›'}
              </Text>
            </TouchableOpacity>

            <View style={styles.rowDiv} />

            {/* Points / level / category breakdown. Used to be the Stats
                tab; the tab now belongs to Trips, which answers a question
                the user actually has several times a day. */}
            <TouchableOpacity style={styles.settingRow} onPress={() => navigation.navigate('Analytics')}>
              <Text style={styles.settingLabel}>📊 Progress</Text>
              <Text style={styles.linkChevron}>›</Text>
            </TouchableOpacity>

            <View style={styles.rowDiv} />

            {/* Personality test */}
            <TouchableOpacity style={styles.settingRow} onPress={() => navigation.navigate('PersonalityQuiz')}>
              <Text style={styles.settingLabel}>🧭 Personality check</Text>
              <Text style={styles.linkChevron}>›</Text>
            </TouchableOpacity>

            <View style={styles.rowDiv} />

            {/* Google account — calendar events + event emails intake */}
            <TouchableOpacity style={styles.settingRow} onPress={connectGoogle} disabled={connecting}>
              <Text style={styles.settingLabel}>🔗 Google</Text>
              <Text style={[styles.settingLabel, googleConnected && { color: BRAND.sunGold }]}>
                {connecting ? 'Connecting…' : googleConnected ? 'Connected ✓' : 'Connect ›'}
              </Text>
            </TouchableOpacity>

            <View style={styles.rowDiv} />

            {/* Goals / wish list */}
            <TouchableOpacity style={styles.settingRow} onPress={() => navigation.navigate('Goals')}>
              <Text style={styles.settingLabel}>⭐ Goals & wish list</Text>
              <Text style={styles.linkChevron}>›</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Home & travel — the origin every route is planned backwards from */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>HOME & TRAVEL</Text>
          <View style={styles.card}>
            <View style={styles.textAreaRow}>
              <Text style={styles.settingLabel}>🏠 Home address</Text>
              <View style={styles.homeRow}>
                <TextInput
                  style={styles.homeInput}
                  value={homeQuery}
                  onChangeText={setHomeQuery}
                  onSubmitEditing={runHomeSearch}
                  returnKeyType="search"
                  placeholder="Street, city"
                  placeholderTextColor={BRAND.inkSoft}
                />
                <TouchableOpacity style={styles.homeBtn} onPress={runHomeSearch} disabled={homeBusy}>
                  <Text style={styles.homeBtnText}>{homeBusy ? '…' : '🔍'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.homeBtn} onPress={useCurrentAsHome} disabled={homeBusy}>
                  <Text style={styles.homeBtnText}>📍</Text>
                </TouchableOpacity>
              </View>
              {homeHits.map((hit) => (
                <TouchableOpacity key={hit.address} style={styles.homeHit} onPress={() => pickHome(hit)}>
                  <Text style={styles.homeHitName}>{hit.name}</Text>
                  <Text style={styles.homeHitAddr}>{hit.address}</Text>
                </TouchableOpacity>
              ))}
              {!profile?.homeAddress && !homeHits.length ? (
                <Text style={styles.homeWarn}>
                  Not set — Lumi cannot work out when to wake you or leave without it.
                </Text>
              ) : null}
            </View>

            <View style={styles.rowDiv} />

            {/* Transport — was only editable per-task, never as a default */}
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>🚌 Usual transport</Text>
              <View style={styles.pillRow}>
                {([
                  ['transit', '🚌'], ['car', '🚗'], ['bicycle', '🚴'], ['foot', '🚶'],
                ] as [TransportMode, string][]).map(([mode, icon]) => (
                  <TouchableOpacity
                    key={mode}
                    style={[styles.pill, profile?.transportMode === mode && styles.pillActive]}
                    onPress={() => saveProfileText({ transportMode: mode })}
                  >
                    <Text style={styles.pillText}>{icon}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </View>

        {/* About me — free-text context Lumi plans around */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ABOUT ME</Text>
          <View style={styles.card}>
            <View style={styles.textAreaRow}>
              <Text style={styles.settingLabel}>🎨 Hobbies</Text>
              <TextInput
                style={styles.textArea}
                value={hobbies}
                onChangeText={setHobbies}
                onBlur={() => saveProfileText({ hobbies })}
                placeholder="climbing, guitar, cooking…"
                placeholderTextColor={BRAND.inkSoft}
                multiline
              />
            </View>
            <View style={styles.rowDiv} />
            <View style={styles.textAreaRow}>
              <Text style={styles.settingLabel}>🔁 Routines</Text>
              <TextInput
                style={styles.textArea}
                value={routinesNotes}
                onChangeText={setRoutinesNotes}
                onBlur={() => saveProfileText({ routinesNotes })}
                placeholder="gym Mon/Wed 18:00, weekly review Sunday…"
                placeholderTextColor={BRAND.inkSoft}
                multiline
              />
            </View>
          </View>
        </View>

        {/* Alarm clock — real Android system alarm */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ALARM CLOCK</Text>
          <View style={styles.card}>
            <TimeRow label="⏰ Manual alarm" value={alarmTime} onChange={setAlarmTime} />
            <TouchableOpacity style={styles.linkBtn} onPress={setManualAlarm}>
              <Text style={styles.linkBtnText}>Set system alarm</Text>
            </TouchableOpacity>
            <View style={styles.rowDiv} />
            <TouchableOpacity style={styles.linkBtn} onPress={setAlarmForTomorrowsFirstTask}>
              <Text style={styles.linkBtnText}>⏰ Alarm for tomorrow's first task</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Sign out */}
        <TouchableOpacity onPress={handleSignOut} style={styles.signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>

        {/* Delete account — required by Google Play for any app with accounts,
            and promised by the privacy policy. Kept visually quiet and behind
            two confirmations: it is irreversible, and it sits one finger-width
            from "Sign out", which is not. */}
        <TouchableOpacity onPress={handleDeleteAccount} style={styles.deleteAccount}>
          <Text style={styles.deleteAccountText}>Delete my account</Text>
        </TouchableOpacity>

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  scroll: { padding: 16, gap: 20 },

  profileHeader: { alignItems: 'center', paddingVertical: 8, gap: 6 },
  avatar: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: BRAND.honey, alignItems: 'center', justifyContent: 'center',
    ...SHADOWS.card,
  },
  avatarText: { fontSize: 28, fontFamily: FONTS.display, color: BRAND.warmInk },
  profileName: { fontSize: 22, fontFamily: FONTS.display, color: BRAND.warmInk },
  profileLevel: { fontSize: 13, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },

  section: { gap: 8 },
  sectionLabel: { fontSize: 11, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft, letterSpacing: 0.5 },
  card: { backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card, ...SHADOWS.card, overflow: 'hidden' },

  settingRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  settingLabel: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  rowDiv: { height: 1, backgroundColor: BRAND.line, marginHorizontal: 16 },

  timeControl: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: BRAND.honey, alignItems: 'center', justifyContent: 'center',
  },
  stepBtnText: { fontSize: 18, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk, lineHeight: 22 },
  timeVal: { fontSize: 16, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk, minWidth: 48, textAlign: 'center' },

  pillRow: { flexDirection: 'row', gap: 6 },
  pill: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: RADIUS.pill, backgroundColor: BRAND.line,
  },
  pillActive: { backgroundColor: BRAND.sunGold },
  pillText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft },
  pillTextActive: { color: BRAND.creamCard },

  phoneInput: {
    minWidth: 150, textAlign: 'right',
    fontSize: 15, fontFamily: FONTS.bodySemi, color: BRAND.warmInk,
    paddingVertical: 0,
  },
  linkBtn: {
    marginHorizontal: 16, marginBottom: 14, paddingVertical: 10,
    borderRadius: RADIUS.pill, backgroundColor: BRAND.honey, alignItems: 'center',
  },
  linkBtnText: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  linkChevron: { fontSize: 20, color: BRAND.inkSoft, fontFamily: FONTS.bodyBold },

  signOut: { alignSelf: 'center', paddingVertical: 8 },
  signOutText: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },
  // Quieter than sign-out, not louder: a destructive action should be findable,
  // never inviting. The colour is the app's danger red, at small size.
  deleteAccount: { alignSelf: 'center', paddingVertical: 10, paddingBottom: 4 },
  deleteAccountText: { fontSize: 13, fontFamily: FONTS.body, color: BRAND.danger },

  textAreaRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  textArea: {
    fontSize: 14, fontFamily: FONTS.body, color: BRAND.warmInk,
    backgroundColor: BRAND.cream, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 12, paddingVertical: 8, minHeight: 60,
    textAlignVertical: 'top',
  },

  // ── Home address ──
  homeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  homeInput: {
    flex: 1,
    fontSize: 14, fontFamily: FONTS.body, color: BRAND.warmInk,
    backgroundColor: BRAND.cream, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  homeBtn: {
    width: 40, height: 38, borderRadius: RADIUS.chip,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: BRAND.cream, borderWidth: 1, borderColor: BRAND.line,
  },
  homeBtnText: { fontSize: 16 },
  homeHit: {
    backgroundColor: BRAND.cream, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  homeHitName: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  homeHitAddr: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft },
  homeWarn: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.danger },
});
