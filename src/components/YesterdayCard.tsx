/**
 * YesterdayCard — the tasks you didn't finish, resurfaced without a pile-on.
 *
 * Until now they were simply lost: TodaySchedule reads getTasksForDate(today),
 * and an unfinished task keeps its OLD date, so it disappeared from every
 * screen the user actually opens (the backlog UI exists only in HomeScreen,
 * which is reachable solely by tapping a check-in notification).
 *
 * Deliberately collapsed by default and capped at VISIBLE_LIMIT rows. A wall of
 * overdue items is worse than losing them — it is the thing that makes people
 * close the app. "Let them go" is offered as plainly as "move to today", with
 * no guilt copy on either.
 *
 * An item that already HAPPENED (a show, a class, an interview) is asked
 * about, not offered a reschedule: "did you go?" → Went / Didn't go.
 *
 * Purely presentational: the caller owns the tasks and the two actions.
 * Dependencies: constants/theme, constants/categories, types.
 * Consumed by screens/TodaySchedule.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Task } from '../types/index';

/** Never render more than this many rows, however deep the backlog is. */
const VISIBLE_LIMIT = 5;

interface Props {
  tasks: Task[];
  today: string;
  language: AppLanguage;
  /** Move these ids onto today. */
  onMove: (ids: string[]) => void;
  /**
   * Reschedule ONE task, by opening it so a time can be chosen. "Move it"
   * used to guess a slot silently, and the bulk button moved everything at
   * once — neither asks the only question that matters: when.
   */
  onReschedule?: (task: Task) => void;
  /** Stop tracking these ids (status 'moved' — recoverable, not deleted). */
  onLetGo: (ids: string[]) => void;
  /** Mark these ids complete. The overdue task you DID do had nowhere to go. */
  onComplete: (ids: string[]) => void;
  /** Erase for good. Separate from onLetGo, which is recoverable. */
  onDelete: (ids: string[]) => void;
}

/**
 * A thing that HAPPENED at a time (a show, an interview, a class) rather than
 * a thing to get done. The only sensible question about it is "did you go?" —
 * "reschedule" is nonsense for last night's concert, and it was the only
 * option on offer while the auto-rollover was silently moving it to today.
 *
 * A clock time is the test, not a location: "buy milk at the supermarket" has
 * a place but no hour, and that one genuinely does want rescheduling.
 */
function isPastEvent(task: Task): boolean {
  return Boolean(task.fixedTime);
}

/**
 * When this actually was, in as few characters as fit on the row.
 *
 * Koral, 2026-09-21: "Hani and Danny's wedding shows on today, but it was on
 * 17.9 — why is it showing today?" It was showing because an unfinished task
 * keeps its own date and this card resurfaces it, which is the whole point of
 * the card. What it never did was SAY which day it came from, so a wedding
 * four days gone sat among today's cards looking like today's business.
 *
 * Same fault as the alarm behind the ▸ and the calendar error swallowed into
 * an empty array: the app knew, and did not say.
 */
function whenLabel(date: string, today: string, he: boolean): string {
  if (date === previousDay(today)) return he ? 'אתמול' : 'yesterday';
  const [, m, d] = date.split('-').map(Number);
  const [ty] = today.split('-').map(Number);
  const [y] = date.split('-').map(Number);
  const short = `${d}.${m}`;
  return y === ty ? short : `${short}.${String(y).slice(2)}`;
}

