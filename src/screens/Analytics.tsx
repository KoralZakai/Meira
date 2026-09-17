/**
 * Analytics — charts of task completion by category/week.
 * Dependencies: TaskStorage (task history).
 */
import React, { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, CATEGORY_META, LEVELS, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { loadStats } from '../services/TaskStorage';
import { UserStats, TaskCategory } from '../types';
import { useWeeklyStats } from '../hooks/useWeeklyStats';

export default function Analytics() {
  const insets = useSafeAreaInsets();
  const weekly = useWeeklyStats();
  const [stats, setStats] = useState<UserStats | null>(null);

  useEffect(() => {
    loadStats().then(setStats);
  }, []);

  if (!stats) return <View style={[styles.root, { paddingTop: insets.top }]} />;

  const currentLevel = [...LEVELS].reverse().find((l) => stats.totalPoints >= l.minPoints) ?? LEVELS[0];
  const nextLevel = LEVELS.find((l) => l.minPoints > stats.totalPoints);
  const levelProgress = nextLevel
    ? (stats.totalPoints - currentLevel.minPoints) / (nextLevel.minPoints - currentLevel.minPoints)
    : 1;

  const sortedCats = (Object.keys(weekly.categoryHours) as TaskCategory[])
    .filter((c) => (weekly.categoryHours[c] ?? 0) > 0)
    .sort((a, b) => (weekly.categoryHours[b] ?? 0) - (weekly.categoryHours[a] ?? 0));

  const maxCatHours = sortedCats.reduce((m, c) => Math.max(m, weekly.categoryHours[c] ?? 0), 1);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Level card */}
        <View style={styles.levelCard}>
          <Text style={styles.levelTitle}>{currentLevel.titleEn}</Text>
          <View style={styles.levelBar}>
            <View style={[styles.levelBarFill, { width: `${Math.round(levelProgress * 100)}%` }]} />
          </View>
          {nextLevel && (
            <Text style={styles.levelSub}>{nextLevel.minPoints - stats.totalPoints} pts to {nextLevel.titleEn}</Text>
          )}
          <View style={styles.levelStats}>
            <View style={styles.levelStat}>
              <Text style={styles.levelStatVal}>{stats.totalPoints}</Text>
              <Text style={styles.levelStatLbl}>pts</Text>
            </View>
            <View style={styles.levelStatDiv} />
            <View style={styles.levelStat}>
              <Text style={styles.levelStatVal}>🔥 {stats.currentStreak}</Text>
              <Text style={styles.levelStatLbl}>day streak</Text>
            </View>
            <View style={styles.levelStatDiv} />
            <View style={styles.levelStat}>
              <Text style={styles.levelStatVal}>{stats.totalTasksCompleted}</Text>
              <Text style={styles.levelStatLbl}>tasks done</Text>
            </View>
          </View>
        </View>

        {/* By category */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>BY CATEGORY</Text>
          {sortedCats.length === 0 ? (
            <Text style={styles.emptyText}>No tasks this week yet.</Text>
          ) : (
            sortedCats.map((cat) => {
              const meta = CATEGORY_META[cat];
              const hours = weekly.categoryHours[cat] ?? 0;
              const count = weekly.categoryCount[cat] ?? 0;
              const fill = hours / maxCatHours;
              return (
                <View key={cat} style={styles.catRow}>
                  <View style={styles.catLabel}>
                    <Text style={styles.catIcon}>{meta?.icon ?? '📌'}</Text>
                    <Text style={styles.catName}>{meta?.labelEn ?? cat}</Text>
                  </View>
                  <View style={styles.catBar}>
                    <View style={[styles.catBarFill, { width: `${fill * 100}%`, backgroundColor: meta?.color ?? BRAND.inkFaint }]} />
                  </View>
                  <Text style={styles.catStats}>{count}x · {hours.toFixed(1)}h</Text>
                </View>
              );
            })
          )}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  scroll: { padding: 16, gap: 12 },

  levelCard: { borderRadius: RADIUS.card, padding: 20, backgroundColor: BRAND.sunGold, ...SHADOWS.button },
  levelTitle: { fontSize: 22, fontFamily: FONTS.display, color: BRAND.creamCard, marginBottom: 12 },
  levelBar: {
    height: 6, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 3,
    overflow: 'hidden', marginBottom: 6,
  },
  levelBarFill: { height: '100%', backgroundColor: BRAND.creamCard, borderRadius: 3 },
  levelSub: { fontSize: 12, fontFamily: FONTS.body, color: 'rgba(255,255,255,0.7)', marginBottom: 16 },
  levelStats: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  levelStat: { alignItems: 'center', flex: 1 },
  levelStatVal: { fontSize: 18, fontFamily: FONTS.bodyHeavy, color: BRAND.creamCard },
  levelStatLbl: { fontSize: 11, fontFamily: FONTS.body, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  levelStatDiv: { width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.25)' },

  card: { backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card, padding: 16, ...SHADOWS.card },
  cardLabel: { fontSize: 11, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft, letterSpacing: 0.5, marginBottom: 12 },

  catRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  catLabel: { flexDirection: 'row', alignItems: 'center', gap: 4, width: 84 },
  catIcon: { fontSize: 15 },
  catName: { fontSize: 12, fontFamily: FONTS.bodySemi, color: BRAND.warmInk, flex: 1 },
  catBar: { flex: 1, height: 8, backgroundColor: BRAND.line, borderRadius: 4, overflow: 'hidden' },
  catBarFill: { height: '100%', borderRadius: 4 },
  catStats: { fontSize: 11, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft, width: 56, textAlign: 'right' },
  emptyText: { fontSize: 13, fontFamily: FONTS.body, color: BRAND.inkSoft, textAlign: 'center', paddingVertical: 12 },
});
