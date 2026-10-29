/**
 * AgentsScreen — manage the user's personal agents ("Agent Builder").
 *
 * An agent is a WhatsApp message Meira sends on a schedule: a ready-made one
 * (Morning Planner / Evening Planner) installed in one tap, or her own — a
 * name, what it should write, the days and the hour. Tap a card to change any
 * of that; "Try now" sends it immediately so she can see what it writes
 * without waiting for its hour.
 *
 * Agents execute SERVER-side (server/agent_runner.py) — this screen only edits
 * their definitions via AgentsService. Every failure says why (rule 1/3): a
 * list that could not load is never shown as "no agents yet".
 *
 * Dependencies: AgentsService (REST), TaskStorage.getSettings (phone),
 * UserProfileStorage (language), constants/theme. Registered in App.tsx as
 * 'Agents'; entry from SettingsMenu.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { getSettings } from '../services/TaskStorage';
import { loadProfile } from '../services/UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';
import {
  AgentTemplate,
  LumiAgent,
  createAgent,
  deleteAgent,
  listAgents,
  runAgentNow,
  updateAgent,
} from '../services/AgentsService';
import { WashedSky } from '../components/ui/SkyBackdrop';

// UI order Sun..Sat, mapped to Python weekday ints (Mon=0..Sun=6).
const WEEKDAYS: Array<{ en: string; he: string; py: number }> = [
  { en: 'S', he: 'א', py: 6 }, { en: 'M', he: 'ב', py: 0 }, { en: 'T', he: 'ג', py: 1 },
  { en: 'W', he: 'ד', py: 2 }, { en: 'T', he: 'ה', py: 3 }, { en: 'F', he: 'ו', py: 4 },
  { en: 'S', he: 'ש', py: 5 },
];

const T = {
  en: {
    title: '🤖 My Agents',
    intro: 'An agent is a WhatsApp message from Meira, on the days and hour you pick. Tap one to change it.',
    needPhone: 'Set your WhatsApp number in Edit Profile first — agents message you there.',
    loadFailed: (why: string) => `Couldn't load your agents — ${why}.`,
    retry: 'Try again',
    readyMade: 'Ready-made',
    installs: 'installs in one tap',
    install: 'Install', installed: 'Installed ✓',
    yours: (n: number, max: number) => `Yours (${n}/${max})`,
    none: 'No agents yet — install one above or create your own.',
    ran: (n: number) => `ran ${n}×`,
    tryNow: '▶ Try now', sent: 'Sent — check WhatsApp.',
    newAgent: 'New agent', editAgent: 'Edit agent',
    create: '➕ Create custom agent', max: (m: number) => `Max ${m} agents`,
    namePh: 'Name (e.g. Evening Coach)',
    soulPh: 'What should it write? (e.g. "remind me what to bring tomorrow")',
    save: 'Save', createBtn: 'Create', cancel: 'Cancel',
    missing: 'Need a name, what it does, at least one day, and a valid HH:MM time.',
    missingTitle: 'Missing details',
    failed: 'Failed', deleteQ: 'Delete agent?', willStop: 'will stop running.', del: 'Delete',
  },
  he: {
    title: '🤖 הסוכנים שלי',
    intro: 'סוכן = הודעת WhatsApp ממאירה, בימים ובשעה שתבחרי. לחיצה על סוכן — לשנות אותו.',
    needPhone: 'קודם הגדירי מספר WhatsApp בעריכת פרופיל — הסוכנים שולחים לשם.',
    loadFailed: (why: string) => `לא הצלחתי לטעון את הסוכנים — ${why}.`,
    retry: 'לנסות שוב',
    readyMade: 'מוכנים',
    installs: 'התקנה בלחיצה',
    install: 'התקנה', installed: 'מותקן ✓',
    yours: (n: number, max: number) => `שלך (${n}/${max})`,
    none: 'אין עדיין סוכנים — התקיני אחד למעלה או צרי משלך.',
    ran: (n: number) => `רץ ${n} פעמים`,
    tryNow: '▶ נסי עכשיו', sent: 'נשלח — בדקי ב-WhatsApp.',
    newAgent: 'סוכן חדש', editAgent: 'עריכת סוכן',
    create: '➕ סוכן משלך', max: (m: number) => `מקסימום ${m} סוכנים`,
    namePh: 'שם (למשל: מאמנת ערב)',
    soulPh: 'מה הוא יכתוב? (למשל: "תזכירי לי מה לקחת מחר")',
    save: 'שמירה', createBtn: 'יצירה', cancel: 'ביטול',
    missing: 'צריך שם, מה הוא עושה, לפחות יום אחד ושעה תקינה (HH:MM).',
    missingTitle: 'חסרים פרטים',
    failed: 'נכשל', deleteQ: 'למחוק את הסוכן?', willStop: 'יפסיק לרוץ.', del: 'מחיקה',
  },
};

/** The fix, in words — not an error code. */
function reason(err: string, he: boolean): string {
  const map: Record<string, [string, string]> = {
    'no server': ['the app has no server address (build problem)', 'לאפליקציה אין כתובת שרת (בעיית build)'],
    'no phone': ['no WhatsApp number in your profile', 'אין מספר WhatsApp בפרופיל'],
    'signed out': ['you are signed out — sign in again', 'את מנותקת — התחברי מחדש'],
    network: ['no connection to the server', 'אין חיבור לשרת'],
    limit: ['you reached the agent limit', 'הגעת למקסימום סוכנים'],
    not_found: ['this agent no longer exists', 'הסוכן הזה כבר לא קיים'],
    empty: ['it had nothing to write — try changing what it should do', 'לא היה לו מה לכתוב — נסי לנסח אחרת מה הוא עושה'],
    whatsapp_failed: ['WhatsApp refused the message', 'WhatsApp לא קיבל את ההודעה'],
    crashed: ['the server hit an error running it', 'השרת נתקל בשגיאה בהרצה'],
  };
  const hit = map[err];
  return hit ? hit[he ? 1 : 0] : err;
}

