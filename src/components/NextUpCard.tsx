/**
 * NextUpCard — "what is actually coming next", with the whole chain that gets
 * you there on time.
 *
 * The Today screen only ever showed TODAY's column, so a meeting tomorrow
 * morning was invisible and an undated "submit CV" sat at the top instead.
 * This card answers the question the user actually has when they open the app:
 * what is next, when do I have to wake up, when do I leave, and how.
 *
 * Purely presentational — the chain (wakeUpBy / leaveHomeBy / transitPlan) is
 * computed by GoogleSync.ensureTravelChainAhead and read off the task here.
 *
 * Dependencies: constants/theme, types. Consumed by screens/TodaySchedule.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { AppLanguage, Task, TaskLocation, UserProfile } from '../types/index';
import { getReadyTimeFor, wakeChipFor, wakeInputs } from '../utils/alarmPlan';

interface Props {
  task: Task;
  language: AppLanguage;
  onPress: () => void;
  /** Open the one-thing-at-a-time focus screen. Omitted → no start button. */
  onStart?: () => void;
  /**
   * Needed for the WAKE-UP row, not for decoration. The wake time falls back to
   * the task's start minus the morning routine when no route has been computed
   * yet, and that fallback is unreachable without the profile — which is how
   * tomorrow's alarm went missing from this card. With no profile only an
   * explicit alarmAt or an already-routed wakeUpBy can be drawn.
   */
  profile?: UserProfile | null;
  /** Tap the ⏰ row: turn the alarm off, back on, or move it. */
  onAlarmPress?: (task: Task) => void;
}

const loc = (t: Task): TaskLocation | undefined =>
  typeof t.location === 'object' ? t.location : undefined;

const placeOf = (t: Task): string =>
  typeof t.location === 'string'
    ? t.location
    : t.location?.displayName || t.location?.address || '';

