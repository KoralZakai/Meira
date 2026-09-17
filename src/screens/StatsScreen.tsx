/**
 * StatsScreen — level/points/streak cards, weekly chart, category breakdown.
 * Dependencies: TaskStorage (stats + reward events).
 */
import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { BRAND, CATEGORY_META, LEVELS, FONTS, RADIUS } from '../constants/theme';
import { UserStats, TaskCategory } from '../types/index';
import * as TaskStorage from '../services/TaskStorage';
import { useWeeklyStats } from '../hooks/useWeeklyStats';

type Props = NativeStackScreenProps<RootStackParamList, 'Stats'>;

export default function StatsScreen({ navigation }: Props) {
  const weeklyStats = useWeeklyStats();
  const [userStats, setUserStats] = useState<UserStats | null>(null);

  useEffect(() => {
    const loadStats = async () => {
      const stats = await TaskStorage.loadStats();
      setUserStats(stats);
    };
    loadStats();
  }, []);

  if (!userStats) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.loadingText}>Loading stats...</Text>
      </SafeAreaView>
    );
  }

  const currentLevel = LEVELS.find(l => userStats.totalPoints >= l.minPoints) || LEVELS[0];
  const nextLevel = LEVELS.find(l => l.minPoints > userStats.totalPoints);
  const levelProgress = nextLevel
    ? Math.round(((userStats.totalPoints - currentLevel.minPoints) / (nextLevel.minPoints - currentLevel.minPoints)) * 100)
    : 100;

  const completionRate = userStats.totalTasksCompleted > 0
    ? Math.round((userStats.totalTasksOnTime / userStats.totalTasksCompleted) * 100)
    : 0;

  const categories: TaskCategory[] = [
    'gym', 'work', 'course', 'call', 'meeting', 'zoom', 'class', 'hobby_class',
    'interview', 'conference', 'doctor', 'aspiration', 'leisure', 'general',
  ];

  // Sort categories by hours (descending)
  const sortedCategories = categories.sort(
    (a, b) => (weeklyStats.categoryHours[b] || 0) - (weeklyStats.categoryHours[a] || 0)
  ).filter(cat => (weeklyStats.categoryHours[cat] || 0) > 0);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>THIS WEEK</Text>
        </View>

        {/* Quick Stats Bar */}
        <View style={styles.quickStats}>
          <View style={styles.quickStatItem}>
            <Text style={styles.quickStatIcon}>⭐</Text>
            <Text style={styles.quickStatValue}>{userStats.totalPoints}</Text>
            <Text style={styles.quickStatLabel}>pts</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.quickStatItem}>
            <Text style={styles.quickStatIcon}>📈</Text>
            <Text style={styles.quickStatValue}>Lv{userStats.level}</Text>
            <Text style={styles.quickStatLabel}>level</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.quickStatItem}>
            <Text style={styles.quickStatIcon}>🔥</Text>
            <Text style={styles.quickStatValue}>{userStats.currentStreak}</Text>
            <Text style={styles.quickStatLabel}>days</Text>
          </View>
        </View>

        {/* Level Progress */}
        {nextLevel && (
          <View style={styles.levelProgressSection}>
            <View style={styles.levelProgressBar}>
              <View style={[styles.levelProgressFill, { width: `${levelProgress}%` }]} />
            </View>
            <Text style={styles.levelProgressText}>
              {nextLevel.minPoints - userStats.totalPoints} pts to {nextLevel.titleEn}
            </Text>
          </View>
        )}

        {/* Category Hours */}
        <View style={styles.categorySection}>
          <Text style={styles.sectionTitle}>Hours by Category</Text>
          {sortedCategories.length > 0 ? (
            sortedCategories.map((cat) => {
              const meta = CATEGORY_META[cat];
              const hours = weeklyStats.categoryHours[cat] || 0;
              const count = weeklyStats.categoryCount[cat] || 0;
              const maxHours = Math.max(...Object.values(weeklyStats.categoryHours || {}), 10);
              const barWidth = Math.min((hours / maxHours) * 100, 100);

              return (
                <View key={cat} style={styles.categoryRow}>
                  <View style={styles.categoryLabel}>
                    <Text style={styles.categoryIcon}>{meta?.icon || '📌'}</Text>
                    <Text style={styles.categoryName}>{meta?.labelEn || cat}</Text>
                  </View>
                  <View style={styles.categoryBar}>
                    <View
                      style={[
                        styles.categoryBarFill,
                        { width: `${barWidth}%`, backgroundColor: meta?.color || BRAND.inkFaint },
                      ]}
                    />
                  </View>
                  <Text style={styles.categoryStats}>
                    {count}x · {hours.toFixed(1)}h
                  </Text>
                </View>
              );
            })
          ) : (
            <Text style={styles.emptyText}>No tasks this week yet.</Text>
          )}
        </View>

        {/* Summary Stats */}
        <View style={styles.summarySection}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total hours:</Text>
            <Text style={styles.summaryValue}>{weeklyStats.totalHours.toFixed(1)} h</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Tasks completed:</Text>
            <Text style={styles.summaryValue}>{userStats.totalTasksCompleted}/{userStats.totalTasksCompleted + userStats.totalTasksMissed} ({completionRate}%)</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>On time:</Text>
            <Text style={styles.summaryValue}>{userStats.totalTasksOnTime}/{userStats.totalTasksCompleted} ({completionRate}%)</Text>
          </View>
        </View>

        {/* Day Bar Chart */}
        <View style={styles.dayChartSection}>
          <Text style={styles.sectionTitle}>This Week</Text>
          <View style={styles.dayChart}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, idx) => (
              <View key={day} style={styles.dayColumn}>
                <View style={styles.dayBarContainer}>
                  <View
                    style={[
                      styles.dayBar,
                      { height: `${Math.random() * 100}%` },
                    ]}
                  />
                </View>
                <Text style={styles.dayLabel}>{day}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Spacing */}
        <View style={{ height: 32 }} />
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
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  headerTitle: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: BRAND.inkSoft,
    letterSpacing: 0.5,
  },
  quickStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 12,
  },
  quickStatItem: {
    alignItems: 'center',
    flex: 1,
  },
  quickStatIcon: {
    fontSize: 20,
    marginBottom: 4,
  },
  quickStatValue: {
    fontSize: 16,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
  },
  quickStatLabel: {
    fontSize: 11,
    color: BRAND.inkSoft,
    marginTop: 2,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: BRAND.line,
  },
  levelProgressSection: {
    marginHorizontal: 16,
    marginBottom: 16,
    gap: 6,
  },
  levelProgressBar: {
    height: 6,
    backgroundColor: BRAND.line,
    borderRadius: 3,
    overflow: 'hidden',
  },
  levelProgressFill: {
    height: '100%',
    backgroundColor: BRAND.sunGold,
  },
  levelProgressText: {
    fontSize: 11,
    color: BRAND.inkSoft,
  },
  categorySection: {
    marginHorizontal: 16,
    marginBottom: 16,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  categoryLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 80,
    gap: 6,
  },
  categoryIcon: {
    fontSize: 16,
  },
  categoryName: {
    fontSize: 12,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
    flex: 1,
  },
  categoryBar: {
    flex: 1,
    height: 8,
    backgroundColor: BRAND.creamCard,
    borderRadius: 4,
    overflow: 'hidden',
  },
  categoryBarFill: {
    height: '100%',
  },
  categoryStats: {
    fontSize: 11,
    color: BRAND.inkSoft,
    fontFamily: FONTS.bodySemi,
    width: 60,
    textAlign: 'right',
  },
  sectionTitle: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 13,
    color: BRAND.inkSoft,
    textAlign: 'center',
    marginVertical: 12,
  },
  summarySection: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 12,
    gap: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 12,
    color: BRAND.warmInk,
    fontFamily: FONTS.bodySemi,
  },
  summaryValue: {
    fontSize: 12,
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
  },
  dayChartSection: {
    marginHorizontal: 16,
    marginBottom: 16,
  },
  dayChart: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    height: 100,
    gap: 6,
  },
  dayColumn: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  dayBarContainer: {
    width: '100%',
    height: 80,
    backgroundColor: BRAND.creamCard,
    borderRadius: 6,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  dayBar: {
    width: '100%',
    backgroundColor: BRAND.sunGold,
  },
  dayLabel: {
    fontSize: 10,
    color: BRAND.inkSoft,
    fontFamily: FONTS.bodySemi,
  },
  loadingText: {
    fontSize: 14,
    color: BRAND.warmInk,
    textAlign: 'center',
    marginTop: 20,
  },
});
