import { CheckInType } from './models';
import { Task } from './index';

export type CheckInFlowMode = 'review' | 'capture';

export type RootStackParamList = {
  Onboarding: undefined;
  ProfileEdit: undefined;
  MainTabs: undefined;
  Home: undefined;
  Goals: undefined;
  Stats: undefined;
  Trips: undefined;
  Analytics: undefined;
  /** Find time together (Feature 3): no groupId = her groups + new; with = one group. */
  FindTime: { groupId?: string } | undefined;
  /** initialText: a suggestion picked on Today, put in the box for her to confirm. */
  AddTask: { initialTime?: string; initialUntil?: string; initialDate?: string; initialText?: string } | undefined;
  TaskDetail: { taskId: string };
  CheckIn: {
    type: CheckInType;
    mandatory?: boolean;
    flow?: CheckInFlowMode;
  };
  Settings: undefined;
  SettingsMenu: undefined;
  Agents: undefined;
  CoachChat: { initialText?: string } | undefined;
  FocusNow: { task: Task };
  DayReview: undefined;
  PersonalityQuiz: undefined;
  PersonalityHandoff: { token: string };
  PlanTomorrow: undefined;
  /** Leave-now focus screen: countdown + route for ONE task. */
  LeaveNow: { task: Task; isFirstOfDay?: boolean };
};

export type MainTabsParamList = {
  /** The chat with Meira IS home (v3, 27.10). */
  Meira: undefined;
  /** From the home tiles: which day to open, and a nonce so the same tile works twice. */
  Today: { day?: 'today' | 'tomorrow' | 'pick'; nonce?: number } | undefined;
  Tasks: undefined;
  Trips: undefined;
};
