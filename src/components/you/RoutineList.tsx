/**
 * RoutineList — ONE list of her routines and habits, in You (6.10).
 *
 * "Organise Profile and Menu so nothing appears twice … where is the chat
 * where I tell Meira my routines?" Before, the Routines box showed only what
 * she typed on the phone; what she told Meira in the chat lived on the server
 * and no screen showed it. Here both are one list, each line saying where it
 * came from and which days it is on — and × removes it from wherever it lives.
 * A line with no days carries "every day? ›" (Meira's question about it).
 *
 * Writes go to the store the line came from: her box on this phone
 * (UserProfileStorage, reloaded first, never a stale copy) and/or the server
 * (removeToldRoutines). A × that did not land says so (rule 3).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';
import { invalidateRoutines, loadRoutines, onRoutinesChanged } from '../../services/GapFillService';
import { removeToldRoutines } from '../../services/LumiServer';
import { loadProfile, saveProfile } from '../../services/UserProfileStorage';
import * as Questions from '../../services/QuestionService';
import { Routine, removeRoutineFromNotes, weekdayLabel } from '../../utils/routines';
import { subjectOf } from '../../questions/kinds/routineDays';

const HEBREW = /[֐-׿]/;

function daysText(r: Routine, he: boolean): string {
  switch (r.daysFrom) {
    case 'varies': return he ? 'ימים משתנים' : 'days change weekly';
    case 'rule': return he ? 'לפי כלל שלימדת' : 'by your rule';
    case 'unsaid': return '';
    default:
      if (!r.weekdays.length || r.weekdays.length === 7) return he ? 'כל יום' : 'every day';
      return r.weekdays.map((d) => weekdayLabel(d, he ? 'he' : 'en')).join(he ? ', ' : ', ');
  }
}

function originText(r: Routine, he: boolean): string {
  const o = r.origin || [];
  if (o.includes('box') && o.includes('told')) return he ? 'כתבת + סיפרת למאירה' : 'you typed + told Meira';
  if (o.includes('told')) return he ? 'סיפרת למאירה' : 'you told Meira';
  return he ? 'כתבת' : 'you typed';
}

/** Remove one routine (her words) from the Routines box text on this phone. false = it was not there. */
async function removeFromBox(line: string): Promise<boolean> {
  const profile = await loadProfile();
  if (!profile) return false;
  const { notes, removed } = removeRoutineFromNotes(String((profile as any)?.routinesNotes || ''), line);
  if (!removed) return false;               // nothing matched: never report a removal that did not happen (rule 3)
  await saveProfile({ ...profile, routinesNotes: notes } as any);
  return true;
}

export default function RoutineList({ he }: { he: boolean }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    loadRoutines()
      .then((rs) => { setRoutines(rs.filter((r) => r.source === 'notes')); setError(null); })
      .catch((e) => setError(String((e as Error)?.message || e)));
  }, []);
  useEffect(() => { load(); return onRoutinesChanged(load); }, [load]);

  const remove = async (r: Routine) => {
    setBusy(r.id);
    const failed: string[] = [];
    if (r.origin?.includes('box') && !(await removeFromBox(r.text).catch(() => false))) {
      failed.push(he ? 'לא נמחק מהטלפון' : 'not removed on this phone');
    }
    if (r.origin?.includes('told')) {
      const res = await removeToldRoutines([r.text]);
      if (!res.ok) failed.push(he ? `לא נמחק אצל מאירה: ${res.reason}` : `not removed with Meira: ${res.reason}`);
      // ok with nothing removed = Meira holds no line that reads this way: said, not claimed as done (rule 1).
      else if (!res.data.removed?.length) failed.push(he ? 'מאירה לא מצאה את השורה אצלה' : "Meira didn't find that line on her side");
    }
    setBusy(null);
    setError(failed.length ? failed.join(' · ') : null);
    invalidateRoutines();
  };

  const add = async () => {
    const line = adding.trim();
    if (line.length < 3) return;
    setBusy('add');
    try {
      const profile = await loadProfile();
      const notes = String((profile as any)?.routinesNotes || '').trim();
      await saveProfile({ ...(profile as any), routinesNotes: notes ? `${notes}\n${line}` : line });
      setAdding('');
      invalidateRoutines();
      // An hour with no day: Meira asks now, while she is looking at it.
      Questions.maybeAsk({ justSaved: true }).catch((e) => console.warn('[You] question check failed', e));
    } catch (e) {
      setError(he ? `לא נשמר: ${String(e)}` : `Not saved: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.wrap}>
      {routines.length === 0 && !error ? (
        <Text style={[styles.empty, he && styles.rtl]}>
          {he ? 'עוד אין שגרות. הוסיפי למטה, או ספרי למאירה בצ׳אט.' : 'No routines yet. Add one below, or tell Meira in the chat.'}
        </Text>
      ) : null}
      {routines.map((r) => {
        const days = daysText(r, he);
        return (
          <View key={r.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.text, HEBREW.test(r.text) && styles.rtl]}>{`🔁 ${r.text}`}</Text>
              <View style={[styles.metaRow, he && styles.rowRtl]}>
                {days ? <Text style={styles.meta}>{days}</Text> : (
                  <TouchableOpacity accessibilityRole="button"
                    onPress={() => { Questions.askNow(`routineDays:${subjectOf(r)}`).catch(() => {}); }}>
                    <Text style={styles.ask}>{he ? 'כל יום? ›' : 'every day? ›'}</Text>
                  </TouchableOpacity>
                )}
                <Text style={styles.tag}>{originText(r, he)}</Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => remove(r)} disabled={busy === r.id} style={styles.x}
              accessibilityRole="button" accessibilityLabel={he ? `מחיקת ${r.text}` : `Remove ${r.text}`}>
              <Text style={styles.xText}>{busy === r.id ? '…' : '×'}</Text>
            </TouchableOpacity>
          </View>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={[styles.addRow, he && styles.rowRtl]}>
        <TextInput
          style={[styles.input, he && styles.rtl]}
          value={adding}
          onChangeText={setAdding}
          onSubmitEditing={add}
          placeholder={he ? '+ קיקבוקס ימי ג׳ 20:30, יגאל אלון 94' : '+ gym Mon/Wed 18:00'}
          placeholderTextColor={BRAND.inkSoft}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.addBtn} onPress={add} disabled={busy === 'add'} accessibilityRole="button">
          <Text style={styles.addBtnText}>{busy === 'add' ? '…' : he ? 'הוסיפי' : 'Add'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 2 },
  empty: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  text: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  rowRtl: { flexDirection: 'row-reverse' },
  meta: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  ask: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  tag: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.goldInk, backgroundColor: 'rgba(241,194,78,0.18)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  x: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  // × is thinner than the old ballot-X at the same size, so it is drawn bigger.
  xText: { fontFamily: FONTS.bodyHeavy, fontSize: 22, lineHeight: 24, color: BRAND.inkSoft },
  error: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.danger, paddingVertical: 6 },
  addRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  input: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: BRAND.line, paddingHorizontal: 12, fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk },
  addBtn: { minHeight: 44, borderRadius: 12, backgroundColor: BRAND.sunGold, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
});
