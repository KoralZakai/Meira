/** SubtaskList — checkable ordered subtasks with progress. */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Subtask } from '../types/index';
import { BRAND, FONTS, RADIUS } from '../constants/theme';

interface Props {
  subtasks: Subtask[];
  onToggle: (subtask: Subtask) => void;
}

export function SubtaskList({ subtasks, onToggle }: Props) {
  const sorted = [...subtasks].sort((a, b) => a.order - b.order);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Subtasks</Text>
      <View style={styles.list}>
        {sorted.map(subtask => (
          <Pressable
            key={subtask.id}
            onPress={() => onToggle(subtask)}
            style={styles.subtask}
          >
            <View
              style={[
                styles.checkbox,
                subtask.status === 'complete' && styles.checkboxChecked,
              ]}
            >
              {subtask.status === 'complete' && (
                <Text style={styles.checkmark}>✓</Text>
              )}
            </View>
            <View style={styles.subtaskContent}>
              <Text
                style={[
                  styles.subtaskText,
                  subtask.status === 'complete' && styles.subtaskTextComplete,
                ]}
              >
                {subtask.text}
              </Text>
              <Text style={styles.duration}>~{subtask.durationMinutes} min</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  title: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
  },
  list: {
    gap: 8,
  },
  subtask: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: BRAND.cream,
    borderRadius: RADIUS.chip,
    gap: 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: BRAND.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: BRAND.success,
    borderColor: BRAND.success,
  },
  checkmark: {
    color: '#FFF',
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
  },
  subtaskContent: {
    flex: 1,
    gap: 4,
  },
  subtaskText: {
    fontSize: 13,
    color: BRAND.warmInk,
    fontFamily: FONTS.bodySemi,
  },
  subtaskTextComplete: {
    textDecorationLine: 'line-through',
    color: BRAND.inkSoft,
  },
  duration: {
    fontSize: 12,
    color: BRAND.inkSoft,
  },
});
