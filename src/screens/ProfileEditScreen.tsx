/**
 * ProfileEditScreen — edit profile fields; registers the Expo push token with
 * the backend when a WhatsApp phone is saved (so server reminders reach the phone).
 * Also: Google connect, Goals entry, hobbies/routines, and system alarm-clock card.
 * Dependencies: UserProfileStorage, PushService (registerPush), TaskStorage,
 * GoogleService, AlarmService.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, Switch, Alert, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, LEVELS, FONTS, RADIUS, SHADOWS, surf, nline } from '../constants/theme';
import {
  getSettings, loadStats, saveSettings, saveSettingsChecked, getTasksForDate,
} from '../services/TaskStorage';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import { invalidateRoutines } from '../services/GapFillService';
import * as Questions from '../services/QuestionService';
import { searchPlaces } from '../services/RoutePlanner';
import { getCurrentLocationDetails } from '../services/NearbyTaskReminderService';
import { registerPush, verifyPhoneLink } from '../services/PushService';
import { linkStart, linkStatus } from '../services/LumiServer';
import { deleteAccountEverywhere, describeOutcome } from '../services/AccountDeletion';
import {
  signInWithGoogle, getVerifiedUser, signOut as supabaseSignOut, lastAuthStage,
} from '../services/SupabaseAuthService';
import { wipeDevice } from '../services/LocalWipe';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { GoogleService } from '../services/GoogleService';
import {
  syncCalendarToday, calendarDiagnostics, lastCalendarReconcile,
} from '../services/GoogleSync';
import { clearDismissedExternalIds } from '../services/TaskStorage';
import {
  backgroundSyncRegistered, registerBackgroundCalendarSync, lastSyncAt,
} from '../services/CalendarAutoSync';
import { setSystemAlarm } from '../services/AlarmService';
import { rescheduleDailyNotifications } from '../services/NotificationService';
import CalendarConnections from '../components/CalendarConnections';
import AiAssistants from '../components/AiAssistants';
import FocusSessionSheet from '../components/FocusSessionSheet';
import RoutineList from '../components/you/RoutineList';
import LearnedRules from '../components/you/LearnedRules';
import WhatMeiraKnows from '../components/you/WhatMeiraKnows';
import NearbyNudgesCard from '../components/you/NearbyNudgesCard';
import SkyBackdrop, { useSky } from '../components/ui/SkyBackdrop';
import { profileFacts } from '../utils/profileFacts';
import { getTomorrowString } from '../utils/timeUtils';
import { AppSettings, TimeSetting, AppLanguage } from '../types/models';
import { UserStats } from '../types';
import { UserProfile, TransportMode, blankProfile } from '../models/UserProfile';
import { DEFAULT_EARLIEST_WAKE } from '../utils/dayFeasibility';
import { nudgeLevelOf } from '../utils/nudgeLevel';
import NudgeSlider from '../components/NudgeSlider';

/** HH:MM minus N minutes, wrapping at midnight (for the wake-time fallback). */
function hhmmMinus(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fmtTime(t: TimeSetting) {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function parseHHMM(hhmm: string): TimeSetting {
  const [h, m] = hhmm.split(':').map(Number);
  return { hour: Number.isFinite(h) ? h : 5, minute: Number.isFinite(m) ? m : 0 };
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

export type ProfileSection = 'you' | 'alerts' | 'calendars' | 'helpers' | 'account';

export default function ProfileEditScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const sky = useSky();
  // One screen, five pages, opened from the Menu's doors (6.10): every setting
  // is drawn on exactly ONE of them — "nothing appears twice".
  const section: ProfileSection = route?.params?.section ?? 'you';
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  // The learning-session chooser (17.10): blocked apps, permissions, start.
  const [focusOpen, setFocusOpen] = useState(false);

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
    // A check-in hour moved: reschedule now, not at the next launch.
    if ('morningTime' in patch || 'afternoonTime' in patch || 'eveningTime' in patch) {
      rescheduleDailyNotifications(next).catch((e) => console.warn('[Alerts] check-ins not rescheduled', e));
    }
  };

  // Language is chosen in the Menu only (6.10: nothing appears twice).

  const [phone, setPhone] = useState('');
  const [linking, setLinking] = useState(false);
  // What the SERVER says is linked — proved by a WhatsApp message, never the
  // number typed into settings (7.10). undefined = not asked yet; null = no link.
  const [linkedPhone, setLinkedPhone] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    linkStatus().then((st) => setLinkedPhone(st ? (st.linked ? st.phone ?? '' : null) : undefined))
      .catch(() => setLinkedPhone(undefined));
  }, []);
  useEffect(() => { if (settings?.whatsAppPhone) setPhone(settings.whatsAppPhone); }, [settings?.whatsAppPhone]);

  // ── Calendar diagnostics ──
  const [cal, setCal] = useState<{
    connected: boolean; eventsFound: number; daysScanned: number; imported: number;
    error: string | null; withoutLocation: number;
    blockedByDismiss: number; blockedTitles: string[];
  } | null>(null);
  const [calChecking, setCalChecking] = useState(false);

  const runCalendarCheck = async () => {
    setCalChecking(true);
    try {
      // Force past the 30-minute throttle: this tap means "look now".
      const added = await syncCalendarToday(settings?.language ?? 'en', true).catch(() => 0);
      const result = await calendarDiagnostics();
      setCal(result);
      // The check has to be able to say "Google refused us", not only "0 found".
      // An expired grant, a scope the token never had and a genuinely empty
      // fortnight all used to print the same reassuring sentence — which is
      // how an interview sat on the calendar, unimported, for four days.
      // Which fix, in words, decided by USING the grant — not by the presence
      // of a token in SecureStore, which is what "✓ connected" used to mean.
      // "Sign in again" and "enable the Calendar API in Google Cloud" are
      // different evenings; printing both and letting her guess is rule 3 by
      // half measures.
      const verdict = result.error
        ? await GoogleService.verifyGoogleConnection().catch(() => null)
        : null;
      const fixLine = verdict?.fix === 'enable_api'
        ? 'This is the Google Cloud project, NOT this phone: the Calendar API '
          + 'is switched off for the project this app signs in with. Signing in '
          + 'again will not help.'
        : 'Tap 🔗 Google below and sign in again — the stored grant has expired '
          + 'or been revoked.';

      let body = !result.connected
        ? 'Not connected. Tap 🔗 Google below to connect.'
        : result.error
          ? `Google refused the request:\n\n${result.error}\n\n`
            + `Nothing can be imported until that is fixed.\n\n${fixLine}`
          : `${result.eventsFound} event(s) found in the next ${result.daysScanned} days.\n`
            + `${result.imported} already imported as tasks`
            + (added > 0 ? `, ${added} just added.` : '.')
            + (result.withoutLocation > 0
              ? `\n\n${result.withoutLocation} of them have no address on the event, `
                + 'so there is nothing to plan a route to.'
              : '')
            + (result.eventsFound === 0
              ? '\n\nGoogle answered, and this account has nothing booked in that window '
                + '— check the event is on the same Google account you connected here.'
              : '');

      // Whether the automatic pull is ACTUALLY running, asked of Android, not
      // assumed. "Background sync is on" is exactly the sort of claim this app
      // has shipped as a lie before; if WorkManager never took the job, or the
      // OS restricted us, this says so and says which.
      let bgOn = await backgroundSyncRegistered().catch(() => false);
      let bgReason = '';
      if (!bgOn) {
        // Try once, here, and keep the REASON. A failed registration that only
        // ever appeared in a console she cannot open is not a report.
        const r = await registerBackgroundCalendarSync();
        bgOn = r.ok;
        if (!r.ok) {
          bgReason = r.reason === 'expo_go'
            ? ' (Expo Go cannot run background jobs — needs the installed APK.)'
            : r.reason === 'restricted_by_os'
              ? " (Android has restricted this app's background work — check "
                + 'Battery settings for Meira.)'
              : ` (${r.reason})`;
        }
      }
      const last = await lastSyncAt().catch(() => 0);
      const ago = last
        ? `${Math.max(0, Math.round((Date.now() - last) / 60000))} min ago`
        : 'never';
      const autoLine =
        `\n\n— Auto-sync —\nLast pull: ${ago}\n` +
        (bgOn
          ? 'Background: ON (Android runs it about every 15 min; it decides when).'
          : `Background: OFF${bgReason} — pulls only while the app is open.`);
      body += autoLine;

      // What the reconcile pass actually DID, in words.
      //
      // "1 event(s) found. 0 already imported." was true, accurate and
      // useless: it named the symptom and left the cause to be guessed at for
      // four days. Every line below names one event and what happened to it.
      const rec = lastCalendarReconcile();
      if (rec) {
        body += `\n\n— Last import —\n`
          + `${rec.seen} event(s) checked: `
          + [
            rec.inserted ? `${rec.inserted} added` : '',
            rec.updated ? `${rec.updated} corrected` : '',
            rec.unchanged ? `${rec.unchanged} already right` : '',
            rec.blocked ? `${rec.blocked} BLOCKED` : '',
            rec.complete ? `${rec.complete} already done` : '',
            rec.failed ? `${rec.failed} FAILED` : '',
          ].filter(Boolean).join(', ');
        if (rec.notes.length) {
          body += '\n\n' + rec.notes.slice(0, 6).map((n) => `• ${n}`).join('\n');
        }
      }
      // An event Google HAS that this phone is refusing on purpose is the one
      // outcome that looks exactly like a bug and is not one. Name it, and
      // offer the undo — a tombstone with no way back is a dead end.
      if (result.blockedByDismiss > 0) {
        Alert.alert(
          'Calendar',
          `${body}\n\n` +
          `⛔ ${result.blockedByDismiss} event(s) on Google are blocked on this phone ` +
          'because they were deleted here once, and a deletion is permanent:\n\n' +
          result.blockedTitles.slice(0, 5).map((t) => `• ${t}`).join('\n') +
          '\n\nUnblock them and import again?',
          [
            { text: 'Leave blocked', style: 'cancel' },
            {
              text: 'Unblock & import',
              onPress: async () => {
                const lifted = await clearDismissedExternalIds().catch(() => 0);
                const back = await syncCalendarToday(settings?.language ?? 'en', true)
                  .catch(() => 0);
                Alert.alert(
                  'Calendar',
                  `${lifted} block(s) lifted, ${back} event(s) imported.`,
                );
              },
            },
          ],
        );
      } else {
        Alert.alert('Calendar', body);
      }
    } finally {
      setCalChecking(false);
    }
  };

  const connectWhatsApp = async () => {
    setLinking(true);
    const start = await linkStart();
    if (!start?.ok) {
      setLinking(false);
      Alert.alert(T('WhatsApp', 'וואטסאפ'), start
        ? T('Could not create a link code. Try again in a minute.', 'לא הצלחתי ליצור קוד חיבור. אפשר לנסות שוב בעוד דקה.')
        : T('Sign in first (☁️ Cloud sync above), then try again.', 'צריך קודם להתחבר לחשבון (☁️ למעלה), ואז לנסות שוב.'));
      return;
    }
    if (start.url) {
      await Linking.openURL(start.url).catch(() => {
        Alert.alert(T('WhatsApp', 'וואטסאפ'), T(`Send Meira this message: ${start.text}`, `שלחי למאירה את ההודעה: ${start.text}`));
      });
    } else {
      Alert.alert(T('WhatsApp', 'וואטסאפ'), T(`Send Meira this message on WhatsApp: ${start.text}`, `שלחי למאירה בוואטסאפ: ${start.text}`));
    }
    // Wait for the proof — bounded: 3 minutes, then say so.
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await linkStatus();
      if (st?.linked && st.phone) {
        setLinkedPhone(st.phone);
        setPhone(st.phone);
        patchSettings({ whatsAppPhone: st.phone });
        const pushed = await registerPush(st.phone);
        const flushed = await verifyPhoneLink(st.phone);
        setLinking(false);
        Alert.alert(T('WhatsApp', 'וואטסאפ'),
          T('Connected ✓', 'מחובר ✓') + (pushed ? T(' Reminders will also ping this phone.', ' התזכורות יגיעו גם לטלפון הזה.') : '')
          + (flushed ? T(`\n\n${flushed} task(s) from WhatsApp synced across.`, `\n\n${flushed} משימות מוואטסאפ סונכרנו.`) : ''));
        return;
      }
    }
    setLinking(false);
    Alert.alert(T('WhatsApp', 'וואטסאפ'), T(
      "WhatsApp hasn't confirmed yet. Send the prepared message to Meira, then tap Connect again.",
      'עוד לא הגיע אישור מוואטסאפ. שלחי למאירה את ההודעה שהוכנה, ואז לחצי שוב "חיבור".'));
  };

  const handleSignOut = () => {
    Alert.alert(
      T('Sign out', 'יציאה מהחשבון'),
      T('Everything Meira keeps on this phone will be erased. It comes back from your account when you sign in again.',
        'כל מה שמאירה שומרת בטלפון יימחק. הוא יחזור מהחשבון כשתיכנסי שוב.'),
      [
        { text: T('Cancel', 'ביטול'), style: 'cancel' },
        {
          text: T('Sign out', 'יציאה'),
          style: 'destructive',
          // It used to only end the session: her tasks, home, places, chat and
          // calendar tokens stayed on the phone for whoever used it next (7.10).
          onPress: async () => {
            await supabaseSignOut().catch((e) => console.warn('[Account] sign out failed', e));
            const wipe = await wipeDevice();
            setCloudId(null); setCloudEmail(undefined);
            if (!wipe.ok) {
              Alert.alert(T('Not everything was erased', 'לא הכל נמחק'),
                T(`Still on the phone: ${wipe.failed.join(', ')}. Try again, or uninstall Meira.`,
                  `עדיין בטלפון: ${wipe.failed.join(', ')}. אפשר לנסות שוב, או להסיר את האפליקציה.`));
            }
            navigation.navigate('Onboarding');
          },
        },
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

  // ── Hobbies / routines (free text) ──
  // 6.10: "changes in the profile don't save, and there's no save button".
  // They saved on BLUR only — leaving with the keyboard up never blurred — and
  // any other save (a toggle) reloaded the profile and wiped what was typed.
  // Now: what she types is DIRTY until saved; it is saved 0.8 s after she
  // stops, on blur, on leaving the screen, and by the Save button, and the
  // line under the box says which (rule 3: a "saved" that can say "not saved").
  const [hobbies, setHobbies] = useState('');
  const [routinesNotes, setRoutinesNotes] = useState('');
  const dirty = useRef({ hobbies: false, routinesNotes: false });
  const [textSaved, setTextSaved] = useState<{ at?: string; error?: string; busy?: boolean }>({});
  useEffect(() => {
    if (!profile) return;
    if (!dirty.current.hobbies) setHobbies(profile.hobbies ?? '');
    if (!dirty.current.routinesNotes) setRoutinesNotes(profile.routinesNotes ?? '');
  }, [profile?.lastUpdated]);

  // Falls back to a blank profile instead of returning: loadProfile() is null
  // until onboarding completes, and this screen is exactly where someone who
  // skipped onboarding comes to set their home address. It used to no-op.
  // A routine she just wrote may need a question ("every day, or which days?").
  // Asked when she is done with it — leaving the field or the screen — never
  // while she is still typing (QuestionService, trigger 1: right after a save).
  const routinesTouched = useRef(false);
  const askAboutRoutines = () => {
    if (!routinesTouched.current) return;
    routinesTouched.current = false;
    invalidateRoutines();
    Questions.maybeAsk({ justSaved: true }).catch((e) => console.warn('[Profile] question check failed', e));
  };

  const saveProfileText = async (patch: Partial<UserProfile>, opts: { ask?: boolean } = {}) => {
    // From the STORED profile, not this screen's copy: her routines list, an
    // answer to Meira's question or the chat may have written it since.
    const base = (await loadProfile().catch(() => null)) ?? profile ?? blankProfile();
    // What she typed and has not saved yet rides along with ANY save, so a
    // toggle can never wipe it.
    const pending: Partial<UserProfile> = {
      ...(dirty.current.hobbies ? { hobbies } : {}),
      ...(dirty.current.routinesNotes ? { routinesNotes } : {}),
    };
    const next = { ...base, ...pending, ...patch, lastUpdated: new Date().toISOString() };
    setProfile(next);
    setTextSaved((s) => ({ ...s, busy: true }));
    try {
      await saveProfile(next);
      dirty.current = { hobbies: false, routinesNotes: false };
      setTextSaved({ at: new Date().toTimeString().slice(0, 5) });
      if (opts.ask) askAboutRoutines();
    } catch (e) {
      console.warn('[Profile] save failed', e);
      setTextSaved({ error: String((e as Error)?.message || e) });
    }
  };
  // The latest values, for the save that runs as the screen goes away.
  const latest = useRef({ hobbies, routinesNotes, save: saveProfileText, ask: askAboutRoutines });
  latest.current = { hobbies, routinesNotes, save: saveProfileText, ask: askAboutRoutines };
  useEffect(() => {
    if (!dirty.current.hobbies && !dirty.current.routinesNotes) return undefined;
    const timer = setTimeout(() => { latest.current.save({}).catch(() => {}); }, 800);
    return () => clearTimeout(timer);
  }, [hobbies, routinesNotes]);
  useEffect(() => () => {
    if (dirty.current.hobbies || dirty.current.routinesNotes) latest.current.save({}, { ask: true }).catch(() => {});
    else latest.current.ask();
  }, []);

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

  const he = settings?.language === 'he';
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const TITLE: Record<ProfileSection, [string, string]> = {
    you: ['You', 'את'],
    alerts: ['Alerts', 'התראות'],
    calendars: ['Calendars & mail', 'יומנים ומייל'],
    helpers: ['Helpers', 'עוזרים'],
    account: ['Account', 'חשבון'],
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <SkyBackdrop sky={sky} />
      <View style={[styles.topBar, he && styles.rowRtl]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}
          accessibilityRole="button" accessibilityLabel={T('Back', 'חזרה')}>
          <Text style={styles.backText}>{he ? '›' : '‹'}</Text>
        </TouchableOpacity>
        <Text style={[styles.topTitle, { color: sky.ink }]}>{T(...TITLE[section])}</Text>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {section === 'you' && (
          <>
            {/* Avatar + name */}
            <View style={styles.profileHeader}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{profile?.name?.[0]?.toUpperCase() ?? 'M'}</Text>
              </View>
              <Text style={[styles.profileName, { color: sky.ink }]}>{profile?.name ?? ''}</Text>
              <Text style={[styles.profileLevel, { color: sky.ink, opacity: 0.8 }]}>{he ? levelInfo.titleHe : levelInfo.titleEn}</Text>
            </View>

            {/* v3: the facts every leave time is built from, at a glance (utils/profileFacts). */}
            <WhatMeiraKnows facts={profileFacts(profile, he)} he={he}
              onTell={() => navigation.navigate('CoachChat', { mode: 'tell' })} />

            {/* Tell Meira — THE chat, opened on "about you" (her pick: one chat). */}
            <View style={styles.tellBox}>
              <Text style={[styles.tellTitle, he && styles.rtl]}>{T('Tell me about your habits', 'ספרי לי על ההרגלים שלך')}</Text>
              <Text style={[styles.tellText, he && styles.rtl]}>
                {T("Where you go, when, how you get there. I'll turn it into things I know — you'll see each one here.",
                  'לאן את הולכת, מתי ואיך מגיעה. אהפוך את זה לדברים שאני יודעת — כל אחד יופיע כאן.')}
              </Text>
              <View style={[styles.tellBtns, he && styles.rowRtl]}>
                <TouchableOpacity style={styles.tellBtn} accessibilityRole="button"
                  onPress={() => navigation.navigate('CoachChat', { mode: 'tell', listen: true })}>
                  <Text style={styles.tellBtnText}>{T('🎙️ Talk', '🎙️ לדבר')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.tellBtn, styles.tellBtnSoft]} accessibilityRole="button"
                  onPress={() => navigation.navigate('CoachChat', { mode: 'tell' })}>
                  <Text style={styles.tellBtnText}>{T('💬 Type', '💬 לכתוב')}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Home & travel — the origin every route is planned backwards from */}
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('HOME & GETTING AROUND', 'בית ותחבורה')}</Text>
              <View style={styles.card}>
                <View style={styles.textAreaRow}>
                  <Text style={styles.settingLabel}>{T('🏠 Home address', '🏠 כתובת הבית')}</Text>
                  {profile?.homeAddress ? <Text style={styles.hint}>{profile.homeAddress}</Text> : null}
                  <View style={styles.homeRow}>
                    <TextInput
                      style={styles.homeInput}
                      value={homeQuery}
                      onChangeText={setHomeQuery}
                      onSubmitEditing={runHomeSearch}
                      returnKeyType="search"
                      placeholder={T('Street, city', 'רחוב, עיר')}
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
                      {T('Not set — I cannot work out when to wake you or leave without it.',
                        'לא הוגדר — בלי זה אין לי ממה לחשב מתי להעיר אותך ומתי לצאת.')}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.rowDiv} />

                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{T('🚌 Usual transport', '🚌 תחבורה רגילה')}</Text>
                  <View style={styles.pillRow}>
                    {([
                      ['transit', '🚌'], ['car', '🚗'], ['bicycle', '🚴'], ['foot', '🚶'],
                    ] as [TransportMode, string][]).map(([mode, icon]) => (
                      <TouchableOpacity
                        key={mode}
                        style={[styles.pill, profile?.transportMode === mode && styles.pillActive]}
                        onPress={() => saveProfileText({
                          transportMode: mode,
                          // Choosing the car says she has one; anything else says nothing about it.
                          ...(mode === 'car' ? { hasCar: true } : {}),
                        })}
                      >
                        <Text style={styles.pillText}>{icon}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                <View style={styles.rowDiv} />

                {/* Car — the travel ladder turns on it (utils/travelLadder). */}
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{T('🚗 Do you have a car?', '🚗 יש לך רכב?')}</Text>
                  <View style={styles.pillRow}>
                    {([[true, T('Yes', 'כן')], [false, T('No', 'לא')]] as [boolean, string][]).map(([value, label]) => (
                      <TouchableOpacity
                        key={String(value)}
                        style={[styles.pill, profile?.hasCar === value && styles.pillActive]}
                        onPress={() => saveProfileText({ hasCar: value })}
                      >
                        <Text style={styles.pillText}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                {profile?.hasCar === undefined ? (
                  <Text style={styles.homeWarn}>
                    {T('Not set — I assume no car unless your usual transport is the car.',
                      'לא נבחר — אני מניחה שאין רכב, אלא אם התחבורה הרגילה היא רכב.')}
                  </Text>
                ) : null}

                <View style={styles.rowDiv} />

                {/* The earliest she will be woken (utils/dayFeasibility). */}
                <TimeRow
                  label={T('⏰ Earliest I will wake', '⏰ הכי מוקדם שאקום')}
                  value={parseHHMM(profile?.earliestWakeTime ?? DEFAULT_EARLIEST_WAKE)}
                  onChange={(t) => saveProfileText({ earliestWakeTime: fmtTime(t) })}
                />

                <View style={styles.rowDiv} />

                {/* Her bedtime — what the planners read (profile.sleepTime). The
                    old "Sleep time" row moved the EVENING CHECK-IN instead,
                    which now lives, by that name, in Alerts. */}
                <TimeRow
                  label={T('🌙 I go to sleep', '🌙 הולכת לישון')}
                  value={parseHHMM(profile?.sleepTime ?? '23:00')}
                  onChange={(t) => saveProfileText({ sleepTime: fmtTime(t) })}
                />
              </View>
            </View>

            {/* How pushy Meira is around a study block (19.10, her pick "2": three cards, each
                with a sample of what she will get). Radio semantics, 44dp rows. */}
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('HOW MUCH SHOULD I NUDGE?', 'כמה להציק לך?')}</Text>
              <View style={styles.card}>
                <NudgeSlider
                  level={nudgeLevelOf(profile)}
                  language={he ? 'he' : 'en'}
                  onChange={(level) => saveProfileText({ nudgeLevel: level })}
                />
              </View>
            </View>

            {/* Routines & habits — ONE list: her box and what she told Meira. */}
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('ROUTINES & HABITS', 'שגרה והרגלים')}</Text>
              <View style={styles.card}>
                <RoutineList he={he} />
              </View>
            </View>

            {/* Hobbies — free text Meira plans around */}
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('HOBBIES', 'תחביבים')}</Text>
              <View style={styles.card}>
                <View style={styles.textAreaRow}>
                  <TextInput
                    style={styles.textArea}
                    value={hobbies}
                    onChangeText={(v) => { dirty.current.hobbies = true; setHobbies(v); }}
                    onBlur={() => saveProfileText({})}
                    placeholder={T('climbing, guitar, cooking…', 'טיפוס, גיטרה, בישול…')}
                    placeholderTextColor={BRAND.inkSoft}
                    multiline
                  />
                </View>
                <View style={styles.saveRow}>
                  <Text style={[styles.saveState, textSaved.error ? { color: BRAND.danger } : null]} numberOfLines={2}>
                    {textSaved.busy ? T('Saving…', 'שומרת…')
                      : textSaved.error ? T(`Not saved: ${textSaved.error}`, `לא נשמר: ${textSaved.error}`)
                        : textSaved.at ? T(`✓ Saved ${textSaved.at}`, `✓ נשמר ${textSaved.at}`) : T('Saves as you type', 'נשמר תוך כדי הקלדה')}
                  </Text>
                </View>
              </View>
            </View>

            {/* What she taught Meira, and what Meira still asks */}
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('WHAT I LEARNED FROM YOU', 'מה שלמדתי ממך')}</Text>
              <View style={styles.card}>
                <LearnedRules he={he} />
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.card}>
                <TouchableOpacity style={styles.settingRow} onPress={() => navigation.navigate('PersonalityQuiz')}>
                  <Text style={styles.settingLabel}>{T('🧭 Personality check', '🧭 בדיקת אישיות')}</Text>
                  <Text style={styles.linkChevron}>›</Text>
                </TouchableOpacity>
                <View style={styles.rowDiv} />
                <TouchableOpacity style={styles.settingRow} onPress={() => navigation.navigate('Goals')}>
                  <Text style={styles.settingLabel}>{T('⭐ Goals & wish list', '⭐ מטרות ומשאלות')}</Text>
                  <Text style={styles.linkChevron}>›</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {section === 'alerts' && settings && (
          <>
            {/* Nearby errands (28.10, her option B): disclosure + real state. */}
            <NearbyNudgesCard he={he} />
            <View style={styles.section}>
              <View style={styles.card}>
                <View style={styles.settingRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingLabel}>{T('⏰ Loud wake-up alarm', '⏰ שעון מעורר חזק')}</Text>
                    <Text style={styles.hint}>{T('A clock alarm on wake days. The wake notification shows either way.',
                      'צלצול חזק בימים שצריך לקום. ההתראה מופיעה כך או כך.')}</Text>
                  </View>
                  <Switch
                    value={settings.wakeAlarmEnabled !== false}
                    onValueChange={(v) => patchSettings({ wakeAlarmEnabled: v })}
                    trackColor={{ true: BRAND.sunGold, false: BRAND.line }}
                  />
                </View>
                <View style={styles.rowDiv} />
                <TimeRow
                  label={T('☀️ Morning check-in', '☀️ צ׳ק-אין בוקר')}
                  value={settings.morningTime}
                  onChange={(v) => patchSettings({ morningTime: v })}
                />
                <View style={styles.rowDiv} />
                <TimeRow
                  label={T('🌙 Evening check-in', '🌙 צ׳ק-אין ערב')}
                  value={settings.eveningTime}
                  onChange={(v) => patchSettings({ eveningTime: v })}
                />
              </View>
            </View>

            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('WHATSAPP & PHONE ALERTS', 'וואטסאפ והתראות לטלפון')}</Text>
              <View style={styles.card}>
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{T('WhatsApp', 'וואטסאפ')}</Text>
                  <Text style={styles.settingLabel}>
                    {linkedPhone
                      ? T(`Connected ✓ ···${linkedPhone.slice(-3)}`, `מחובר ✓ ···${linkedPhone.slice(-3)}`)
                      : linkedPhone === null
                        ? T('Not connected', 'לא מחובר')
                        : T("Couldn't check", 'לא הצלחתי לבדוק')}
                  </Text>
                </View>
                <TouchableOpacity style={styles.linkBtn} onPress={connectWhatsApp} disabled={linking}>
                  <Text style={styles.linkBtnText}>{linking
                    ? T('Waiting for your WhatsApp message…', 'מחכה להודעה שלך בוואטסאפ…')
                    : linkedPhone ? T('🔗 Connect again', '🔗 חיבור מחדש') : T('🔗 Connect WhatsApp', '🔗 חיבור וואטסאפ')}</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('ALARM CLOCK', 'שעון מעורר')}</Text>
              <View style={styles.card}>
                <TimeRow label={T('⏰ Manual alarm', '⏰ שעון ידני')} value={alarmTime} onChange={setAlarmTime} />
                <TouchableOpacity style={styles.linkBtn} onPress={setManualAlarm}>
                  <Text style={styles.linkBtnText}>{T('Set system alarm', 'לכוון שעון במכשיר')}</Text>
                </TouchableOpacity>
                <View style={styles.rowDiv} />
                <TouchableOpacity style={styles.linkBtn} onPress={setAlarmForTomorrowsFirstTask}>
                  <Text style={styles.linkBtnText}>{T("⏰ Alarm for tomorrow's first task", '⏰ שעון למשימה הראשונה מחר')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {section === 'calendars' && (
          <>
            <View style={styles.section}>
              <CalendarConnections />
            </View>
            {/* "I added events and don't see them": not connected, connected but
                empty and imported but hidden all look the same from outside. */}
            <View style={styles.section}>
              <View style={styles.card}>
                <TouchableOpacity style={styles.settingRow} onPress={runCalendarCheck} disabled={calChecking}>
                  <Text style={styles.settingLabel}>{T('🔎 Check my calendar now', '🔎 לבדוק את היומן עכשיו')}</Text>
                  <Text style={styles.linkChevron}>
                    {calChecking ? '…' : cal
                      ? (cal.connected
                        ? T(`${cal.eventsFound} events · ${cal.imported} imported`, `${cal.eventsFound} אירועים · ${cal.imported} יובאו`)
                        : T('not connected', 'לא מחובר'))
                      : '›'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {section === 'helpers' && (
          <>
            <View style={styles.section}>
              <View style={styles.card}>
                <TouchableOpacity style={styles.settingRow} onPress={() => navigation.navigate('Agents')}>
                  <Text style={styles.settingLabel}>{T('🤖 My agents', '🤖 הסוכנים שלי')}</Text>
                  <Text style={styles.linkChevron}>›</Text>
                </TouchableOpacity>
                {/* Learning sessions: block WhatsApp, Instagram… while she studies (17.10). */}
                <TouchableOpacity style={styles.settingRow} onPress={() => setFocusOpen(true)} accessibilityRole="button">
                  <Text style={[styles.settingLabel, { flex: 1, flexShrink: 1 }]}>{T('📚 Learning sessions — blocked apps', '📚 למידה ממוקדת — אפליקציות חסומות')}</Text>
                  <Text style={styles.linkChevron}>›</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, he && styles.sectionLabelHe]}>{T('AI ASSISTANTS', 'עוזרי AI')}</Text>
              <AiAssistants />
            </View>
          </>
        )}

        {section === 'account' && (
          <>
            <View style={styles.section}>
              <View style={styles.card}>
                {/* Only ever disabled WHILE signing in: disabling it when signed in
                    is what made a stale session unrecoverable. */}
                <TouchableOpacity style={styles.settingRow} onPress={cloudId ? switchAccount : signIn} disabled={signingIn}>
                  <Text style={styles.settingLabel}>{T('☁️ Cloud sync', '☁️ סנכרון לענן')}</Text>
                  <Text
                    style={[styles.settingLabel, cloudId ? { color: BRAND.goldInk } : { color: BRAND.danger }]}
                    numberOfLines={1}
                  >
                    {signingIn ? T('Signing in…', 'מתחברת…') : cloudId ? `${cloudEmail || T('Signed in', 'מחוברת')} ✓` : T('Not signed in — tap ›', 'לא מחוברת — לחצי ›')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity onPress={handleSignOut} style={styles.signOut}>
              <Text style={styles.signOutText}>{T('Sign out', 'יציאה מהחשבון')}</Text>
            </TouchableOpacity>

            {/* Delete account — required by Google Play, promised by the privacy
                policy. Quiet, and behind two confirmations: it is irreversible. */}
            <TouchableOpacity onPress={handleDeleteAccount} style={styles.deleteAccount}>
              <Text style={styles.deleteAccountText}>{T('Delete my account', 'מחיקת החשבון שלי')}</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>
      <FocusSessionSheet visible={focusOpen} lang={he ? 'he' : 'en'} onClose={() => setFocusOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingBottom: 6 },
  rowRtl: { flexDirection: 'row-reverse' },
  backBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: surf('rgba(255,255,255,0.75)') },
  backText: { fontSize: 28, fontFamily: FONTS.bodyHeavy, color: BRAND.goldInk },
  topTitle: { fontSize: 24, fontFamily: FONTS.display, color: BRAND.warmInk },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  hint: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft, marginTop: 2 },
  tellBox: { padding: 16, gap: 6, borderRadius: 22, borderWidth: 1.5, borderColor: BRAND.sunGold, backgroundColor: surf('rgba(255,246,216,0.95)') },
  tellTitle: { fontSize: 18, fontFamily: FONTS.display, color: BRAND.warmInk },
  tellText: { fontSize: 13, fontFamily: FONTS.body, color: BRAND.inkSoft },
  tellBtns: { flexDirection: 'row', gap: 10, marginTop: 8 },
  tellBtn: { flex: 1, minHeight: 48, borderRadius: 14, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  tellBtnSoft: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.line },
  tellBtnText: { fontSize: 15, fontFamily: FONTS.bodyHeavy, color: BRAND.onGold },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  saveState: { flex: 1, fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  saveBtn: { backgroundColor: BRAND.sunGold, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  saveBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
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
  // v3: labels sit on the sky in a soft pill; cards are white glass (canvas v4).
  sectionLabel: {
    alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: 'hidden',
    backgroundColor: surf('rgba(255,255,255,0.7)'), fontSize: 11.5, fontFamily: FONTS.bodyHeavy, color: BRAND.goldInk, letterSpacing: 0.3,
  },
  sectionLabelHe: { alignSelf: 'flex-end', writingDirection: 'rtl' },
  card: {
    backgroundColor: surf('rgba(255,255,255,0.92)'), borderRadius: 22, borderWidth: 1, borderColor: nline('rgba(255,255,255,0.9)'),
    ...SHADOWS.card, overflow: 'hidden',
  },

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

  nudgeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  nudgeRowOn: { backgroundColor: BRAND.cream },
  nudgeDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: BRAND.inkSoft },
  nudgeDotOn: { borderColor: BRAND.sunGold, backgroundColor: BRAND.sunGold },
  nudgeSample: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft, marginTop: 2 },

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
