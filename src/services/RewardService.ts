/**
 * RewardService — gamification: awards points per the CLAUDE.md table,
 * levels, streaks, and reward events.
 *
 * Dependencies: TaskStorage (stats persistence), constants/theme
 * (POINTS, LEVELS). Consumed by task-complete flows and StatsScreen.
 */
import { UserStats, RewardEvent, AppLanguage } from '../types/index';
import * as TaskStorage from './TaskStorage';
import { POINTS, LEVELS } from '../constants/theme';

/** Awards points/levels/streaks per the CLAUDE.md gamification table and persists via TaskStorage. */
export const RewardService = {
  getLevelForPoints(points: number): number {
    return [...LEVELS].reverse().find(l => points >= l.minPoints)?.level || 1;
  },

  async awardPoints(
    type: RewardEvent['type'],
    stats: UserStats,
    language: AppLanguage,
    context?: string
  ): Promise<{ stats: UserStats; leveledUp: boolean; newLevel?: number }> {
    const pointsMap: Record<string, number> = {
      task_complete: POINTS.task_complete,
      on_time: POINTS.on_time,
      arrival: POINTS.verified_arrival,
      streak: POINTS.streak_bonus * Math.min(stats.currentStreak, 5),
      level_up: 0,
      perfect_day: POINTS.perfect_day,
    };
    const earned = pointsMap[type] || 0;
    const oldLevel = stats.level;
    const newStats: UserStats = {
      ...stats,
      totalPoints: stats.totalPoints + earned,
      totalTasksCompleted: type === 'task_complete' ? stats.totalTasksCompleted + 1 : stats.totalTasksCompleted,
      totalTasksOnTime: type === 'on_time' ? stats.totalTasksOnTime + 1 : stats.totalTasksOnTime,
      level: this.getLevelForPoints(stats.totalPoints + earned),
      lastUpdated: Date.now(),
    };
    const leveledUp = newStats.level > oldLevel;
    const messages: Record<string, { en: string; he: string }> = {
      task_complete: { en: `Task done! +${earned} pts`, he: `משימה הושלמה! +${earned} נק'` },
      on_time: { en: `On time! +${earned} pts 🎯`, he: `בזמן! +${earned} נק' 🎯` },
      arrival: { en: `Arrived! +${earned} pts 📍`, he: `הגעת! +${earned} נק' 📍` },
      perfect_day: { en: `Perfect day! +${earned} pts 👑`, he: `יום מושלם! +${earned} נק' 👑` },
      streak: { en: `Streak bonus! +${earned} pts 🔥`, he: `בונוס streak! +${earned} נק' 🔥` },
    };
    const msg = messages[type] || { en: `+${earned} pts`, he: `+${earned} נק'` };
    await TaskStorage.saveRewardEvent({
      id: Math.random().toString(36).substr(2),
      type,
      points: earned,
      message: msg.en,
      messageHe: msg.he,
      timestamp: Date.now(),
    });
    await TaskStorage.saveStats(newStats);
    return { stats: newStats, leveledUp, newLevel: leveledUp ? newStats.level : undefined };
  },
};
