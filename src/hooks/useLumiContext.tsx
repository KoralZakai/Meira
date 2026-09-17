import React, { createContext, useContext } from 'react';
import { useDailyCheckIn } from './useDailyCheckIn';
import { useTasks } from './useTasks';

interface LumiContextValue {
  tasksState: ReturnType<typeof useTasks>;
  checkInState: ReturnType<typeof useDailyCheckIn>;
}

const LumiContext = createContext<LumiContextValue | null>(null);

export function LumiProvider({ children }: { children: React.ReactNode }) {
  const tasksState = useTasks();
  const checkInState = useDailyCheckIn();

  return (
    <LumiContext.Provider
      value={{
        tasksState,
        checkInState,
      }}
    >
      {children}
    </LumiContext.Provider>
  );
}

export function useLumiContext() {
  const context = useContext(LumiContext);
  if (!context) {
    throw new Error('useLumiContext must be used inside LumiProvider');
  }
  return context;
}
