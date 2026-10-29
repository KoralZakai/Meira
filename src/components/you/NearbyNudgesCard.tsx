/**
 * NearbyNudgesCard — turn on "you're near X — do it now?" (GeofenceService).
 *
 * The disclosure Google Play requires before background location sits on the
 * card itself, above the button: what is used (location, also when the app is
 * closed), for what (open errands with a place), and that it stays on the
 * phone. The status line is the LAST REAL OUTCOME, never a hopeful "on"
 * (rule 3): no permission, nothing to watch and N places each read differently,
 * and each failure names its fix.
 */
import React from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import LineIcon from '../ui/LineIcon';
import {
  GeofenceStatus, disableNearbyNudges, enableNearbyNudges, geofenceStatus, placeReminders, removePlaceReminder,
  syncGeofences,
} from '../../services/GeofenceService';
import { PlaceReminder, heWhen } from '../../utils/geofencePick';

export function statusLine(s: GeofenceStatus | null, he: boolean): { text: string; bad: boolean; fixInSettings?: boolean } {
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  if (!s || s.reason === 'off') return { text: T('Off', 'כבוי'), bad: false };
  switch (s.reason) {
    case 'ok': return { text: T(`On — watching ${s.count} place${s.count === 1 ? '' : 's'}`, `פועל — שומרת על ${s.count} מקומות`), bad: false };
    case 'none_to_watch': return { text: T('On — no open errand with a place right now', 'פועל — אין כרגע משימה פתוחה עם מקום'), bad: false };
    case 'no_foreground_permission': return { text: T('Location is off for Meira — turn it on in Settings', 'המיקום כבוי למאירה — להפעיל בהגדרות'), bad: true, fixInSettings: true };
    case 'no_background_permission': return { text: T('Needs location "Allow all the time" — in Settings', 'צריך מיקום "לאפשר כל הזמן" — בהגדרות'), bad: true, fixInSettings: true };
    // In words that name the fix (rule 3) — the raw Android error goes to the log, not to her.
    case 'register_failed': return { text: T('Android would not save the places — check Google Location accuracy is on, then turn this off and on', 'אנדרואיד לא שמר את המקומות — לבדוק ש"דיוק המיקום של Google" פועל, ואז לכבות ולהפעיל'), bad: true, fixInSettings: true };
    case 'permission_request_failed': return { text: T('Could not ask for location — try again, or allow it in Settings', 'לא הצלחתי לבקש מיקום — לנסות שוב, או לאשר בהגדרות'), bad: true, fixInSettings: true };
    case 'expo_go': return { text: T('Not available in Expo Go', 'לא זמין ב־Expo Go'), bad: true };
    default: return { text: T('Location unavailable on this build', 'מיקום לא זמין בגרסה הזו'), bad: true };
  }
}

export default function NearbyNudgesCard({ he }: { he: boolean }) {
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const [status, setStatus] = React.useState<GeofenceStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reminders, setReminders] = React.useState<PlaceReminder[]>([]);
  useFocusEffect(React.useCallback(() => {
    placeReminders().then(setReminders);
    // Re-checked whenever she comes back — e.g. from the Settings page the button sent her to.
    let alive = true;
    geofenceStatus().then(async (s) => {
      const fresh = s && s.reason !== 'off' ? await syncGeofences() : s;
      if (alive) setStatus(fresh);
    });
    return () => { alive = false; };
  }, []));
  const on = !!status && status.reason !== 'off';
  const line = statusLine(status, he);
  const rtl = he && styles.rtl;
  const act = async () => {
    setBusy(true);
    try { setStatus(on ? await disableNearbyNudges() : await enableNearbyNudges()); } finally { setBusy(false); }
  };
  return (
    <View style={styles.wrap}>
      <View style={[styles.head, he && styles.rowRtl]}>
        <View style={styles.icon}><LineIcon name="map" size={18} color={BRAND.goldInk} /></View>
        <Text style={[styles.title, rtl]}>{T('Nearby errands', 'התראות לפי מיקום')}</Text>
      </View>
      <Text style={[styles.body, rtl]}>
        {T('When you pass near the place of an open errand (no fixed hour), Meira asks if you want to do it now; she gives the reminders you set by place ("when I get to work…"); and if a meeting\'s leave time passed while you are still home, she asks if you are still going — also when the app is closed. To do that she uses your location in the background. It stays on your phone: no location is sent to Meira\'s server. Never at night, at most once in 6 hours per errand. You can turn it off here anytime.',
          'כשאת עוברת ליד מקום של משימה פתוחה (בלי שעה קבועה), מאירה שואלת אם לעשות אותה עכשיו; מזכירה תזכורות שביקשת לפי מקום ("כשאגיע לעבודה…"); ואם שעת היציאה לפגישה עברה ואת עדיין בבית, שואלת אם את עדיין הולכת — גם כשהאפליקציה סגורה. בשביל זה היא משתמשת במיקום שלך ברקע. המיקום נשאר בטלפון: שום מיקום לא נשלח לשרת של מאירה. לא בלילה, ולכל משימה לכל היותר פעם ב־6 שעות. אפשר לכבות כאן בכל רגע.')}
      </Text>
      <Text style={[styles.status, line.bad && styles.statusBad, rtl]}>{line.text}</Text>
      {/* Her "when I get to… / when I leave…" reminders — visible, and removable (rule 5). */}
      {reminders.map((r) => (
        <View key={r.id} style={[styles.rem, he && styles.rowRtl]}>
          <Text style={[styles.remText, rtl]} numberOfLines={2}>
            {he
              ? `${r.trigger === 'arrive' ? '📍' : '🚪'} ${heWhen(r.trigger, r.label, true)}: ${r.text}`
              : `${r.trigger === 'arrive' ? '📍 At ' : '🚪 Leaving '}${r.label}: ${r.text}`}
          </Text>
          <TouchableOpacity style={styles.remX} accessibilityRole="button" accessibilityLabel={T('Remove', 'למחוק')}
            onPress={async () => { await removePlaceReminder(r.id); setReminders(await placeReminders()); }}>
            <Text style={styles.remXText}>×</Text>
          </TouchableOpacity>
        </View>
      ))}
      <View style={[styles.btns, he && styles.rowRtl]}>
        <TouchableOpacity style={[styles.btn, on && styles.btnSoft]} onPress={act} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={BRAND.onGold} /> : (
            <Text style={styles.btnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{on ? T('Turn off', 'לכבות') : T('Turn on', 'להפעיל')}</Text>
          )}
        </TouchableOpacity>
        {line.fixInSettings ? (
          <TouchableOpacity style={[styles.btn, styles.btnSoft]} accessibilityRole="button"
            onPress={() => Linking.openSettings().catch((e) => console.warn('[NearbyNudges] settings', e))}>
            <Text style={styles.btnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{T('Open Settings', 'להגדרות')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: 14, gap: 8, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowRtl: { flexDirection: 'row-reverse' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  icon: { width: 34, height: 34, borderRadius: 17, backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontFamily: FONTS.display, fontSize: 17, color: BRAND.warmInk },
  body: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 19, color: BRAND.inkSoft },
  status: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  statusBad: { color: BRAND.danger },
  btns: { flexDirection: 'row', gap: 8 },
  rem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  remText: { flex: 1, fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk },
  remX: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  remXText: { fontSize: 22, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft },
  btn: { flex: 1, minWidth: 0, paddingHorizontal: 12, minHeight: MIN_TOUCH, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: BRAND.sunGold },
  btnSoft: { backgroundColor: BRAND.goldSoft },
  btnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
});