/** YYYY-MM-DD one day before `date`, local-calendar safe. */
function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export default function YesterdayCard({
  tasks, today, language, onMove, onLetGo, onComplete, onDelete, onReschedule,
}: Props) {
  // Open by default when something needs a yes/no answer: an event that has
  // already happened is a question, not a leftover, and a question hidden
  // behind a chevron is a question never asked.
  const [open, setOpen] = useState(() => tasks.some(isPastEvent));
  const he = language === 'he';

  if (!tasks.length) return null;

  // Say "from yesterday" only when that is true. Anything older is just
  // "unfinished" — claiming yesterday for a two-week-old task reads as a lie.
  const yesterday = previousDay(today);
  const allYesterday = tasks.every((t) => t.date === yesterday);
  const n = tasks.length;
  const events = tasks.filter(isPastEvent);
  // "Did you go to X?" only ever fitted a place you attend. Most unfinished
  // work is not somewhere you went — it is something you meant to DO — and
  // being asked whether you "went to" sending a CV reads as the app not
  // knowing what the task was. One question covers both: did you do it?
  const title = n === 1
    ? he ? `עשית "${tasks[0].text}"?` : `Have you done "${tasks[0].text}"?`
    : allYesterday
      ? he ? `${n} מאתמול — מה מהם עשית?` : `${n} from yesterday — which have you done?`
      : he ? `${n} שלא הספקת — מה מהם עשית?` : `${n} unfinished — which have you done?`;

  const shown = tasks.slice(0, VISIBLE_LIMIT);
  const extra = tasks.length - shown.length;
  const allIds = tasks.map((t) => t.id);

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
      >
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.chevron}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {open && (
        <View style={styles.body}>
          {shown.map((task) => {
            // A wedding that already happened cannot be rescheduled, and this
            // card was offering exactly that. The doc at the top of this file
            // has always said a past event is ASKED about rather than moved;
            // the rows never implemented it, so "↻ תזמון מחדש" sat next to
            // Hani and Danny's wedding. Went / Didn't go, and nothing else.
            return (
              <View key={task.id} style={styles.row}>
                <Text style={styles.rowIcon}>{getCategoryMeta(task.category).icon}</Text>
                <View style={styles.rowBody}>
                  <Text style={styles.rowText} numberOfLines={1}>{task.text}</Text>
                  {/* The date, always. Without it a four-day-old task is
                      indistinguishable from one of today's. */}
                  <Text style={styles.rowWhen} numberOfLines={1}>
                    {whenLabel(task.date, today, he)}
                    {task.fixedTime ? ` · ${task.fixedTime}` : ''}
                  </Text>
                </View>
                {/* ONE pair of buttons, for every row.
                    Koral, 2026-09-23: "once have the bottom went didn't go —
                    change it all to be Done/reschedule."
                    A row that had a clock on it used to get Went / Didn't go
                    instead, on the theory that you cannot reschedule a wedding.
                    True of a wedding; false of the great majority of things
                    that carry an hour, which are work she parked at a time and
                    still means to do. Two different button pairs on one list
                    also means reading each row before you can act on it, which
                    is the opposite of what this card is for. Her call. */}
                <TouchableOpacity
                  style={styles.rowDone}
                  onPress={() => onComplete([task.id])}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={styles.rowDoneText}>{he ? '✓ בוצע' : '✓ Done'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.rowMove}
                  onPress={() => (onReschedule ? onReschedule(task) : onMove([task.id]))}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={styles.rowMoveText}>
                    {he ? '↻ תזמון מחדש' : '↻ Reschedule'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.rowDrop}
                  onPress={() => onDelete([task.id])}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  accessibilityLabel={he ? 'לוותר' : 'Let go'}
                >
                  <Text style={styles.rowDropText}>💤</Text>
                </TouchableOpacity>
              </View>
            );
          })}

          {extra > 0 && (
            <Text style={styles.more}>
              {he ? `ועוד ${extra}` : `+${extra} more`}
            </Text>
          )}

          <View style={styles.actions}>
            {/* Every row can be rescheduled (her call, 23.9), so the bulk
                action moves every row. It still filtered out anything with an
                hour — so on a day where all four leftovers had one, the button
                sent an empty list and nothing happened, in silence (28.9). */}
            {tasks.length > 0 && (
              <TouchableOpacity
                style={styles.moveAll}
                onPress={() => onMove(allIds)}
                activeOpacity={0.85}
              >
                <Text style={styles.moveAllText}>{he ? '↻ תזמני הכל מחדש' : '↻ Reschedule all'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.letGo} onPress={() => onLetGo(allIds)} activeOpacity={0.85}>
              <Text style={styles.letGoText}>{he ? 'שחררי' : 'Let them go'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: BRAND.line,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    ...SHADOWS.card,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft },
  chevron: { fontSize: 11, color: BRAND.inkFaint },
  body: { marginTop: 10, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowDone: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: RADIUS.chip,
    backgroundColor: BRAND.success,
  },
  rowDoneText: { fontSize: 12, fontFamily: FONTS.bodyBold, color: BRAND.creamCard },
  rowIcon: { fontSize: 14 },
  rowBody: { flex: 1, marginRight: 6 },
  rowWhen: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkSoft, marginTop: 1 },
  rowText: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.warmInk },
  rowMove: {
    backgroundColor: BRAND.timeChipBg, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  rowMoveText: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.timeChipText },
  rowDrop: { paddingHorizontal: 4 },
  rowDropText: { fontSize: 13, color: BRAND.inkFaint },
  more: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint, marginTop: 2 },
  actions: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  moveAll: {
    flex: 1, backgroundColor: BRAND.sunGold, borderRadius: 14,
    paddingVertical: 9, alignItems: 'center',
  },
  moveAllText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: '#4A3512' },
  letGo: { paddingVertical: 9, paddingHorizontal: 12 },
  letGoText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkFaint },
});
