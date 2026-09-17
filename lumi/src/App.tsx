// App shell: onboarding gate → responsive switch between the desktop shell
// (sidebar + screen + AI inbox) and the mobile app (swipeable, bottom tabs).
import { useState } from 'react';
import type { ScreenId } from './types';
import { useLumi } from './store';
import { useIsMobile } from './lib/useMediaQuery';
import { Sidebar } from './components/Sidebar';
import { AIInbox } from './components/AIInbox';
import { TaskDetail } from './components/TaskDetail';
import { Onboarding } from './screens/Onboarding';
import { Dashboard } from './screens/Dashboard';
import { AIChat } from './screens/AIChat';
import { Tasks } from './screens/Tasks';
import { Calendar } from './screens/Calendar';
import { Focus } from './screens/Focus';
import { Insights } from './screens/Insights';
import { Settings } from './screens/Settings';
import { MobileApp } from './mobile/MobileApp';

const SCREENS: Record<ScreenId, () => JSX.Element> = {
  dashboard: Dashboard,
  chat: AIChat,
  tasks: Tasks,
  calendar: Calendar,
  focus: Focus,
  insights: Insights,
  settings: Settings,
};

export default function App() {
  const onboarded = useLumi((s) => s.onboarded);
  const isMobile = useIsMobile();
  const [screen, setScreen] = useState<ScreenId>('dashboard');
  const [inboxOpen, setInboxOpen] = useState(true);

  if (!onboarded) return <Onboarding />;
  if (isMobile) return <MobileApp />;

  const Screen = SCREENS[screen];

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <Sidebar
        screen={screen}
        onNavigate={setScreen}
        onToggleInbox={() => setInboxOpen((v) => !v)}
      />
      <main className="flex-1 overflow-y-auto">
        <Screen />
      </main>
      {inboxOpen && screen !== 'chat' && <AIInbox onClose={() => setInboxOpen(false)} />}
      <TaskDetail />
    </div>
  );
}
