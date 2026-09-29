/**
 * TaskPrepCard — what Meira found to prepare you, every line with its source.
 *
 * The citations are the point: a song list or a "bring your referral" that
 * nobody can trace is a guess. Each item's [n] is tappable and opens the page
 * it came from — for songs, that is where the lyrics are.
 */
import React from 'react';
import FeedbackThumbs from './FeedbackThumbs';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import { TaskPrepResult } from '../services/LumiServer';
import { prepForTask } from '../services/TaskPrepService';
import { Task } from '../types/index';

const KIND_ICON: Record<string, string> = {
  songs: '🎤', questions: '❓', checklist: '✅', reading: '📖', route_tips: '🧭', ideas: '💡', other: '🔎',
};
const HEB = /[֐-׿]/;

interface Props { prep: TaskPrepResult; he: boolean; taskText: string }

export default function TaskPrepCard({ prep, he, taskText }: Props) {
  const items = (he ? prep.items_he : prep.items_en) ?? prep.items_en ?? [];
  const headline = (he ? prep.headline_he : prep.headline_en) || prep.headline_en || '';
  const linkOf = (n: number) => prep.sources?.find((s) => s.n === n)?.link;
  return (
    <View style={styles.card}>
      <Text style={styles.kicker}>{KIND_ICON[prep.kind ?? 'other']} {he ? 'מאירה הכינה לך' : 'Meira prepared'}</Text>
      <Text style={[styles.task, HEB.test(taskText) && styles.rtl]}>{taskText}</Text>
      {headline ? <Text style={[styles.headline, HEB.test(headline) && styles.rtl]}>{headline}</Text> : null}
      {items.map((line, i) => {
        const nums = (line.match(/\[([\d,\s]+)\]/)?.[1] ?? '').split(',').map((x) => Number(x.trim())).filter(Boolean);
        const text = line.replace(/\s*\[[\d,\s]+\]\s*$/, '');
        return (
          <View key={i} style={styles.row}>
            <Text style={[styles.item, HEB.test(text) && styles.rtl]}>• {text}</Text>
            {nums.map((n) => {
              const link = linkOf(n);
              return link ? (
                <TouchableOpacity key={n} onPress={() => Linking.openURL(link).catch((e) => console.warn('[TaskPrep] link', e))}
                  hitSlop={8} accessibilityRole="link" accessibilityLabel={he ? `מקור ${n}` : `Source ${n}`}>
                  <Text style={styles.cite}>[{n}]</Text>
                </TouchableOpacity>
              ) : null;
            })}
          </View>
        );
      })}
      <Text style={styles.foot}>
        {he ? `כל שורה מגיעה ממקור · ${prep.sources?.length ?? 0} מקורות · Tavily`
          : `Every line cites its source · ${prep.sources?.length ?? 0} sources · Tavily`}
      </Text>
      <FeedbackThumbs surface="prep" subject={taskText} about={prep.kind ?? undefined} he={he} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 8, gap: 8 },
  kicker: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, letterSpacing: 0.5 },
  task: { fontFamily: FONTS.display, fontSize: 20, color: BRAND.warmInk },
  headline: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.inkSoft },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  item: { flex: 1, fontFamily: FONTS.bodySemi, fontSize: 15, color: BRAND.warmInk, lineHeight: 21 },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
  cite: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk, textDecorationLine: 'underline' },
  foot: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkSoft, marginTop: 6 },
});

/**
 * The prep inside a task card: asks once per task (cached on both sides) and
 * renders nothing when there is nothing worth preparing — laundry stays quiet.
 */
export function TaskPrepSection({ task, he }: { task: Task; he: boolean }) {
  const [prep, setPrep] = React.useState<TaskPrepResult | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setPrep(null);
    prepForTask(task)
      .then((r) => { if (!cancelled) setPrep(r); })
      .catch((e) => console.warn('[TaskPrep] section failed', e));
    return () => { cancelled = true; };
  }, [task.id, task.text]);
  if (!prep) return null;
  return (
    <View style={sectionStyles.wrap}>
      <TaskPrepCard prep={prep} he={he} taskText={task.text} />
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: { backgroundColor: BRAND.cream, borderRadius: 16, borderWidth: 1, borderColor: BRAND.line, paddingHorizontal: 12, marginVertical: 8 },
});
