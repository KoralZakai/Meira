/** GapSuggestionCard — Lumi's suggestion card for a free time slot (accept/reject). */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GapSuggestion } from '../types/index';
import { BRAND, FONTS, RADIUS } from '../constants/theme';

interface Props {
  suggestion: GapSuggestion;
  onAccept: (suggestion: GapSuggestion) => void;
  onReject: (suggestion: GapSuggestion) => void;
}

export function GapSuggestionCard({ suggestion, onAccept, onReject }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.lightbulb}>💡</Text>
        <View style={styles.headerText}>
          <Text style={styles.title}>Lumi suggests</Text>
          <Text style={styles.time}>
            {suggestion.gapStart} - {suggestion.gapEnd}
          </Text>
        </View>
      </View>

      <Text style={styles.reason}>{suggestion.reason}</Text>

      <View style={styles.actions}>
        <Pressable
          onPress={() => onReject(suggestion)}
          style={({ pressed }) => [styles.button, styles.rejectButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.rejectText}>Not now</Text>
        </Pressable>
        <Pressable
          onPress={() => onAccept(suggestion)}
          style={({ pressed }) => [styles.button, styles.acceptButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.acceptText}>Add it</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: BRAND.sunGold,
  },
  header: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  lightbulb: {
    fontSize: 20,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 13,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
  },
  time: {
    fontSize: 11,
    color: BRAND.inkSoft,
    marginTop: 2,
  },
  reason: {
    fontSize: 13,
    color: BRAND.warmInk,
    lineHeight: 18,
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  rejectButton: {
    backgroundColor: BRAND.cream,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  rejectText: {
    fontSize: 12,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
  acceptButton: {
    backgroundColor: BRAND.sunGold,
  },
  acceptText: {
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
    color: BRAND.white,
  },
});
