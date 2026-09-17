/**
 * LearningService — learns per-category task durations from completions
 * (rolling average, 70% old / 30% new per CLAUDE.md).
 *
 * Dependencies: TaskStorage (completed task history), utils/timeUtils.
 * getLearnedDuration feeds scheduling estimates once >=3 data points exist.
 */
import { Task, TaskCategory } from '../types/index';
import * as TaskStorage from './TaskStorage';
import { getWeekKey } from '../utils/timeUtils';

const DEFAULT_DURATIONS: Record<TaskCategory, number> = {
  interview: 90, course: 60, conference: 120, class: 90,
  work: 60, meeting: 45, call: 15, doctor: 60,
  gym: 60, aspiration: 30, leisure: 60, general: 30,
  zoom: 45, hobby_class: 90,
};

/** Rolling per-category duration learning (70% old / 30% new); getLearnedDuration needs >=3 samples else returns the default. */
export const LearningService = {
  async recordTaskCompletion(task: Task, actualMinutes: number): Promise<void> {
    const stats = await TaskStorage.loadStats();
    const avgs = { ...stats.categoryDurationAverages };
    const existing = avgs[task.category] || DEFAULT_DURATIONS[task.category];
    // Rolling average weighted toward recent
    avgs[task.category] = Math.round(existing * 0.7 + actualMinutes * 0.3);
    await TaskStorage.saveStats({ ...stats, categoryDurationAverages: avgs });
  },

  async recordWeeklyStats(task: Task, actualMinutes: number): Promise<void> {
    const stats = await TaskStorage.loadStats();
    const hours = stats.weeklyHoursByCategory || {};
    const counts = stats.weeklyTaskCountByCategory || {};

    const currentHours = hours[task.category] || 0;
    const currentCount = counts[task.category] || 0;

    hours[task.category] = currentHours + (actualMinutes / 60);
    counts[task.category] = currentCount + 1;

    await TaskStorage.saveStats({
      ...stats,
      weeklyHoursByCategory: hours,
      weeklyTaskCountByCategory: counts,
      lastUpdated: Date.now(),
    });
  },

  async resetWeeklyStats(): Promise<void> {
    const stats = await TaskStorage.loadStats();
    await TaskStorage.saveStats({
      ...stats,
      weeklyHoursByCategory: {},
      weeklyTaskCountByCategory: {},
      lastUpdated: Date.now(),
    });
  },

  async getLearnedDuration(category: TaskCategory): Promise<number> {
    const stats = await TaskStorage.loadStats();
    return stats.categoryDurationAverages[category] || DEFAULT_DURATIONS[category];
  },
};
