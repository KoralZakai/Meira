/**
 * GoalsScreen — the user's wish list (aspirations) + achieved goals, backed by
 * TaskStorage.saveGoals/loadGoals (cloud-synced). Lumi pulls active aspirations
 * from here to suggest wish-list items during free time (suggest_gap_filler +
 * the Today-screen gap card).
 * Dependencies: TaskStorage (loadGoals/saveGoals), navigation/theme.
 */
import React, { useCallback, useState } from 'react';
import {
  SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { loadGoals, saveGoals } from '../services/TaskStorage';
import { Goal } from '../types/index';

type Props = NativeStackScreenProps<RootStackParamList, 'Goals'>;

export default function GoalsScreen({ navigation }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [newGoal, setNewGoal] = useState('');

  useFocusEffect(useCallback(() => {
    loadGoals().then(setGoals).catch(() => {});
  }, []));

  const persist = async (next: Goal[]) => {
    setGoals(next);
    await saveGoals(next);
  };

  const addGoal = async () => {
    const text = newGoal.trim();
    if (!text) return;
    const goal: Goal = {
      id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      category: 'aspiration',
      type: 'aspiration',
      linkedTaskIds: [],
      completedTasksCount: 0,
      totalTasksCount: 0,
      progressPercent: 0,
      status: 'active',
      createdAt: Date.now(),
    };
    setNewGoal('');
    await persist([...goals, goal]);
  };

  const markAchieved = (goal: Goal) =>
    persist(goals.map((g) => (g.id === goal.id ? { ...g, status: 'achieved' as const, achievedAt: Date.now() } : g)));

  const confirmDelete = (goal: Goal) =>
    Alert.alert('Delete goal?', goal.text, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => persist(goals.filter((g) => g.id !== goal.id)) },
    ]);

  const activeGoals = goals.filter((g) => g.status === 'active');
  const achievedGoals = goals.filter((g) => g.status === 'achieved');

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>⭐ Goals & Wish List</Text>
          <Text style={styles.headerSubtitle}>Lumi suggests these when you have free time</Text>
        </View>

        {/* Add a wish */}
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            value={newGoal}
            onChangeText={setNewGoal}
            placeholder="Something you wish to do… (learn guitar, read more)"
            placeholderTextColor={BRAND.inkSoft}
            onSubmitEditing={addGoal}
            returnKeyType="done"
          />
          <TouchableOpacity style={[styles.addBtn, !newGoal.trim() && { opacity: 0.4 }]} onPress={addGoal} disabled={!newGoal.trim()}>
            <Text style={styles.addBtnText}>+</Text>
          </TouchableOpacity>
        </View>

        {activeGoals.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>WISH LIST</Text>
            <View style={styles.goalsList}>
              {activeGoals.map((goal) => (
                <TouchableOpacity
                  key={goal.id}
                  style={styles.goalCard}
                  onLongPress={() => confirmDelete(goal)}
                  delayLongPress={400}
                  activeOpacity={0.85}
                >
                  <View style={styles.goalRow}>
                    <View style={styles.goalHeader}>
                      <Text style={styles.goalText}>{goal.text}</Text>
                      {goal.totalTasksCount > 0 && (
                        <Text style={styles.progressText}>
                          {goal.completedTasksCount}/{goal.totalTasksCount} tasks · {goal.progressPercent}%
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity style={styles.achieveBtn} onPress={() => markAchieved(goal)}>
                      <Text style={styles.achieveBtnText}>✓</Text>
                    </TouchableOpacity>
                  </View>
                  {goal.totalTasksCount > 0 && (
                    <View style={styles.progressBar}>
                      <View style={[styles.progressFill, { width: `${goal.progressPercent}%` }]} />
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.hint}>Long-press a goal to delete · ✓ marks it achieved</Text>
          </View>
        )}

        {achievedGoals.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>ACHIEVED 🎉</Text>
            <View style={styles.goalsList}>
              {achievedGoals.map((goal) => (
                <TouchableOpacity key={goal.id} style={styles.achievedGoal} onLongPress={() => confirmDelete(goal)} delayLongPress={400}>
                  <Text style={styles.achievedGoalText}>✓ {goal.text}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {goals.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🎯</Text>
            <Text style={styles.emptyText}>No goals yet</Text>
            <Text style={styles.emptySubtext}>Add wishes above — Lumi will find time for them</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND.cream,
  },
  content: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 13,
    color: BRAND.inkSoft,
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    marginBottom: 12,
  },
  goalsList: {
    gap: 12,
  },
  goalCard: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 14,
    borderLeftWidth: 4,
    borderLeftColor: BRAND.sunGold,
  },
  goalHeader: {
    flex: 1,
    gap: 4,
  },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  goalText: {
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
  addRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
    alignItems: 'center',
  },
  addInput: {
    flex: 1,
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    borderWidth: 1,
    borderColor: BRAND.line,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: FONTS.body,
    color: BRAND.warmInk,
  },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: BRAND.sunGold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: {
    fontSize: 22,
    color: '#FFF',
    fontFamily: FONTS.bodyHeavy,
    lineHeight: 26,
  },
  achieveBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: BRAND.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  achieveBtnText: {
    fontSize: 14,
    color: BRAND.success,
    fontFamily: FONTS.bodyHeavy,
  },
  hint: {
    fontSize: 11,
    color: BRAND.inkSoft,
    marginTop: 10,
    textAlign: 'center',
  },
  progressSection: {
    gap: 8,
  },
  progressBar: {
    height: 6,
    backgroundColor: BRAND.line,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: BRAND.success,
  },
  progressText: {
    fontSize: 12,
    color: BRAND.inkSoft,
  },
  targetDate: {
    fontSize: 11,
    color: BRAND.inkSoft,
    marginTop: 6,
  },
  achievedGoal: {
    backgroundColor: BRAND.success,
    borderRadius: RADIUS.chip,
    padding: 12,
  },
  achievedGoalText: {
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
    color: '#FFF',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 16,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
    marginBottom: 4,
  },
  emptySubtext: {
    fontSize: 12,
    color: BRAND.inkSoft,
  },
  loadingText: {
    fontSize: 14,
    color: BRAND.warmInk,
    textAlign: 'center',
    marginTop: 20,
  },
});
