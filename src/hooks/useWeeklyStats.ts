/** useWeeklyStats — aggregates 7-day completion stats for charts. Depends on TaskStorage. */
import { useState, useEffect } from 'react';
import { UserStats, TaskCategory } from '../types/index';
import * as TaskStorage from '../services/TaskStorage';

export interface WeeklyStatsData {
  categoryHours: Partial<Record<TaskCategory, number>>;
  categoryCount: Partial<Record<TaskCategory, number>>;
  totalHours: number;
  totalTasks: number;
  completionRate: number;
}

export function useWeeklyStats() {
  const [stats, setStats] = useState<WeeklyStatsData>({
    categoryHours: {},
    categoryCount: {},
    totalHours: 0,
    totalTasks: 0,
    completionRate: 0,
  });

  useEffect(() => {
    const loadWeeklyStats = async () => {
      const userStats = await TaskStorage.loadStats();
      const hours = userStats.weeklyHoursByCategory || {};
      const counts = userStats.weeklyTaskCountByCategory || {};

      const totalHours = Object.values(hours).reduce((sum, h) => sum + (h || 0), 0);
      const totalTasks = Object.values(counts).reduce((sum, c) => sum + (c || 0), 0);
      const completionRate = userStats.totalTasksCompleted > 0
        ? Math.round((userStats.totalTasksOnTime / userStats.totalTasksCompleted) * 100)
        : 0;

      setStats({
        categoryHours: hours,
        categoryCount: counts,
        totalHours: Math.round(totalHours * 10) / 10,
        totalTasks,
        completionRate,
      });
    };

    loadWeeklyStats();
  }, []);

  return stats;
}
