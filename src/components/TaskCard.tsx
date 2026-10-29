/** TaskCard — the main task card: priority bar, time, badges, swipe complete/postpone. */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Task, TaskLocation } from '../types/index';
import { BRAND, COLORS, CATEGORY_META, PRIORITY_META, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { addMinutes, formatShortDate } from '../utils/timeUtils';

interface Props {
  task: Task;
  onComplete: (task: Task) => void;
  onPostpone: (task: Task) => void;
  onPress: (task: Task) => void;
}

export function TaskCard({ task, onComplete, onPostpone, onPress }: Props) {
  const category = CATEGORY_META[task.category || 'general'] || CATEGORY_META.general;
  const priority = PRIORITY_META[task.priority || 'nice_to_do'] || PRIORITY_META.nice_to_do;

  // Show "start – end" when the task has a start time and a known duration,
  // so a "from 15:00 to 23:00" task reads as a block instead of a single time.
  const startTime = task.scheduledTime || task.fixedTime;
  const hourLabel = startTime
    ? task.durationMinutes
      ? `${startTime} – ${addMinutes(startTime, task.durationMinutes)}`
      : startTime
    : null;
  // Every card shows its date + hour ("Tomorrow · 10:00 – 11:30").
  const dateLabel = formatShortDate(task.date);
  const timeLabel = [dateLabel, hourLabel].filter(Boolean).join(' · ') || null;

  const renderRightActions = () => (
    <View style={styles.swipeActions}>
      <RectButton style={styles.postponeAction} onPress={() => onPostpone(task)}>
        <Text style={styles.swipeText}>📅</Text>
      </RectButton>
      <RectButton style={styles.completeAction} onPress={() => onComplete(task)}>
        <Text style={styles.swipeText}>✓</Text>
      </RectButton>
    </View>
  );

  return (
    <Swipeable renderRightActions={renderRightActions} overshootRight={false}>
      <Pressable
        onLongPress={() => onPress(task)}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={[styles.priorityBar, { backgroundColor: priority.color }]} />

        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.timeAndCategory}>
              {timeLabel && (
                <Text style={styles.time}>{timeLabel}</Text>
              )}
              <View style={[styles.categoryBadge, { backgroundColor: category.color }]}>
                <Text style={styles.categoryIcon}>{category.icon}</Text>
              </View>
            </View>
          </View>

          <Text
            style={[
              styles.taskText,
              task.isFixed && styles.taskTextBold,
              task.status === 'complete' && styles.taskTextComplete,
            ]}
            numberOfLines={2}
          >
            {task.text}
          </Text>

          <Text style={styles.duration}>~{task.durationMinutes} min</Text>

          {/* Details row */}
          <View style={styles.detailsRow}>
            {task.location && (
              <Text style={styles.detail}>📍 {typeof task.location === 'string' ? task.location : (task.location.displayName || task.location.address)}</Text>
            )}
            {task.contact && <Text style={styles.detail}>👤 {task.contact.name}</Text>}
            {task.gmailThreadId && <Text style={styles.detail}>📧 Gmail</Text>}
            {!task.gmailThreadId && /^(gcal|ocal)-/.test(task.id) && <Text style={styles.detail}>📅</Text>}
            {task.verifiedArrival && <Text style={styles.detail}>✅ Arrived</Text>}
          </View>

          {/* Subtasks progress */}
          {task.subtasks && task.subtasks.length > 0 && (
            <View style={styles.subtasksProgress}>
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${((task.subtasks.filter(s => s.status === 'complete').length) / task.subtasks.length) * 100}%`,
                    },
                  ]}
                />
              </View>
              <Text style={styles.subtasksText}>
                {task.subtasks.filter(s => s.status === 'complete').length}/{task.subtasks.length} subtasks
              </Text>
            </View>
          )}
        </View>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    marginHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: SHADOWS.card.shadowColor,
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardPressed: {
    opacity: 0.7,
  },
  priorityBar: {
    width: 4,
  },
  content: {
    flex: 1,
    padding: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  timeAndCategory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  time: {
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
  categoryBadge: {
    width: 28,
    height: 28,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryIcon: {
    fontSize: 14,
  },
  taskText: {
    fontSize: 15,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
    marginBottom: 6,
  },
  taskTextBold: {
    fontFamily: FONTS.bodyBold,
  },
  taskTextComplete: {
    textDecorationLine: 'line-through',
    color: BRAND.inkSoft,
  },
  duration: {
    fontSize: 13,
    color: BRAND.inkSoft,
    marginBottom: 8,
  },
  detailsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  detail: {
    fontSize: 12,
    color: BRAND.inkSoft,
    paddingVertical: 2,
  },
  subtasksProgress: {
    gap: 4,
  },
  progressBar: {
    height: 4,
    backgroundColor: BRAND.line,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: BRAND.sunGold,
  },
  subtasksText: {
    fontSize: 11,
    color: BRAND.inkSoft,
  },
  swipeActions: {
    flexDirection: 'row',
    gap: 0,
  },
  postponeAction: {
    backgroundColor: COLORS.warning,
    justifyContent: 'center',
    alignItems: 'center',
    width: 60,
  },
  completeAction: {
    backgroundColor: BRAND.success,
    justifyContent: 'center',
    alignItems: 'center',
    width: 60,
  },
  swipeText: {
    fontSize: 20,
  },
});
