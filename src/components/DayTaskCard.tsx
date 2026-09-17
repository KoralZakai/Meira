/** DayTaskCard — compact task card used inside day timelines. */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Task, AppLanguage } from '../types';
import { BRAND, COLORS, PRIORITY_META, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { formatDuration, addMinutes, formatShortDate } from '../utils/timeUtils';

// Timeline scale: each minute ≈ this many px, clamped so cards stay readable.
const PX_PER_MIN = 1.0;
const MIN_CARD_HEIGHT = 58;
const MAX_CARD_HEIGHT = 200;

interface DayTaskCardProps {
  task: Task;
  onTap: (task: Task) => void;
  /** Hold to open the full editor — tap is for reading, hold is for changing. */
  onHold?: (task: Task) => void;
  onComplete?: (task: Task) => void;
  showVerificationBadge?: boolean;
  language: AppLanguage;
}

export default function DayTaskCard({
  task,
  onTap,
  onHold,
  onComplete,
  showVerificationBadge = false,
  language,
}: DayTaskCardProps) {
  const [scaleAnim] = useState(new Animated.Value(1));
  const cardBg = BRAND.creamCard;
  const doneBg = BRAND.line;
  const textColor = BRAND.warmInk;
  const subColor = BRAND.inkSoft;
  const categoryMeta = getCategoryMeta(task.category);
  const priorityMeta = PRIORITY_META[task.priority ?? 'need_to'] || PRIORITY_META.need_to;

  const isCompleted = task.status === 'complete';
  const isMissed = task.status === 'missed';
  // Show the planned hour: a fixed time wins, otherwise the time Lumi scheduled.
  const startLabel = task.fixedTime || task.scheduledTime || '';
  const duration = task.durationMinutes || 0;
  const endLabel = startLabel && duration > 0 ? addMinutes(startLabel, duration) : '';
  const dateLabel = formatShortDate(task.date, language === 'he' ? 'he' : 'en');
  const locationLabel =
    typeof task.location === 'string'
      ? task.location
      : task.location?.displayName || task.location?.address || '';

  // Card height scales with how long the task takes — like a real day planner.
  const cardHeight = Math.max(
    MIN_CARD_HEIGHT,
    Math.min(MAX_CARD_HEIGHT, Math.round(duration * PX_PER_MIN) || MIN_CARD_HEIGHT),
  );

  const handleComplete = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.95, duration: 100, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start(() => {
      onComplete?.(task);
    });
  };

  return (
    <Animated.View style={[styles.row, { transform: [{ scale: scaleAnim }] }]}>
      {/* Time gutter — date above the hour so every card shows both */}
      <View style={styles.gutter}>
        {dateLabel ? <Text style={[styles.gutterDate, { color: subColor }]}>{dateLabel}</Text> : null}
        <Text style={[styles.gutterStart, { color: categoryMeta.color }]}>
          {startLabel || '—'}
        </Text>
        {endLabel ? <Text style={[styles.gutterEnd, { color: subColor }]}>{endLabel}</Text> : null}
      </View>

      {/* Task block — height proportional to duration */}
      <TouchableOpacity
        onPress={() => onTap(task)}
        onLongPress={() => (onHold ?? onTap)(task)}
        delayLongPress={350}
        activeOpacity={0.8}
        style={[
          styles.card,
          {
            minHeight: cardHeight,
            backgroundColor: isCompleted ? doneBg : cardBg,
            opacity: isCompleted ? 0.6 : 1,
            borderLeftColor: categoryMeta.color,
          },
        ]}
      >
        <View style={styles.cardTop}>
          <Text style={styles.categoryIcon}>{categoryMeta.icon}</Text>
          <Text
            style={[
              styles.taskTitle,
              {
                textDecorationLine: isCompleted ? 'line-through' : 'none',
                color: isCompleted ? subColor : textColor,
              },
            ]}
            numberOfLines={2}
          >
            {task.text}
          </Text>

          {onComplete ? (
            <TouchableOpacity
              onPress={handleComplete}
              style={[
                styles.checkCircle,
                isCompleted && styles.checkCircleDone,
                isMissed && !isCompleted && styles.checkCircleMissed,
              ]}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={isCompleted ? styles.checkCircleTextDone : styles.checkCircleText}>
                {isCompleted ? '✓' : isMissed ? '✕' : ''}
              </Text>
            </TouchableOpacity>
          ) : isCompleted && showVerificationBadge ? (
            <View style={styles.verificationBadge}>
              <Text style={styles.verificationIcon}>✓</Text>
            </View>
          ) : null}
        </View>

        {/* Compact meta line: duration + priority + location */}
        <View style={styles.metaRow}>
          <Text style={[styles.metaText, { color: subColor }]}>⏱️ {formatDuration(duration, language)}</Text>
          <View style={[styles.priorityDot, { backgroundColor: priorityMeta.color }]} />
          <Text style={[styles.metaText, { color: subColor }]} numberOfLines={1}>
            {language === 'he' ? priorityMeta.labelHe : priorityMeta.labelEn}
          </Text>
          {locationLabel ? (
            <Text style={[styles.metaText, styles.metaLocation, { color: subColor }]} numberOfLines={1}>
              📍 {locationLabel}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  gutter: {
    width: 52,
    alignItems: 'flex-end',
    paddingRight: 8,
    paddingTop: 6,
  },
  gutterDate: {
    fontSize: 10,
    fontFamily: FONTS.bodySemi,
    marginBottom: 1,
  },
  gutterStart: {
    fontSize: 13,
    fontFamily: FONTS.bodyHeavy,
  },
  gutterEnd: {
    fontSize: 11,
    color: BRAND.inkSoft,
    marginTop: 2,
  },
  card: {
    flex: 1,
    borderRadius: RADIUS.chip,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderLeftWidth: 4,
    backgroundColor: BRAND.creamCard,
    justifyContent: 'center',
    shadowColor: SHADOWS.card.shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  taskTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
  verificationBadge: {
    width: 22,
    height: 22,
    borderRadius: RADIUS.chip,
    backgroundColor: BRAND.success,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  verificationIcon: {
    color: 'white',
    fontFamily: FONTS.bodyBold,
    fontSize: 13,
  },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: RADIUS.chip,
    borderWidth: 2,
    borderColor: BRAND.line,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  checkCircleDone: {
    backgroundColor: BRAND.success,
    borderColor: BRAND.success,
  },
  checkCircleMissed: {
    borderColor: COLORS.danger,
  },
  checkCircleText: {
    color: COLORS.danger,
    fontFamily: FONTS.bodyBold,
    fontSize: 13,
  },
  checkCircleTextDone: {
    color: 'white',
    fontFamily: FONTS.bodyBold,
    fontSize: 14,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 5,
  },
  metaText: {
    fontSize: 11,
    color: BRAND.inkSoft,
    marginRight: 8,
  },
  metaLocation: {
    flex: 1,
  },
  priorityDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 5,
  },
});
