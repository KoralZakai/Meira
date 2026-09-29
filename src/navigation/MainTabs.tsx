import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import CustomTabBar from '../components/CustomTabBar';
import TodaySchedule from '../screens/TodaySchedule';
import MyTasks from '../screens/MyTasks';
import TripsScreen from '../screens/TripsScreen';
import { MainTabsParamList } from '../types/navigation';

const Tab = createBottomTabNavigator<MainTabsParamList>();

export default function MainTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      {/* Today IS the timeline. It owns the day chips (today / tomorrow / any
          date) that were the Timeline tab's only unique capability. */}
      <Tab.Screen name="Today" component={TodaySchedule} options={{ tabBarLabel: 'Today', tabBarIcon: '☀️' } as any} />
      <Tab.Screen name="Trips" component={TripsScreen} options={{ tabBarLabel: 'Trips', tabBarIcon: '🗺️' } as any} />
      <Tab.Screen name="Tasks" component={MyTasks} options={{ tabBarLabel: 'Tasks', tabBarIcon: '☑️' } as any} />
      {/* Profile is not a tab any more: ☰ Menu in the tab bar opens it as a
          sheet (design handoff "Calm Today", 2026-09-28). */}
    </Tab.Navigator>
  );
}