export default function AgentsScreen() {
  const navigation = useNavigation();
  const [he, setHe] = useState(false);
  const t = he ? T.he : T.en;
  const [phone, setPhone] = useState('');
  const [agents, setAgents] = useState<LumiAgent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [max, setMax] = useState(5);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  // One form for both create and edit: editingId null = a new agent.
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [days, setDays] = useState<number[]>([6, 0, 1, 2, 3]); // Sun-Thu
  const [time, setTime] = useState('08:00');

  const refresh = useCallback(async (p: string) => {
    const data = await listAgents(p);
    setLoadError(data.error ?? null);
    setAgents(data.agents);
    setTemplates(data.templates);
    setMax(data.max);
  }, []);

  useEffect(() => {
    (async () => {
      const prof = normalizeProfile(await loadProfile().catch(() => null));
      setHe(prof?.language === 'he');
      const settings = await getSettings();
      const p = String(settings?.whatsAppPhone || '').replace(/[^\d]/g, '');
      setPhone(p);
      if (p) await refresh(p);
      setLoading(false);
    })();
  }, [refresh]);

  const installed = new Set(agents.map((a) => a.template).filter(Boolean));
  const atCap = agents.length >= max;
  const fail = (err: string) => Alert.alert(t.failed, reason(err, he));

  const install = async (tpl: AgentTemplate) => {
    setBusy(true);
    const res = await createAgent(phone, { template: tpl.id });
    setBusy(false);
    if (res.error) fail(res.error);
    else await refresh(phone);
  };

  const openNew = () => {
    setEditingId(null);
    setName(''); setSoul(''); setDays([6, 0, 1, 2, 3]); setTime('08:00');
    setShowForm(true);
  };

  const openEdit = (a: LumiAgent) => {
    setEditingId(a.id);
    setName(a.name); setSoul(a.soul || '');
    setDays(a.schedule?.days || []); setTime(a.schedule?.time || '08:00');
    setShowForm(true);
  };

  const submit = async () => {
    if (!name.trim() || !soul.trim() || !days.length || !/^\d{1,2}:\d{2}$/.test(time)) {
      Alert.alert(t.missingTitle, t.missing);
      return;
    }
    setBusy(true);
    const def = { name: name.trim(), soul: soul.trim(), days, time };
    let err: string | undefined;
    if (editingId) {
      const upd = await updateAgent(phone, editingId, def);
      if (!upd) err = 'network';
    } else {
      err = (await createAgent(phone, def)).error;
    }
    setBusy(false);
    if (err) { fail(err); return; }
    setShowForm(false);
    setEditingId(null);
    await refresh(phone);
  };

  const toggle = async (a: LumiAgent) => {
    setAgents((prev) => prev.map((x) => (x.id === a.id ? { ...x, enabled: !a.enabled } : x)));
    const upd = await updateAgent(phone, a.id, { enabled: !a.enabled });
    if (!upd) { fail('network'); await refresh(phone); } // server refused — say so, resync truth
  };

  const tryNow = async (a: LumiAgent) => {
    setRunning(a.id);
    const res = await runAgentNow(phone, a.id);
    setRunning(null);
    if (res.error) fail(res.error);
    else Alert.alert(`${a.emoji} ${a.name}`, t.sent);
  };

  const remove = (a: LumiAgent) =>
    Alert.alert(t.deleteQ, `${a.emoji} ${a.name} ${t.willStop}`, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.del, style: 'destructive',
        onPress: async () => {
          if (!(await deleteAgent(phone, a.id))) fail('network');
          await refresh(phone);
        },
      },
    ]);

  const scheduleLabel = (a: LumiAgent) => {
    const set = new Set(a.schedule?.days || []);
    const daysTxt = WEEKDAYS.filter((w) => set.has(w.py)).map((w) => (he ? w.he : w.en)).join(he ? ' ' : '');
    return `${daysTxt || '—'} · ${a.schedule?.time || ''}`;
  };

  return (
    <View style={styles.container}>
      <WashedSky />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t.title}</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={BRAND.sunGold} style={{ marginTop: 40 }} />
      ) : !phone ? (
        <Text style={styles.hint}>{t.needPhone}</Text>
      ) : loadError ? (
        <View style={styles.card}>
          <Text style={styles.errorTxt}>{t.loadFailed(reason(loadError, he))}</Text>
          <TouchableOpacity style={styles.installBtn} onPress={() => refresh(phone)}>
            <Text style={styles.installTxt}>{t.retry}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
          <Text style={styles.hint}>{t.intro}</Text>

          <Text style={styles.section}>{t.readyMade}</Text>
          {templates.map((tpl) => (
            <View key={tpl.id} style={styles.card}>
              <View style={styles.cardRow}>
                <Text style={styles.cardEmoji}>{tpl.emoji}</Text>
                <View style={styles.flex}>
                  <Text style={styles.cardName}>{tpl.name}</Text>
                  <Text style={styles.cardMeta}>{tpl.schedule.time} · {t.installs}</Text>
                </View>
                <TouchableOpacity
                  style={[styles.installBtn, (installed.has(tpl.id) || atCap || busy) && styles.btnOff]}
                  disabled={installed.has(tpl.id) || atCap || busy}
                  onPress={() => install(tpl)}
                >
                  <Text style={styles.installTxt}>{installed.has(tpl.id) ? t.installed : t.install}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.cardSoul} numberOfLines={2}>{tpl.soul}</Text>
            </View>
          ))}

          <Text style={styles.section}>{t.yours(agents.length, max)}</Text>
          {agents.length === 0 && <Text style={styles.hint}>{t.none}</Text>}
          {agents.map((a) => (
            <TouchableOpacity key={a.id} style={styles.card} activeOpacity={0.8} onPress={() => openEdit(a)}>
              <View style={styles.cardRow}>
                <Text style={styles.cardEmoji}>{a.emoji}</Text>
                <View style={styles.flex}>
                  <Text style={styles.cardName}>{a.name}</Text>
                  <Text style={styles.cardMeta}>
                    {scheduleLabel(a)}{a.run_count ? ` · ${t.ran(a.run_count)}` : ''}
                  </Text>
                </View>
                <Switch value={a.enabled} onValueChange={() => toggle(a)} trackColor={{ true: BRAND.sunGold }} />
                <TouchableOpacity onPress={() => remove(a)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.delete}>🗑</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.cardSoul} numberOfLines={2}>{a.soul}</Text>
              <TouchableOpacity
                style={[styles.tryBtn, running === a.id && styles.btnOff]}
                disabled={running !== null}
                onPress={() => tryNow(a)}
              >
                {running === a.id
                  ? <ActivityIndicator color={BRAND.sunGold} size="small" />
                  : <Text style={styles.tryTxt}>{t.tryNow}</Text>}
              </TouchableOpacity>
            </TouchableOpacity>
          ))}

          {!showForm ? (
            <TouchableOpacity style={[styles.newBtn, atCap && styles.btnOff]} disabled={atCap} onPress={openNew}>
              <Text style={styles.newTxt}>{atCap ? t.max(max) : t.create}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardName}>{editingId ? t.editAgent : t.newAgent}</Text>
              <TextInput
                style={styles.input} value={name} onChangeText={setName}
                placeholder={t.namePh} placeholderTextColor={BRAND.inkSoft}
              />
              <TextInput
                style={[styles.input, styles.soulInput]} value={soul} onChangeText={setSoul}
                placeholder={t.soulPh} placeholderTextColor={BRAND.inkSoft}
                multiline
              />
              <View style={styles.dayRow}>
                {WEEKDAYS.map((w) => {
                  const on = days.includes(w.py);
                  return (
                    <TouchableOpacity
                      key={w.py}
                      style={[styles.dayChip, on && styles.dayChipOn]}
                      onPress={() => setDays((prev) =>
                        on ? prev.filter((d) => d !== w.py) : [...prev, w.py])}
                    >
                      <Text style={[styles.dayTxt, on && styles.dayTxtOn]}>{he ? w.he : w.en}</Text>
                    </TouchableOpacity>
                  );
                })}
                <TextInput
                  style={[styles.input, styles.timeInput]} value={time} onChangeText={setTime}
                  placeholder="08:00" placeholderTextColor={BRAND.inkSoft} keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.formActions}>
                <TouchableOpacity style={[styles.installBtn, styles.flex]} disabled={busy} onPress={submit}>
                  {busy ? <ActivityIndicator color="white" size="small" />
                    : <Text style={styles.installTxt}>{editingId ? t.save : t.createBtn}</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.cancelBtn, styles.flex]}
                  onPress={() => { setShowForm(false); setEditingId(null); }}
                >
                  <Text style={styles.cancelTxt}>{t.cancel}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.cream, paddingHorizontal: 16, paddingTop: 56 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  back: { fontSize: 22, color: BRAND.warmInk, width: 24 },
  title: { fontSize: 18, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  section: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft, marginTop: 14, marginBottom: 8 },
  hint: { fontSize: 13, fontFamily: FONTS.body, color: BRAND.inkSoft, marginVertical: 8 },
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    padding: 12, marginBottom: 10, gap: 8,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardEmoji: { fontSize: 24 },
  cardName: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  cardMeta: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft },
  cardSoul: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft },
  flex: { flex: 1 },
  installBtn: {
    backgroundColor: BRAND.sunGold, borderRadius: RADIUS.chip,
    paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center',
  },
  installTxt: { color: 'white', fontFamily: FONTS.bodyBold, fontSize: 13 },
  btnOff: { opacity: 0.45 },
  delete: { fontSize: 16, marginLeft: 6 },
  newBtn: {
    borderWidth: 1.5, borderColor: BRAND.sunGold, borderStyle: 'dashed',
    borderRadius: RADIUS.card, paddingVertical: 12, alignItems: 'center', marginTop: 4,
  },
  newTxt: { color: BRAND.sunGold, fontFamily: FONTS.bodyBold, fontSize: 14 },
  input: {
    borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.chip,
    paddingHorizontal: 12, paddingVertical: 8, fontSize: 14,
    color: BRAND.warmInk, backgroundColor: BRAND.cream,
  },
  soulInput: { minHeight: 64, textAlignVertical: 'top' },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dayChip: {
    width: 30, height: 30, borderRadius: RADIUS.chip, borderWidth: 1.5,
    borderColor: BRAND.line, alignItems: 'center', justifyContent: 'center',
  },
  dayChipOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  dayTxt: { fontSize: 12, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft },
  dayTxtOn: { color: 'white' },
  timeInput: { flex: 1, marginLeft: 6, textAlign: 'center' },
  formActions: { flexDirection: 'row', gap: 8 },
  cancelBtn: {
    backgroundColor: BRAND.line, borderRadius: RADIUS.chip,
    paddingVertical: 8, alignItems: 'center',
  },
  errorTxt: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  tryBtn: {
    alignSelf: 'flex-start', borderWidth: 1.5, borderColor: BRAND.sunGold,
    borderRadius: RADIUS.chip, paddingHorizontal: 12, paddingVertical: 6,
  },
  tryTxt: { color: BRAND.sunGold, fontFamily: FONTS.bodyBold, fontSize: 13 },
  cancelTxt: { color: BRAND.warmInk, fontFamily: FONTS.bodySemi, fontSize: 13 },
});
