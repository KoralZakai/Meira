/** PriorityGroupedTasks — tasks grouped under MUST/HAVE-TO/... priority headers. */
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Task, TaskPriority } from '../types/index';
import { BRAND, PRIORITY_META, FONTS } from '../constants/theme';
import { TaskCard } from './TaskCard';

interface Props {
  tasks: Task[];
  onComplete: (task: Task) => void;
  onPostpone: (task: Task) => void;
  onPress: (task: Task) => void;
}

const PRIORITY_ORDER: TaskPriority[] = ['must', 'have_to', 'need_to', 'nice_to_do'];
const PRIORITY_ICONS = {
  must: '🔴',
  have_to: '🟠',
  need_to: '🟡',
  nice_to_do: '🟢',
};

export function PriorityGroupedTasks({
  tasks,
  onComplete,
  onPostpone,
  onPress,
}: Props) {
  const groupedByPriority = PRIORITY_ORDER.reduce((acc, priority) => {
    acc[priority] = tasks.filter(t => t.priority === priority);
    return acc;
  }, {} as Record<TaskPriority, Task[]>);

  return (
    <View style={styles.container}>
      {PRIORITY_ORDER.map((priority) => {
        const groupTasks = groupedByPriority[priority];
        if (groupTasks.length === 0) return null;

        const meta = PRIORITY_META[priority];
        const icon = PRIORITY_ICONS[priority];

        return (
          <View key={priority} style={styles.priorityGroup}>
            <View style={styles.priorityHeader}>
              <Text style={styles.priorityIcon}>{icon}</Text>
              <Text style={styles.priorityLabel}>{meta.labelEn.toUpperCase()}</Text>
            </View>
            <View style={styles.tasksList}>
              {groupTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onComplete={onComplete}
                  onPostpone={onPostpone}
                  onPress={onPress}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 16,
  },
  priorityGroup: {
    gap: 8,
  },
  priorityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  priorityIcon: {
    fontSize: 16,
  },
  priorityLabel: {
    fontSize: 13,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    letterSpacing: 0.5,
  },
  tasksList: {
    paddingHorizontal: 16,
    gap: 8,
  },
});
