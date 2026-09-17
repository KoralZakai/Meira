// Re-export from index.ts for backward compatibility
import type { AppLanguage, Task } from './index';
export type {
  TaskCategory,
  TaskPriority,
  TaskStatus,
  TransportType,
  AppLanguage,
  AppTheme,
  TransitLeg,
  TransitPlan,
  TaskLocation,
  TaskContact,
  Subtask,
  Task,
  Goal,
  DailyLog,
  DailySchedule,
  UserProfile,
  UserStats,
  RewardEvent,
  CalendarEvent,
  GapSuggestion,
} from './index';

export type CheckInType = 'morning' | 'afternoon' | 'evening';

export interface TimeSetting {
  hour: number;
  minute: number;
}

export interface AppSettings {
  morningTime: TimeSetting;
  afternoonTime: TimeSetting;
  eveningTime: TimeSetting;
  androidMorningWindowStart: number;
  androidMorningWindowEnd: number;
  language: AppLanguage;
  // WhatsApp number used to link this device to the bot for push notifications.
  whatsAppPhone?: string;
  /**
   * Whether a real Android system alarm (the loud clock alarm) is set for
   * wake-ups. The wake NOTIFICATION always fires; this controls only the
   * ring-through-silent alarm on top of it. Default on — a wake-up you have to
   * be awake to see is not a wake-up — but some people keep their own alarm and
   * want Lumi to stay quiet. Undefined counts as on (existing installs).
   */
  wakeAlarmEnabled?: boolean;
}

export interface BacklogGroup {
  date: string;
  tasks: Task[];
}

export type AgentIntent =
  | 'add_tasks'
  | 'check_in'
  | 'task_update'
  | 'conflict'
  | 'optimize'
  | 'wake_up'
  | 'profile_update'
  | 'empty_list'
  | 'classify_group';
