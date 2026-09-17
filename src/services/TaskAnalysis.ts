/**
 * TaskAnalysis — pure aggregation over ParsedTask[]: duration estimates,
 * totals, and what's missing before scheduling.
 *
 * Dependencies: TaskParser (ParsedTask type only). No I/O.
 */
import { ParsedTask } from './TaskParser';

/** Per-task duration estimate with its source (default/learned/user). */
export interface TaskEstimate {
  text: string;
  minutes: number;
  reason: string;
}

/** Aggregate view over parsed tasks: totals, estimates, missing info. */
export interface TaskAnalysis {
  estimates: TaskEstimate[];
  totalMinutes: number;
  suggestedApproach: string[];
  spokenSummary: string;
}

const KEYWORD_MINUTES: Array<{ keywords: string[]; minutes: number; reason: string }> = [
  { keywords: ['call', 'phone', 'email', 'reply', 'message'], minutes: 15, reason: 'quick communication' },
  { keywords: ['shop', 'buy', 'groceries', 'order', 'pay'], minutes: 30, reason: 'errand task' },
  { keywords: ['clean', 'cook', 'laundry', 'organize'], minutes: 35, reason: 'household task' },
  { keywords: ['exercise', 'workout', 'run', 'walk'], minutes: 40, reason: 'health routine' },
  { keywords: ['study', 'learn', 'read', 'write', 'build', 'code', 'project'], minutes: 60, reason: 'focus work' },
  { keywords: ['meeting', 'review', 'plan', 'report'], minutes: 45, reason: 'planning work' },
];

function estimateTaskMinutes(task: ParsedTask): TaskEstimate {
  const normalized = task.text.toLowerCase();

  for (const bucket of KEYWORD_MINUTES) {
    if (bucket.keywords.some((keyword) => normalized.includes(keyword))) {
      return {
        text: task.text,
        minutes: bucket.minutes,
        reason: bucket.reason,
      };
    }
  }

  const inferredMinutes = task.text.length <= 26 ? 20 : 35;
  return {
    text: task.text,
    minutes: inferredMinutes,
    reason: 'general task',
  };
}

function toHoursMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

/** Pure aggregation of ParsedTask[] into a TaskAnalysis. */
export function analyzeTasks(tasks: ParsedTask[]): TaskAnalysis {
  const estimates = tasks.map(estimateTaskMinutes).sort((a, b) => a.minutes - b.minutes);
  const totalMinutes = estimates.reduce((sum, item) => sum + item.minutes, 0);

  const quickWins = estimates.filter((item) => item.minutes <= 20).length;
  const deepTasks = estimates.filter((item) => item.minutes >= 45).length;

  const suggestedApproach: string[] = [
    quickWins > 0
      ? `Start with ${quickWins} quick win${quickWins > 1 ? 's' : ''} to build momentum.`
      : 'Start with one medium task to build momentum.',
    deepTasks > 0
      ? `Reserve ${deepTasks} focus block${deepTasks > 1 ? 's' : ''} for deep tasks.`
      : 'Use one 30-minute focus block for your hardest task.',
    'Leave a 10-minute buffer between blocks for transitions.',
  ];

  return {
    estimates,
    totalMinutes,
    suggestedApproach,
    spokenSummary: `I estimate ${tasks.length} tasks will take about ${toHoursMinutes(totalMinutes)} in total.`,
  };
}
