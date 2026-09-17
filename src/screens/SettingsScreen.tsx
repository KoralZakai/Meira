/**
 * SettingsScreen — notification times and profile-level preferences.
 * Dependencies: NotificationService (reschedule on change), UserProfileStorage.
 */
import React from 'react';
import { Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import LumiWordmark from '../components/LumiWordmark';
import { useLumiContext } from '../hooks/useLumiContext';
import { rescheduleDailyNotifications } from '../services/NotificationService';
import { speakMorningBriefingNow, scheduleWakeUpTest } from '../services/MorningBriefingService';
import { clearProfile } from '../services/UserProfileStorage';
import { AppLanguage, AppSettings, TimeSetting } from '../types/models';
import { RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

function formatTime(time: TimeSetting): string {
  const hh = `${time.hour}`.padStart(2, '0');
  const mm = `${time.minute}`.padStart(2, '0');
  return `${hh}:${mm}`;
}

function TimeRow({
  title,
  value,
  onChange,
}: {
  title: string;
  value: TimeSetting;
  onChange: (next: TimeSetting) => void;
}) {
  const shiftMinutes = (delta: number) => {
    const total = (value.hour * 60 + value.minute + delta + 24 * 60) % (24 * 60);
    onChange({ hour: Math.floor(total / 60), minute: total % 60 });
  };

  return (
    <View style={styles.rowCard}>
      <Text style={styles.rowTitle}>{title}</Text>
      <View style={styles.rowActions}>
        <Pressable style={styles.stepButton} onPress={() => shiftMinutes(-15)}>
          <Text style={styles.stepText}>-15m</Text>
        </Pressable>
        <Text style={styles.timeValue}>{formatTime(value)}</Text>
        <Pressable style={styles.stepButton} onPress={() => shiftMinutes(15)}>
          <Text style={styles.stepText}>+15m</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function SettingsScreen({ navigation }: Props) {
  const { checkInState } = useLumiContext();
  const { settings, updateSettings } = checkInState;

  const setSettings = async (next: AppSettings) => {
    await updateSettings(next);
    await rescheduleDailyNotifications(next);
  };

  const setLanguage = async (language: AppLanguage) => {
    await setSettings({ ...settings, language });
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <LumiWordmark size={34} style={styles.brandLogo} />
        <Text style={styles.title}>Settings</Text>

        <TimeRow
          title="Morning notification"
          value={settings.morningTime}
          onChange={(morningTime) => setSettings({ ...settings, morningTime })}
        />

        <TimeRow
          title="Afternoon notification"
          value={settings.afternoonTime}
          onChange={(afternoonTime) => setSettings({ ...settings, afternoonTime })}
        />

        <TimeRow
          title="Evening notification"
          value={settings.eveningTime}
          onChange={(eveningTime) => setSettings({ ...settings, eveningTime })}
        />

        <View style={styles.rowCard}>
          <Text style={styles.rowTitle}>Android morning trigger window</Text>
          <View style={styles.rowActions}>
            <Pressable
              style={styles.stepButton}
              onPress={() =>
                setSettings({
                  ...settings,
                  androidMorningWindowStart: Math.max(0, settings.androidMorningWindowStart - 1),
                })
              }
            >
              <Text style={styles.stepText}>Start -1h</Text>
            </Pressable>
            <Text style={styles.timeValue}>
              {settings.androidMorningWindowStart}:00 - {settings.androidMorningWindowEnd}:00
            </Text>
            <Pressable
              style={styles.stepButton}
              onPress={() =>
                setSettings({
                  ...settings,
                  androidMorningWindowEnd: Math.min(23, settings.androidMorningWindowEnd + 1),
                })
              }
            >
              <Text style={styles.stepText}>End +1h</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.rowCard}>
          <Text style={styles.rowTitle}>Wake-up call (motivational + today's tasks, read aloud)</Text>
          <View style={styles.rowActions}>
            <Pressable
              style={styles.stepButton}
              onPress={async () => {
                const spoken = await speakMorningBriefingNow();
                Alert.alert('Lumi is speaking…', spoken);
              }}
            >
              <Text style={styles.stepText}>▶︎ Hear it now</Text>
            </Pressable>
            <Pressable
              style={styles.stepButton}
              onPress={async () => {
                const when = await scheduleWakeUpTest(9, 0);
                Alert.alert(
                  'Wake-up alarm set ⏰',
                  `Lumi will ring at ${formatTime({ hour: when.getHours(), minute: when.getMinutes() })} on ${when.toLocaleDateString()} with your greeting + task list. Tap the alarm to hear it read aloud.`,
                );
              }}
            >
              <Text style={styles.stepText}>Set 9:00 alarm</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.rowCard}>
          <Text style={styles.rowTitle}>Language</Text>
          <View style={styles.rowActions}>
            <Pressable
              style={[styles.languageButton, settings.language === 'en' && styles.languageActive]}
              onPress={() => setLanguage('en')}
            >
              <Text style={[styles.languageText, settings.language === 'en' && styles.languageTextActive]}>
                English
              </Text>
            </Pressable>
            <Pressable
              style={[styles.languageButton, settings.language === 'he' && styles.languageActive]}
              onPress={() => setLanguage('he')}
            >
              <Text style={[styles.languageText, settings.language === 'he' && styles.languageTextActive]}>
                Hebrew
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.rowCard}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.rowTitle}>
                {settings.language === 'he' ? 'שעון מעורר לקימה' : 'Wake-up alarm'}
              </Text>
              <Text style={styles.toggleHint}>
                {settings.language === 'he'
                  ? 'צלצול חזק כמו שעון מעורר. ההתראה תופיע כך או כך.'
                  : 'A loud clock alarm. The wake notification shows either way.'}
              </Text>
            </View>
            <Switch
              value={settings.wakeAlarmEnabled !== false}
              onValueChange={(wakeAlarmEnabled) => setSettings({ ...settings, wakeAlarmEnabled })}
              trackColor={{ true: BRAND.sunGold, false: '#CFC8B8' }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        <View style={styles.rowCard}>
          <Text style={styles.rowTitle}>Profile</Text>
          <View style={styles.rowActions}>
            <Pressable
              style={styles.stepButton}
              onPress={() => navigation.navigate('ProfileEdit')}
            >
              <Text style={styles.stepText}>Edit by voice</Text>
            </Pressable>
            <Pressable
              style={styles.stepButton}
              onPress={async () => {
                await clearProfile();
                navigation.replace('Onboarding');
              }}
            >
              <Text style={styles.stepText}>Reset onboarding</Text>
            </Pressable>
          </View>
        </View>

        <Pressable style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleText: { flex: 1, gap: 4 },
  toggleHint: { fontFamily: FONTS.body, fontSize: 12, color: '#8A8A9A', lineHeight: 16 },
  safeArea: {
    flex: 1,
    backgroundColor: BRAND.cream,
  },
  content: {
    padding: 16,
    paddingBottom: 24,
  },
  brandLogo: {
    marginBottom: 6,
  },
  title: {
    fontSize: 30,
    fontFamily: FONTS.display,
    color: BRAND.warmInk,
    marginBottom: 14,
  },
  rowCard: {
    backgroundColor: BRAND.creamCard,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.card,
    padding: 12,
    marginBottom: 12,
    ...SHADOWS.card,
  },
  rowTitle: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
    marginBottom: 10,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepButton: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: BRAND.white,
  },
  stepText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.bodySemi,
  },
  timeValue: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
  },
  languageButton: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: BRAND.line,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: BRAND.white,
  },
  languageActive: {
    backgroundColor: BRAND.sunGold,
    borderColor: BRAND.sunGold,
  },
  languageText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.bodySemi,
  },
  languageTextActive: {
    color: BRAND.warmInk,
  },
  backButton: {
    marginTop: 8,
    alignSelf: 'center',
    backgroundColor: BRAND.sunGold,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: RADIUS.pill,
    ...SHADOWS.button,
  },
  backText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
  },
});
