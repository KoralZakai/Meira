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
  AddTask: { initialTime?: string; initialDate?: string } | undefined;
  TaskDetail: { taskId: string };
  CheckIn: {
    type: CheckInType;
    mandatory?: boolean;
    flow?: CheckInFlowMode;
  };
  Settings: undefined;
  SettingsMenu: undefined;
  Agents: undefined;
  CoachChat: undefined;
  FocusNow: { task: Task };
  DayReview: undefined;
  PersonalityQuiz: undefined;
  PersonalityHandoff: { token: string };
  PlanTomorrow: undefined;
  /** Leave-now focus screen: countdown + route for ONE task. */
  LeaveNow: { task: Task; isFirstOfDay?: boolean };
};

export type MainTabsParamList = {
  Today: undefined;
  Tasks: undefined;
  Trips: undefined;
  Profile: undefined;
};