/** "today" / "tomorrow" / "Wed 2 Sep" — never a bare ISO date. */
function dayLabel(date: string, he: boolean): string {
  const today = new Date();
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (date === key(today)) return he ? 'היום' : 'today';
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date === key(tomorrow)) return he ? 'מחר' : 'tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const days = he
    ? ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[dt.getDay()]} ${dt.getDate()}/${dt.getMonth() + 1}`;
}

export default function NextUpCard({
  task, language, onPress, onStart, profile, onAlarmPress,
}: Props) {
  const he = language === 'he';
  const l = loc(task);
  const plan = l?.transitPlan;
  const place = placeOf(task);
  const when = task.fixedTime || task.scheduledTime;

  // The backward chain, in the order you live it.
  //
  // The wake row is asked of the DOMAIN (utils/alarmPlan), never re-derived
  // here. It used to be `if (l?.wakeUpBy)`, which is only the second of three
  // sources: a task with an explicit "wake me at 7" showed nothing, and so did
  // every task on a day whose routes had not been computed yet — i.e. tomorrow,
  // most of the time. The alarm still rang. The card just did not say so.
  const wake = wakeChipFor(task, wakeInputs(profile));
  // A route's wake time that is NOT a wake-from-sleep moment (13:00 for a 14:00
  // class) is still worth showing — but as "get ready", never as an alarm.
  const getReady = getReadyTimeFor(task, wakeInputs(profile));

  type Step = { key: string; icon: string; label: string; time: string; kind?: 'wake' };
  const steps: Step[] = [];
  if (wake) {
    steps.push({
      key: 'wake',
      icon: wake.muted ? '🔕' : '⏰',
      label: wake.muted ? (he ? 'כבוי' : 'alarm off') : (he ? 'להתעורר' : 'wake up'),
      time: wake.at,
      kind: 'wake',
    });
  } else if (getReady) {
    steps.push({ key: 'ready', icon: '🧭', label: he ? 'להתארגן' : 'get ready', time: getReady });
  }
  if (l?.leaveHomeBy) {
    steps.push({ key: 'leave', icon: '🚪', label: he ? 'לצאת' : 'leave', time: l.leaveHomeBy });
  }
  if (when) {
    steps.push({ key: 'start', icon: '📍', label: he ? 'מתחיל' : 'starts', time: when });
  }

  const ride = plan?.legs.find((leg) => leg.type !== 'walk');

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.9}>
      <View style={styles.topRow}>
        <Text style={styles.eyebrow}>{he ? 'הדבר הבא' : 'NEXT UP'}</Text>
        <Text style={styles.day}>{dayLabel(task.date, he)}</Text>
      </View>

      <Text style={styles.title} numberOfLines={2}>{task.text}</Text>
      {Boolean(place) && <Text style={styles.place} numberOfLines={1}>📍 {place}</Text>}

      {steps.length > 0 && (
        <View style={styles.chain}>
          {steps.map((s, i) => (
            <React.Fragment key={s.key}>
              {i > 0 && <Text style={styles.arrow}>→</Text>}
              {/* The wake row is the one you can act on, so it is the one that
                  is tappable and the one wearing the brand gold. */}
              <TouchableOpacity
                style={[styles.step, s.kind === 'wake' && styles.stepWake]}
                onPress={s.kind === 'wake' && onAlarmPress ? () => onAlarmPress(task) : undefined}
                disabled={s.kind !== 'wake' || !onAlarmPress}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <Text
                  style={[styles.stepTime, s.kind === 'wake' && styles.stepTimeWake]}
                  numberOfLines={1}
                >
                  {s.icon} {s.time}
                </Text>
                <Text
                  style={[styles.stepLabel, s.kind === 'wake' && styles.stepLabelWake]}
                  numberOfLines={1}
                >
                  {s.label}
                </Text>
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </View>
      )}

      {plan ? (
        <Text style={styles.route} numberOfLines={2}>
          {ride?.lineNumber ? `${ride.lineNumber} · ` : ''}
          {he
            ? `${plan.totalDurationMinutes} דק' דלת לדלת, הגעה ${plan.arriveAt}`
            : `${plan.totalDurationMinutes} min door to door, arrive ${plan.arriveAt}`}
        </Text>
      ) : place ? (
        // Be honest that the route isn't known yet rather than showing nothing.
        <Text style={styles.pending}>
          {he ? '🧭 מחשבת מסלול וזמן יציאה…' : '🧭 Working out the route and leave time…'}
        </Text>
      ) : null}

      {/* Straight into the focus screen — knowing what's next and being able
          to begin it are different problems, and this card only solved the
          first one. */}
      {onStart && (
        <TouchableOpacity style={styles.start} onPress={onStart} activeOpacity={0.85}>
          <Text style={styles.startText}>{he ? 'מתחילה עכשיו' : 'Start now'}</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Brand canvas: cream card, warm hairline, gold accent. This is the day's
  // headline card, and it now shares the timeline's palette exactly — the two
  // used to be a clay card above a gold one, which is why the top of Today
  // read as a different app from the schedule underneath it.
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card - 2,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderLeftWidth: 4,
    borderLeftColor: BRAND.sunGold,
    padding: 16,
    marginBottom: 14,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  eyebrow: {
    flexShrink: 1, minWidth: 0,
    fontFamily: FONTS.bodyBold, fontSize: 11, letterSpacing: 1.2,
    color: BRAND.inkFaint,
  },
  day: {
    flexShrink: 0,
    fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk,
    backgroundColor: BRAND.goldSoft,
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: 'hidden',
  },
  // The day's headline.
  title: { fontFamily: FONTS.serif, fontSize: 19, color: BRAND.warmInk, marginTop: 8, lineHeight: 26 },
  place: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, marginTop: 3 },
  chain: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
    marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  // flexShrink: 0 on the STEP, not only on its text. The text already refused
  // to shrink, but its parent did not, so under a long Hebrew place name the
  // row squeezed the container and clipped "06:40" to "06:…". The chain wraps
  // (flexWrap on .chain) rather than compressing any step.
  step: { flexShrink: 0, alignItems: 'center', minWidth: 62, paddingVertical: 2 },
  // The wake row is the one thing on this card that is worth getting up for,
  // and it is the only tappable step — so it reads as a control: gold fill,
  // gold ink. BRAND rule (constants/theme): sunGold is a SURFACE, goldInk is
  // that accent AS TEXT, and onGold is ink sitting ON a sunGold fill. goldSoft
  // is the tint, so the label on it uses goldInk (4.79:1), never white (1.7:1).
  stepWake: {
    backgroundColor: BRAND.goldSoft,
    borderWidth: 1,
    borderColor: BRAND.sunGold,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  // flexShrink: 0 — the wake / leave / arrive clock times are this card's
  // whole payload and must never be squeezed by a long place name beside them.
  stepTime: { flexShrink: 0, fontFamily: FONTS.bodyBold, fontSize: 15, color: BRAND.warmInk },
  stepTimeWake: { color: BRAND.warmInk },
  stepLabel: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint, marginTop: 1 },
  stepLabelWake: { color: BRAND.goldInk, fontFamily: FONTS.bodySemi },
  arrow: { flexShrink: 0, fontSize: 14, color: BRAND.inkFaint, marginHorizontal: 8 },
  route: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 10, lineHeight: 18 },
  start: {
    marginTop: 12, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.chip + 2,
    paddingVertical: 12, paddingHorizontal: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  startText: {
    fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold, textAlign: 'center',
  },
  pending: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint, marginTop: 10 },
});
