/**
 * PersonalityHandoffScreen — entry for lumi://personality?token=… deep links:
 * resolves the WhatsApp handoff token and routes into the quiz.
 * Dependencies: PersonalityHandoffService (server resolve/complete), TaskStorage.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { BRAND } from '../constants/theme';
import { MBTIType } from '../types';
import { resolveHandoff, completeHandoff } from '../services/PersonalityHandoffService';
import { getSettings } from '../services/TaskStorage';
import QuickMBTIScreen from './QuickMBTIScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'PersonalityHandoff'>;

const T = {
  en: { expired: "This link expired — ask Lumi for a new one on WhatsApp 💬" },
  he: { expired: 'הקישור פג תוקף — בקש מלומי קישור חדש בוואטסאפ 💬' },
};

/** Lands here from a lumi://personality?token=... link sent by the WhatsApp bot. */
export default function PersonalityHandoffScreen({ route, navigation }: Props) {
  const { token } = route.params;
  const [userId, setUserId] = useState<string | null>(null);
  const [language, setLanguage] = useState<'en' | 'he'>('en');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [handoff, settings] = await Promise.all([resolveHandoff(token), getSettings()]);
      if (!mounted) return;
      setLanguage(settings.language);
      if (handoff) {
        setUserId(handoff.userId);
      } else {
        setFailed(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [token]);

  if (failed) {
    return (
      <View style={[styles.center, { backgroundColor: BRAND.cream }]}>
        <Text style={styles.message}>{T[language].expired}</Text>
      </View>
    );
  }

  if (!userId) {
    return (
      <View style={[styles.center, { backgroundColor: BRAND.cream }]}>
        <ActivityIndicator color={BRAND.sunGold} size="large" />
      </View>
    );
  }

  return (
    <QuickMBTIScreen
      userId={userId}
      language={language}
      onComplete={async (type: MBTIType) => {
        await completeHandoff(userId, type);
        navigation.replace('Home');
      }}
      onSaveLater={() => navigation.replace('Home')}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { fontSize: 16, color: BRAND.warmInk, textAlign: 'center' },
});
