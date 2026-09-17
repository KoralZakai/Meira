/**
 * FlexibleTasksCard — "Today's flexible tasks": the work, not the diary.
 *
 * Half of a day is things to DO and half is places to BE, and the timeline was
 * drawing both as blocks. So "Submit CV" occupied five hours of calendar
 * because Lumi had to put its guess somewhere, sat side by side with a party
 * it did not conflict with, and could not be ticked off at all.
 *
 * These live above the timeline, in one card, with checkboxes — because that
 * is the interaction. They hold no hour, block no slot and raise no clash;
 * they are a list you work down while the day happens around it.
 *
 * Drawn for whichever day is on screen, not only today — Today's header
 * carries the day chips, so this card follows them.
 *
 * Collapsed to three by default. A backlog of eleven pushes the actual day
 * below the fold, which is the failure the timeline redesign existed to fix.
 */
import React, { useState } from 'react';
import {
  LayoutAnimation, Platform, StyleSheet, Text, TouchableOpacity, UIManager, View,
} from 'react-native';
import { AppLanguage, Task } from '../types';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { sortFlexible } from '../utils/taskShape';
import TaskCheckbox from './TaskCheckbox';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const COLLAPSED_COUNT = 3;

interface Props {
  tasks: Task[];
  language: AppLanguage;
  onToggle: (task: Task) => void | Promise<void>;
  onTap?: (task: Task) => void;
  /** Long-press → the editor, same as a timeline block. */
  onHold?: (task: Task) => void;
}

export default function FlexibleTasksCard({
  tasks, language, onToggle, onTap, onHold,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const he = language === 'he';

  if (!tasks.length) return null;

  const ordered = sortFlexible(tasks);
  const doneCount = ordered.filter((t) => t.status === 'complete').length;
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED_COUNT);
  const hidden = ordered.length - shown.length;

  const toggleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(
      200, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity,
    ));
    setExpanded((v) => !v);
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        {/* Day-neutral. This card is no longer today-only — Today owns the
            day chips now, so the same card draws tomorrow's work, and
            "Today's flexible tasks" above tomorrow's timeline was a lie. The
            screen header directly above already names the day. */}
        <Text style={styles.title} numberOfLines={1}>
          {he ? 'משימות גמישות' : 'Flexible tasks'}
        </Text>
        <Text style={styles.count}>{doneCount}/{ordered.length}</Text>
      </View>
      <Text style={styles.subtitle} numberOfLines={2}>
        {he ? 'בלי שעה קבועה — מתי שנוח' : 'No fixed hour — whenever suits'}
      </Text>

      {shown.map((task) => {
        const meta = getCategoryMeta(task.category);
        const done = task.status === 'complete';
        return (
          <TouchableOpacity
            key={task.id}
            style={styles.row}
            activeOpacity={onTap ? 0.7 : 1}
            onPress={() => onTap?.(task)}
            onLongPress={() => (onHold ?? onTap)?.(task)}
            delayLongPress={350}
          >
            <TaskCheckbox
              done={done}
              size={26}
              onToggle={() => onToggle(task)}
            />
            <View style={styles.rowText}>
              <Text
                style={[styles.rowTitle, done && styles.rowTitleDone]}
                numberOfLines={2}
              >
                {meta.icon}  {task.text}
              </Text>
              {task.deadline || task.durationMinutes ? (
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {task.durationMinutes ? `~${task.durationMinutes} ${he ? 'דק׳' : 'min'}` : ''}
                  {task.deadline ? `${task.durationMinutes ? '  ·  ' : ''}⏳ ${task.deadline}` : ''}
                </Text>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}

      {hidden > 0 || expanded ? (
        <TouchableOpacity style={styles.more} onPress={toggleExpand} activeOpacity={0.8}>
          <Text style={styles.moreText} numberOfLines={1}>
            {expanded
              ? (he ? '▴ פחות' : '▴ Show less')
              : (he ? `▾ עוד ${hidden}` : `▾ ${hidden} more`)}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.card - 2,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    marginBottom: 14,
    gap: 2,
    // The floating work sits ABOVE the timeline and is the first thing on the
    // day, so it carries the brand edge — a neutral hairline made it read as
    // a footnote to the schedule rather than the other half of it.
    borderLeftWidth: 4,
    borderLeftColor: BRAND.sunGold,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: {
    flex: 1, flexShrink: 1, minWidth: 0,
    fontFamily: FONTS.serif, fontSize: 16, color: BRAND.warmInk,
  },
  count: {
    flexShrink: 0, fontFamily: FONTS.bodyBold, fontSize: 12.5, color: BRAND.goldInk,
  },
  subtitle: {
    fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint, marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: BRAND.line,
  },
  rowText: { flex: 1, flexShrink: 1, minWidth: 0, gap: 2, paddingTop: 1 },
  rowTitle: {
    fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.warmInk, lineHeight: 20,
  },
  rowTitleDone: {
    color: BRAND.inkFaint,
    textDecorationLine: 'line-through',
  },
  rowMeta: { fontFamily: FONTS.body, fontSize: 11.5, color: BRAND.inkFaint },
  more: {
    alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 9, marginTop: 2,
  },
  moreText: { fontFamily: FONTS.bodyBold, fontSize: 12.5, color: BRAND.goldInk },
});
