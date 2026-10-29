/**
 * ClinicCards — booking at Clalit from the chat (27.10, Koral's approved mockup).
 *
 * BookingCard: "תקבעי לי תור לרופא" → Clalit cannot be booked for her (no API,
 * ID + SMS login), so the card opens the booking screen: the Clalit app (gold),
 * the site, or *2700. Nothing of hers passes through Meira.
 *
 * ApptCard: the confirmation SMS she shared or pasted, parsed on the phone
 * (utils/clalitSms) → doctor, day, hour, clinic → "save to my diary". The
 * result is said in a chat line, leave time included, or why it failed.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';
import { ClinicAppointment } from '../utils/clalitSms';
import { dialClalit, openClalitApp, openClalitWeb, saveClinicAppointment } from '../services/ClinicAppointmentService';

interface Base {
  he: boolean;
  /** Meira's one-line confirmation of what a button did, as a chat message. */
  onSay: (text: string) => void;
}

export function BookingCard({ he, onSay }: Base) {
  const rtl = he ? styles.rtl : null;
  const tried = (ok: boolean, what: string) => {
    if (!ok) onSay(he ? `לא הצלחתי לפתוח את ${what}.` : `Couldn't open ${what}.`);
  };
  return (
    <View style={styles.card}>
      <Text style={[styles.title, rtl]}>🩺 {he ? 'תור בכללית' : 'Clalit appointment'}</Text>
      <TouchableOpacity style={[styles.btn, styles.btnGold]} accessibilityRole="button"
        onPress={async () => tried(await openClalitApp(), he ? 'אפליקציית כללית' : 'the Clalit app')}>
        <Text style={styles.btnGoldText}>{he ? 'פתחי את אפליקציית כללית' : 'Open the Clalit app'}</Text>
      </TouchableOpacity>
      <View style={[styles.row, he ? styles.rowRtl : null]}>
        <TouchableOpacity style={[styles.btn, styles.flex]} accessibilityRole="button"
          onPress={async () => tried(await dialClalit(), he ? 'החייגן' : 'the dialer')}>
          <Text style={styles.btnText}>📞 {he ? 'חייגי ‎*2700' : 'Call *2700'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.flex]} accessibilityRole="button"
          onPress={async () => tried(await openClalitWeb(), he ? 'אתר כללית' : 'the Clalit site')}>
          <Text style={styles.btnText}>🌐 {he ? 'באתר' : 'Website'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={[styles.sub, rtl]}>
        {he ? 'כשתקבעי, שתפי לי את ה-SMS ואכניס ליומן.' : "Once booked, share the SMS with me and I'll put it in your diary."}
      </Text>
    </View>
  );
}

const dayLabel = (iso: string, he: boolean) => {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString(he ? 'he-IL' : 'en-GB', { weekday: 'short' });
  return `${day} ${d}.${m}`;
};

interface ApptProps extends Base {
  appt: ClinicAppointment;
  /** "Fix" — put the details in the box for her to correct and send. */
  onEdit: (text: string) => void;
}

export function ApptCard({ appt, he, onSay, onEdit }: ApptProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const rtl = he ? styles.rtl : null;
  const who = [appt.specialty, appt.doctor].filter(Boolean).join(' · ');

  const save = async () => {
    if (busy || done) return;
    setBusy(true);
    const r = await saveClinicAppointment(appt, he);
    setBusy(false);
    if (!r.ok) {
      onSay(he ? `לא שמרתי את התור: ${r.reason}` : `Couldn't save the appointment: ${r.reason}`);
      return;
    }
    setDone(true);
    const when = `${dayLabel(appt.date, he)} ${appt.time}`;
    if (r.already) {
      onSay(he ? `התור הזה כבר ביומן · ${when}` : `That appointment is already in your diary · ${when}`);
      return;
    }
    onSay(he
      ? `✓ התור נשמר · ${when}${r.leaveAt ? ` · יציאה ${r.leaveAt}` : ''}${r.noPlace ? ' · לא מצאתי את כתובת המרפאה, תוסיפי אותה בכרטיס' : ''}`
      : `✓ Appointment saved · ${when}${r.leaveAt ? ` · leave ${r.leaveAt}` : ''}${r.noPlace ? " · I couldn't find the clinic's address, add it on the card" : ''}`);
  };

  return (
    <View style={styles.card}>
      <Text style={[styles.title, rtl]}>⚕️ {who || (he ? 'תור בכללית' : 'Clalit appointment')}</Text>
      <Text style={[styles.line, rtl]}>{dayLabel(appt.date, he)} · {appt.time}</Text>
      {appt.clinic ? <Text style={[styles.sub, rtl]}>{appt.clinic}</Text> : null}
      <View style={[styles.row, he ? styles.rowRtl : null]}>
        <TouchableOpacity style={[styles.btn, styles.btnGold, styles.flex2, done ? styles.btnDone : null]}
          accessibilityRole="button" disabled={busy || done} onPress={save}>
          <Text style={styles.btnGoldText}>
            {done ? (he ? '✓ נשמר' : '✓ Saved') : busy ? (he ? 'שומרת…' : 'Saving…') : (he ? 'שמרי ביומן' : 'Save to my diary')}
          </Text>
        </TouchableOpacity>
        {!done ? (
          <TouchableOpacity style={[styles.btn, styles.flex]} accessibilityRole="button"
            onPress={() => onEdit(he
              ? `תור לרופא בכללית ב-${appt.date.split('-').reverse().join('.')} בשעה ${appt.time}${appt.clinic ? ` ב${appt.clinic}` : ''}`
              : `Doctor appointment at Clalit on ${appt.date} at ${appt.time}${appt.clinic ? ` at ${appt.clinic}` : ''}`)}>
            <Text style={styles.btnText}>{he ? 'לתקן' : 'Fix'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: 16, borderWidth: 1, borderColor: BRAND.line,
    padding: 12, marginTop: 6, maxWidth: '92%', alignSelf: 'stretch', gap: 6,
  },
  title: { fontFamily: FONTS.bodyBold, fontSize: 15, color: BRAND.warmInk },
  line: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.warmInk },
  sub: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  row: { flexDirection: 'row', gap: 6 },
  rowRtl: { flexDirection: 'row-reverse' },
  flex: { flex: 1 },
  flex2: { flex: 2 },
  btn: {
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8, minHeight: MIN_TOUCH, justifyContent: 'center', alignItems: 'center',
  },
  btnText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk },
  btnGold: { backgroundColor: BRAND.sunGold, borderColor: BRAND.goldInk },
  btnGoldText: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.onGold },
  btnDone: { opacity: 0.7 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
});
