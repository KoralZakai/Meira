/**
 * FocusSessionSheet — the learning-session chooser in a sheet: blocked apps, the two permissions,
 * Start. Opened from Menu › Helpers › "Learning sessions — blocked apps", and by the first-time
 * setup nudge (FocusLectureHost). The same panel draws inline on FocusNowScreen.
 */
import React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import BottomSheet from './ui/BottomSheet';
import FocusSessionPanel from './FocusSessionPanel';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';
import { focusStrings } from '../utils/focusSession';
import type { AppLanguage, Task } from '../types/index';

interface Props {
  visible: boolean;
  lang: AppLanguage;
  task?: Task;
  onClose: () => void;
  onChanged?: () => void;
}

export default function FocusSessionSheet({ visible, lang, task, onClose, onChanged }: Props) {
  const S = focusStrings(lang);
  const he = lang === 'he';
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <ScrollView
        style={{ maxHeight: Dimensions.get('window').height * 0.82 }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, he && styles.rtl]}>{S.sheetTitle}</Text>
        {/* Mounted only while open: it reads permissions and the running session afresh each time. */}
        {visible ? <FocusSessionPanel lang={lang} task={task} onChanged={onChanged} /> : null}
        <View style={styles.footer}>
          <TouchableOpacity style={styles.close} onPress={onClose} accessibilityRole="button">
            <Text style={styles.closeText}>{S.close}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  title: { fontFamily: FONTS.display, fontSize: 22, color: BRAND.warmInk },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  footer: { alignItems: 'center' },
  close: { minHeight: MIN_TOUCH, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkFaint },
});
