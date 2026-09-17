/** TaskItem — minimal task row for plain lists. */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { BRAND, COLORS, NOTE_PALETTE, FONTS, RADIUS } from '../constants/theme';
import { Task } from '../types/index';

// Sticky-note pastels so category badges match the Tasks board.
const noteTint = (i: number) => NOTE_PALETTE[i % NOTE_PALETTE.length].tint;
const CATEGORY_COLORS: Record<string, string> = {
  health: noteTint(1),
  work: noteTint(0),
  home: noteTint(3),
  interview: noteTint(1),
  social: noteTint(4),
  errand: noteTint(4),
  learning: noteTint(2),
  general: noteTint(3),
  other: noteTint(3),
};

function formatDueDate(value?: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface Props {
  task: Task;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onEdit: (task: Task) => void;
}

export function TaskItem({ task, onToggle, onDelete, onEdit }: Props) {
  const rightAction = () => (
    <RectButton style={styles.deleteAction} onPress={() => onDelete(task)}>
      <Text style={styles.deleteText}>Delete</Text>
    </RectButton>
  );

  const hasContact = task.contactName || task.contactPhone;
  const hasChips = task.location || task.dueDate || hasContact || task.how || task.why;
  const dueDateLabel = formatDueDate(task.dueDate);

  return (
    <Swipeable renderRightActions={rightAction} overshootRight={false}>
      <Pressable
        onPress={() => onToggle(task)}
        onLongPress={() => onEdit(task)}
        style={styles.row}
      >
        <View style={[styles.checkbox, task.status === 'complete' && styles.checked]} />
        <View style={styles.content}>
          <Text
            style={[
              styles.text,
              task.priority === 'must' && styles.mustText,
              task.priority === 'nice_to_do' && styles.niceText,
              task.status === 'complete' && styles.completeText,
            ]}
          >
            {task.text}
          </Text>

          {/* ── Detail chips ── */}
          {hasChips && (
            <View style={styles.chipsRow}>
              {task.location ? (
                <View style={[styles.chip, styles.chipLocation]}>
                  <Text style={styles.chipText}>📍 {typeof task.location === 'string' ? task.location : task.location.displayName || task.location.address}</Text>
                </View>
              ) : null}
              {dueDateLabel ? (
                <View style={[styles.chip, styles.chipDeadline]}>
                  <Text style={styles.chipText}>⏰ {dueDateLabel}</Text>
                </View>
              ) : null}
              {hasContact ? (
                <View style={[styles.chip, styles.chipContact]}>
                  <Text style={styles.chipText}>👤 {task.contactName ?? 'Phone contact'}{task.contactPhone ? ` · ${task.contactPhone}` : ''}</Text>
                </View>
              ) : null}
              {task.how ? (
                <View style={[styles.chip, styles.chipHow]}>
                  <Text style={styles.chipText}>🔧 {task.how}</Text>
                </View>
              ) : null}
              {task.why ? (
                <View style={[styles.chip, styles.chipWhy]}>
                  <Text style={styles.chipText}>💡 {task.why}</Text>
                </View>
              ) : null}
            </View>
          )}

          {/* ── Category / subgroup badges ── */}
          <View style={styles.badgesRow}>
            {task.category ? (
              <View style={[styles.badge, { backgroundColor: CATEGORY_COLORS[task.category] ?? CATEGORY_COLORS.general }]}>
                <Text style={styles.badgeText}>{task.category}</Text>
              </View>
            ) : null}
            {task.subgroup ? (
              <View style={[styles.badge, styles.subgroupBadge]}>
                <Text style={styles.badgeText}>{task.subgroup}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <Pressable style={styles.inlineDeleteBtn} onPress={() => onDelete(task)}>
          <Text style={styles.inlineDeleteText}>🗑</Text>
        </Pressable>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BRAND.creamCard,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.card,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: BRAND.line,
    marginRight: 10,
    backgroundColor: BRAND.white,
  },
  checked: {
    backgroundColor: BRAND.sunGold,
    borderColor: BRAND.sunGold,
  },
  text: {
    fontSize: 16,
    fontFamily: FONTS.body,
    color: BRAND.warmInk,
  },
  mustText: {
    fontFamily: FONTS.bodyBold,
  },
  niceText: {
    opacity: 0.8,
  },
  completeText: {
    textDecorationLine: 'line-through',
    color: BRAND.inkFaint,
  },
  content: {
    flex: 1,
  },
  inlineDeleteBtn: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.card,
    backgroundColor: BRAND.honey,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  inlineDeleteText: {
    fontSize: 15,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
    gap: 6,
  },
  // detail chips
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 5,
    gap: 5,
  },
  chip: {
    borderRadius: RADIUS.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipLocation: { backgroundColor: noteTint(3) },
  chipDeadline: { backgroundColor: BRAND.timeChipBg },
  chipContact: { backgroundColor: noteTint(4) },
  chipHow: { backgroundColor: noteTint(2) },
  chipWhy: { backgroundColor: noteTint(1) },
  chipText: {
    fontSize: 11,
    color: BRAND.warmInk,
    fontFamily: FONTS.bodySemi,
  },
  badge: {
    borderRadius: RADIUS.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  subgroupBadge: {
    backgroundColor: BRAND.honey,
  },
  badgeText: {
    fontSize: 12,
    color: BRAND.warmInk,
    fontFamily: FONTS.bodySemi,
    textTransform: 'capitalize',
  },
  deleteAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 90,
    backgroundColor: COLORS.danger,
    borderRadius: RADIUS.chip,
    marginBottom: 10,
  },
  deleteText: {
    color: BRAND.white,
    fontFamily: FONTS.bodySemi,
  },
});
