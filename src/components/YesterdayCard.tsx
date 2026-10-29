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
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Task } from '../types/index';
import { useNight } from './ui/SkyBackdrop';
import { N } from './../constants/nightTone';

/** Rows shown before "+ N more ›" — the rest open on her tap, never by themselves. */
const VISIBLE_LIMIT = 5;

/** How long a let-go row can still be undone before it is actually let go. */
/** The icon buttons: small circles, with the rest of a 44dp target as slop. */
const ICON = 24;
const ICON_SLOP = { top: 10, bottom: 10, left: 5, right: 5 };

const UNDO_MS = 5000;

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
  tasks, today, language, onMove, onLetGo, onComplete, onReschedule,
}: Props) {
  const night = useNight();
  // Open by default when something needs a yes/no answer: an event that has
  // already happened is a question, not a leftover, and a question hidden
  // behind a chevron is a question never asked.
  const [open, setOpen] = useState(() => tasks.some(isPastEvent));
  const [showAll, setShowAll] = useState(false);
  // Rows she opened to read in full (Koral, 17.10: "expand and compress the
  // text"). The buttons used to be words — "✓ Done", "↻ Reschedule" — and took
  // so much of the row that a task read "שליחת קו…": five letters of it.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // × waits UNDO_MS before it lets go, so "Removed · Undo" can bring it back
  // (her pick, 17.10). Pending ids are hidden at once.
  const [pending, setPending] = useState<string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const he = language === 'he';

  // Leaving the screen carries out what was waiting: × was her decision, the
  // delay only existed to let her take it back.
  // × lets go (recoverable, status 'moved') — never the erase-for-good
  // onDelete, which sat 4px from Done with no confirmation (28.9).
  const onLetGoRef = useRef(onLetGo);
  onLetGoRef.current = onLetGo;
  useEffect(() => () => {
    const ids = [...timers.current.keys()];
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    if (ids.length) onLetGoRef.current(ids);
  }, []);

  const letGoLater = (id: string) => {
    setPending((p) => [...p, id]);
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setPending((p) => p.filter((x) => x !== id));
      onLetGoRef.current([id]);
    }, UNDO_MS));
  };
  const undo = (id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setPending((p) => p.filter((x) => x !== id));
  };
  // Returns the SAME set when nothing changes, so a repeated onTextLayout
  // cannot re-render the card in a loop.
  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, on?: boolean) =>
    set((prev) => {
      const want = on ?? !prev.has(id);
      if (want === prev.has(id)) return prev;
      const next = new Set(prev);
      if (want) next.add(id); else next.delete(id);
      return next;
    });

  const live = tasks.filter((t) => !pending.includes(t.id));
  const lastPending = pending.length ? tasks.find((t) => t.id === pending[pending.length - 1]) : undefined;

  if (!live.length && !lastPending) return null;

  // Say "from yesterday" only when that is true. Anything older is just
  // "unfinished" — claiming yesterday for a two-week-old task reads as a lie.
  const yesterday = previousDay(today);
  const allYesterday = live.every((t) => t.date === yesterday);
  const n = live.length;
  // "Did you go to X?" only ever fitted a place you attend. Most unfinished
  // work is not somewhere you went — it is something you meant to DO — and
  // being asked whether you "went to" sending a CV reads as the app not
  // knowing what the task was. One question covers both: did you do it?
  const title = n === 0
    ? he ? 'הכל טופל' : 'All handled'
    : n === 1
      ? he ? `עשית "${live[0].text}"?` : `Have you done "${live[0].text}"?`
      : allYesterday
        ? he ? `${n} מאתמול — מה מהם עשית?` : `${n} from yesterday — which have you done?`
        : he ? `${n} שלא הספקת — מה מהם עשית?` : `${n} unfinished — which have you done?`;

  const shown = showAll ? live : live.slice(0, VISIBLE_LIMIT);
  const extra = live.length - shown.length;
  const allIds = live.map((t) => t.id);

  return (
    <View style={[styles.card, night && N.card]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
      >
        <Text style={[styles.title, night && N.ink]}>{title}</Text>
        <Text style={[styles.chevron, night && N.inkSoft]}>{open ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>

      {open && (
        <View style={styles.body}>
          {shown.map((task) => {
            const isOpen = expanded.has(task.id);
            const label = (en: string, heb: string) => `${he ? heb : en}: ${task.text}`;
            // ONE set of buttons for every row (Koral, 23.9: "change it all to
            // be Done/reschedule"), and since 17.10 they are icons — ✓ ↻ × —
            // each 44dp and labelled for TalkBack, so the words go to the task.
            return (
              <View key={task.id} style={styles.row}>
                <Text style={styles.rowIcon}>{getCategoryMeta(task.category).icon}</Text>
                <Pressable
                  style={styles.rowBody}
                  // EVERY row opens on a tap. Whether a row was "long" used to be
                  // measured by an invisible copy's onTextLayout, and on her
                  // phone (17.10, v35) it never reported more than one line — so
                  // no row could open: "tapping still doesn't open the text".
                  // A short task simply opens to the same two lines.
                  onPress={() => toggle(setExpanded, task.id)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isOpen }}
                  accessibilityHint={he ? 'פותח את כל הטקסט' : 'Shows the whole text'}
                >
                  <Text style={[styles.rowText, night && N.ink]} numberOfLines={isOpen ? undefined : 2}>{task.text}</Text>
                  {/* The date, always. Without it a four-day-old task is
                      indistinguishable from one of today's. */}
                  <Text style={[styles.rowWhen, night && N.inkSoft]} numberOfLines={1}>
                    {whenLabel(task.date, today, he)}
                    {task.fixedTime ? ` · ${task.fixedTime}` : ''}
                  </Text>
                </Pressable>
                <Pressable
                  hitSlop={ICON_SLOP}
                  style={({ pressed }) => [styles.iconBtn, styles.doneBtn, pressed && styles.pressed]}
                  onPress={() => onComplete([task.id])}
                  accessibilityRole="button"
                  accessibilityLabel={label('Done', 'בוצע')}
                >
                  <Text style={styles.doneGlyph}>✓</Text>
                </Pressable>
                <Pressable
                  hitSlop={ICON_SLOP}
                  style={({ pressed }) => [styles.iconBtn, styles.moveBtn, pressed && styles.pressed]}
                  onPress={() => (onReschedule ? onReschedule(task) : onMove([task.id]))}
                  accessibilityRole="button"
                  accessibilityLabel={label('Reschedule', 'תזמון מחדש')}
                >
                  <Text style={styles.moveGlyph}>↻</Text>
                </Pressable>
                <Pressable
                  hitSlop={ICON_SLOP}
                  style={({ pressed }) => [styles.iconBtn, styles.dropBtn, pressed && styles.pressed]}
                  onPress={() => letGoLater(task.id)}
                  accessibilityRole="button"
                  accessibilityLabel={label('Remove from the list', 'להסיר מהרשימה')}
                >
                  <Text style={[styles.dropGlyph, night && N.ink]}>×</Text>
                </Pressable>
              </View>
            );
          })}

          {lastPending && (
            <View style={[styles.undoRow, night && N.card]}>
              <Text style={[styles.undoText, night && N.ink]} numberOfLines={1}>
                {he ? `הוסר: ${lastPending.text}` : `Removed: ${lastPending.text}`}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.undoBtn, pressed && styles.pressed]}
                onPress={() => undo(lastPending.id)}
                accessibilityRole="button"
              >
                <Text style={[styles.undoBtnText, night && N.goldInk]}>{he ? 'ביטול' : 'Undo'}</Text>
              </Pressable>
            </View>
          )}

          {(extra > 0 || (showAll && live.length > VISIBLE_LIMIT)) && (
            <Pressable
              style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              onPress={() => setShowAll((v) => !v)}
              accessibilityRole="button"
            >
              <Text style={[styles.moreText, night && N.goldInk]}>
                {extra > 0
                  ? he ? `+ עוד ${extra}  ⌄` : `+ ${extra} more  ⌄`
                  : he ? 'פחות  ⌃' : 'Show less  ⌃'}
              </Text>
            </Pressable>
          )}

          {live.length > 0 && (
            <View style={styles.actions}>
              {/* Every row can be rescheduled (her call, 23.9), so the bulk
                  action moves every row. It still filtered out anything with an
                  hour — so on a day where all four leftovers had one, the button
                  sent an empty list and nothing happened, in silence (28.9). */}
              <TouchableOpacity
                style={styles.moveAll}
                onPress={() => onMove(allIds)}
                activeOpacity={0.85}
              >
                <Text style={styles.moveAllText}>{he ? '↻ תזמני הכל מחדש' : '↻ Reschedule all'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.letGo} onPress={() => onLetGo(allIds)} activeOpacity={0.85}>
                <Text style={[styles.letGoText, night && N.inkSoft]}>{he ? 'שחררי' : 'Let them go'}</Text>
              </TouchableOpacity>
            </View>
          )}
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: MIN_TOUCH },
  title: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft },
  chevron: { fontSize: 16, color: BRAND.inkSoft, paddingHorizontal: 4 },
  body: { marginTop: 4, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  rowIcon: { fontSize: 16, marginTop: 2 },
  rowBody: { flex: 1, marginRight: 4, minHeight: MIN_TOUCH, justifyContent: 'center' },
  rowText: { fontFamily: FONTS.bodyBold, fontSize: 15, lineHeight: 21, color: BRAND.warmInk },
  rowWhen: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 2 },
  // 24dp to the eye, 44dp to the finger (ICON_SLOP). At 44dp filled, three of
  // them were "very very big" next to the task (Koral, 17.10).
  iconBtn: {
    width: ICON, height: ICON, borderRadius: ICON / 2, marginTop: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  doneBtn: { backgroundColor: BRAND.success },
  doneGlyph: { fontFamily: FONTS.bodyHeavy, fontSize: 12, lineHeight: 15, color: BRAND.creamCard },
  moveBtn: { backgroundColor: BRAND.timeChipBg },
  moveGlyph: { fontFamily: FONTS.bodyHeavy, fontSize: 13, lineHeight: 16, color: BRAND.timeChipText },
  dropBtn: { borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard },
  dropGlyph: { fontFamily: FONTS.bodyBold, fontSize: 14, lineHeight: 16, color: BRAND.inkSoft },
  undoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: BRAND.timeChipBg, borderRadius: RADIUS.chip, paddingLeft: 12,
  },
  undoText: { flex: 1, fontFamily: FONTS.body, fontSize: 13, color: BRAND.warmInk },
  undoBtn: { minHeight: MIN_TOUCH, paddingHorizontal: 14, justifyContent: 'center' },
  undoBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk },
  more: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  moreText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk },
  actions: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  moveAll: {
    flex: 1, backgroundColor: BRAND.sunGold, borderRadius: 14,
    minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center',
  },
  moveAllText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold },
  letGo: { minHeight: MIN_TOUCH, paddingHorizontal: 12, justifyContent: 'center' },
  letGoText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkSoft },
});
