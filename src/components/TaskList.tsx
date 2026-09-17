/** TaskList — scrollable list of TaskItem/TaskCard rows. */
import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import { Task } from '../types/models';
import { TaskItem } from './TaskItem';

interface Props {
  tasks: Task[];
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onEdit: (task: Task) => void;
  emptyText?: string;
}

export function TaskList({ tasks, onToggle, onDelete, onEdit, emptyText = 'No tasks yet.' }: Props) {
  if (!tasks.length) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{emptyText}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={tasks}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <TaskItem task={item} onToggle={onToggle} onDelete={onDelete} onEdit={onEdit} />
      )}
      scrollEnabled={false}
    />
  );
}

const styles = StyleSheet.create({
  emptyContainer: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyText: {
    color: BRAND.inkSoft,
    fontSize: 15,
  },
});
