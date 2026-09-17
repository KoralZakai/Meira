/**
 * PersonalityQuizScreen — the full MBTI quiz flow; saves the resulting type.
 * Dependencies: SupabaseAuthService (user id), TaskStorage.
 */
import React, { useEffect, useState } from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { MBTIType } from '../types';
import { getSettings } from '../services/TaskStorage';
import { getUserId } from '../services/SupabaseAuthService';
import QuickMBTIScreen from './QuickMBTIScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'PersonalityQuiz'>;

/** In-app entry to the personality test (reached from Profile). */
export default function PersonalityQuizScreen({ navigation }: Props) {
  const [language, setLanguage] = useState<'en' | 'he'>('en');
  const [userId, setUserId] = useState('local');

  useEffect(() => {
    getSettings().then((s) => setLanguage(s.language));
    getUserId().then((id) => { if (id) setUserId(id); }).catch(() => {});
  }, []);

  return (
    <QuickMBTIScreen
      userId={userId}
      language={language}
      onComplete={(_type: MBTIType) => navigation.goBack()}
      onSaveLater={() => navigation.goBack()}
    />
  );
}
