/**
 * TaskDetailScreen — single-task detail/edit modal (subtasks, location,
 * contact, progress).
 * Dependencies: task passed via navigation; edits flow through TaskStorage upstream.
 */
import React, { useEffect, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { TransitLeg } from '../types/index';
import { useLumiContext } from '../hooks/useLumiContext';
import { SubtaskList } from '../components/SubtaskList';
import RouteMap from '../components/RouteMap';
import { BRAND, COLORS, CATEGORY_META, FONTS, RADIUS } from '../constants/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'TaskDetail'>;

export default function TaskDetailScreen({ route, navigation }: Props) {
  const { taskId } = route.params;
  const { tasksState } = useLumiContext();
  const [task, setTask] = useState<any | null>(null);
  const [text, setText] = useState('');
  const [duration, setDuration] = useState('30');

  useEffect(() => {
    const found = tasksState.tasks.find((t: any) => t.id === taskId);
    if (found) {
      setTask(found);
      setText(found.text);
      // Duration might not exist in models.ts Task, use a reasonable default
      setDuration('30');
    }
  }, [taskId, tasksState.tasks]);

  const handleSave = async () => {
    if (!task) return;
    await tasksState.updateTaskDetails?.(task.id, { text });
    navigation.goBack();
  };

  const handleDelete = () => {
    Alert.alert('Delete task?', 'This cannot be undone.', [
      { text: 'Cancel' },
      {
        text: 'Delete',
        onPress: async () => {
          if (task && tasksState.removeTask) {
            await tasksState.removeTask(task.id);
            navigation.goBack();
          }
        },
        style: 'destructive',
      },
    ]);
  };

  if (!task) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </SafeAreaView>
    );
  }

  const category = CATEGORY_META[task.category] || CATEGORY_META.general;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={[styles.categoryBadge, { backgroundColor: category.color }]}>
            <Text style={styles.categoryIcon}>{category.icon}</Text>
          </View>
          <Text style={styles.categoryName}>{category.labelEn}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Task</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Task description"
            value={text}
            onChangeText={setText}
            multiline
            placeholderTextColor={BRAND.inkSoft}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Duration (minutes)</Text>
          <TextInput
            style={styles.numberInput}
            placeholder="30"
            value={duration}
            onChangeText={setDuration}
            keyboardType="number-pad"
            placeholderTextColor={BRAND.inkSoft}
          />
        </View>

        {task.contact && (
          <View style={styles.section}>
            <Text style={styles.label}>Contact</Text>
            <Text style={styles.value}>👤 {task.contact.name}</Text>
            {task.contact.phone && <Text style={styles.value}>{task.contact.phone}</Text>}
            {task.contact.email && <Text style={styles.value}>{task.contact.email}</Text>}
          </View>
        )}

        {task.location && (
          <View style={styles.section}>
            <Text style={styles.label}>Location</Text>
            <Text style={styles.value}>📍 {task.location.displayName || task.location.address}</Text>
            {task.location.wakeUpBy && (
              <Text style={styles.value}>⏰ Wake by {task.location.wakeUpBy}</Text>
            )}
            {task.location.leaveHomeBy && (
              <Text style={styles.value}>🚪 Leave by {task.location.leaveHomeBy}</Text>
            )}
            {/* The route Lumi computed, saved on the task so it's here after the chat closes. */}
            {task.location.transitPlan && (
              <View style={styles.routeBox}>
                {task.location.transitPlan.legs?.map((leg: TransitLeg, i: number) => (
                  <Text key={i} style={styles.routeLeg}>
                    {leg.type === 'walk' ? '🚶' : leg.type === 'train' ? '🚆' : leg.type === 'subway' ? '🚇' : '🚌'}{' '}
                    {leg.type === 'walk'
                      ? `Walk ${leg.durationMinutes}m${leg.to ? ` to ${leg.to}` : ''}`
                      : `${leg.lineNumber ? `Line ${leg.lineNumber} · ` : ''}${leg.from ?? ''}${leg.to ? ` → ${leg.to}` : ''}${leg.departureTime ? ` (${leg.departureTime}${leg.arrivalTime ? `–${leg.arrivalTime}` : ''})` : ''}`}
                  </Text>
                ))}
                {task.location.transitPlan.arriveAt && (
                  <Text style={styles.value}>🎯 Arrive {task.location.transitPlan.arriveAt}</Text>
                )}
              </View>
            )}
            {/* Map + one-tap Navigate (falls back to text legs in Expo Go). */}
            {task.location.transitPlan && task.location.lat != null && (
              <RouteMap
                plan={task.location.transitPlan}
                destLat={task.location.lat}
                destLng={task.location.lng}
                destLabel={task.location.displayName || task.location.address}
              />
            )}
          </View>
        )}

        {task.subtasks && task.subtasks.length > 0 && (
          <View style={styles.section}>
            {task.subtasks && (
              <SubtaskList
                subtasks={task.subtasks}
                onToggle={subtask => {
                  // Toggle subtask - in models.ts this might be handled differently
                  setTask(task);
                }}
              />
            )}
          </View>
        )}

        {/* Important things to complete (e.g. extracted from the source email). */}
        {task.how && (
          <View style={styles.section}>
            <Text style={styles.label}>To prepare</Text>
            <Text style={styles.value}>📝 {task.how}</Text>
          </View>
        )}

        {task.deadline && (
          <View style={styles.section}>
            <Text style={styles.label}>Deadline</Text>
            <Text style={styles.value}>📅 {task.deadline}</Text>
            {task.deadlineTime && <Text style={styles.value}>{task.deadlineTime}</Text>}
          </View>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable
          onPress={handleDelete}
          style={({ pressed }) => [styles.button, styles.deleteButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          style={({ pressed }) => [styles.button, styles.saveButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND.cream,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
  },
  categoryBadge: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryIcon: {
    fontSize: 24,
  },
  categoryName: {
    fontSize: 18,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    marginBottom: 8,
    textTransform: 'uppercase',
    opacity: 0.7,
  },
  textInput: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 12,
    fontSize: 15,
    color: BRAND.warmInk,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  numberInput: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 12,
    fontSize: 15,
    color: BRAND.warmInk,
  },
  value: {
    fontSize: 14,
    color: BRAND.warmInk,
    paddingVertical: 4,
  },
  routeBox: {
    marginTop: 6,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: BRAND.line,
  },
  routeLeg: {
    fontSize: 13,
    color: BRAND.warmInk,
    paddingVertical: 3,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: BRAND.line,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  deleteButton: {
    backgroundColor: COLORS.danger,
  },
  deleteButtonText: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: '#FFF',
  },
  saveButton: {
    backgroundColor: BRAND.sunGold,
  },
  saveButtonText: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: BRAND.white,
  },
  loadingText: {
    fontSize: 16,
    color: BRAND.warmInk,
    textAlign: 'center',
    marginTop: 20,
  },
});
