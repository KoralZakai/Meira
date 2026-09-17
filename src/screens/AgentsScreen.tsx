/**
 * AgentsScreen — manage the user's personal agents ("Agent Builder"):
 * one-tap template gallery (Morning Planner / Smart Alarm), the user's agents
 * with enable/disable + delete, and a custom-agent form (name, persona,
 * weekday chips, HH:MM time).
 *
 * Agents execute SERVER-side (server/agent_runner.py) and message the user on
 * WhatsApp — this screen only edits their definitions via AgentsService.
 * Phone comes from app settings (whatsAppPhone), same as WhatsAppTaskSync.
 *
 * Dependencies: AgentsService (REST), TaskStorage.getSettings (phone),
 * constants/theme. Registered in App.tsx as 'Agents'; entry from SettingsMenu.
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
import {
  AgentTemplate,
  LumiAgent,
  createAgent,
  deleteAgent,
  listAgents,
  updateAgent,
} from '../services/AgentsService';

// UI order Sun..Sat, mapped to Python weekday ints (Mon=0..Sun=6).
const WEEKDAYS: Array<{ label: string; py: number }> = [
  { label: 'S', py: 6 }, { label: 'M', py: 0 }, { label: 'T', py: 1 },
  { label: 'W', py: 2 }, { label: 'T', py: 3 }, { label: 'F', py: 4 },
  { label: 'S', py: 5 },
];

export default function AgentsScreen() {
  const navigation = useNavigation();
  const [phone, setPhone] = useState('');
  const [agents, setAgents] = useState<LumiAgent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [max, setMax] = useState(5);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Custom-agent form
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [days, setDays] = useState<number[]>([6, 0, 1, 2, 3]); // Sun-Thu
  const [time, setTime] = useState('08:00');

  const refresh = useCallback(async (p: string) => {
    const data = await listAgents(p);
    setAgents(data.agents);
    setTemplates(data.templates);
    setMax(data.max);
  }, []);

  useEffect(() => {
    (async () => {
      const settings = await getSettings();
      const p = String(settings?.whatsAppPhone || '').replace(/[^\d]/g, '');
      setPhone(p);
      if (p) await refresh(p);
      setLoading(false);
    })();
  }, [refresh]);

  const installed = new Set(agents.map((a) => a.template).filter(Boolean));
  const atCap = agents.length >= max;

  const install = async (tpl: AgentTemplate) => {
    setBusy(true);
    const res = await createAgent(phone, { template: tpl.id });
    setBusy(false);
    if (res.error) Alert.alert('Could not install', res.error === 'limit' ? `Max ${max} agents` : res.error);
    else await refresh(phone);
  };

  const submitCustom = async () => {
    if (!name.trim() || !soul.trim() || !days.length || !/^\d{1,2}:\d{2}$/.test(time)) {
      Alert.alert('Missing details', 'Need a name, what it does, at least one day, and a valid HH:MM time.');
      return;
    }
    setBusy(true);
    const res = await createAgent(phone, { name: name.trim(), soul: soul.trim(), days, time });
    setBusy(false);
    if (res.error) Alert.alert('Could not create', res.error === 'limit' ? `Max ${max} agents` : res.error);
    else {
      setShowForm(false);
      setName(''); setSoul('');
      await refresh(phone);
    }
  };

  const toggle = async (a: LumiAgent) => {
    setAgents((prev) => prev.map((x) => (x.id === a.id ? { ...x, enabled: !a.enabled } : x)));
    const upd = await updateAgent(phone, a.id, { enabled: !a.enabled });
    if (!upd) await refresh(phone); // server refused — resync truth
  };

  const remove = (a: LumiAgent) =>
    Alert.alert('Delete agent?', `${a.emoji} ${a.name} will stop running.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => { await deleteAgent(phone, a.id); await refresh(phone); },
      },
    ]);

  const scheduleLabel = (a: LumiAgent) => {
    const set = new Set(a.schedule?.days || []);
    const daysTxt = WEEKDAYS.filter((w) => set.has(w.py)).map((w) => w.label).join('');
    return `${daysTxt || '—'} · ${a.schedule?.time || ''}`;
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>🤖 My Agents</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={BRAND.sunGold} style={{ marginTop: 40 }} />
      ) : !phone ? (
        <Text style={styles.hint}>
          Set your WhatsApp number in Edit Profile first — agents message you there.
        </Text>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
          {/* Template gallery */}
          <Text style={styles.section}>Ready-made</Text>
          {templates.map((t) => (
            <View key={t.id} style={styles.card}>
              <View style={styles.cardRow}>
                <Text style={styles.cardEmoji}>{t.emoji}</Text>
                <View style={styles.flex}>
                  <Text style={styles.cardName}>{t.name}</Text>
                  <Text style={styles.cardMeta}>{t.schedule.time} · installs in one tap</Text>
                </View>
                <TouchableOpacity
                  style={[styles.installBtn, (installed.has(t.id) || atCap || busy) && styles.btnOff]}
                  disabled={installed.has(t.id) || atCap || busy}
                  onPress={() => install(t)}
                >
                  <Text style={styles.installTxt}>{installed.has(t.id) ? 'Installed ✓' : 'Install'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.cardSoul} numberOfLines={2}>{t.soul}</Text>
            </View>
          ))}

          {/* User's agents */}
          <Text style={styles.section}>Yours ({agents.length}/{max})</Text>
          {agents.length === 0 && <Text style={styles.hint}>No agents yet — install one above or create your own.</Text>}
          {agents.map((a) => (
            <View key={a.id} style={styles.card}>
              <View style={styles.cardRow}>
                <Text style={styles.cardEmoji}>{a.emoji}</Text>
                <View style={styles.flex}>
                  <Text style={styles.cardName}>{a.name}</Text>
                  <Text style={styles.cardMeta}>
                    {scheduleLabel(a)}{a.run_count ? ` · ran ${a.run_count}×` : ''}
                  </Text>
                </View>
                <Switch value={a.enabled} onValueChange={() => toggle(a)} trackColor={{ true: BRAND.sunGold }} />
                <TouchableOpacity onPress={() => remove(a)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.delete}>🗑</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {/* Custom agent form */}
          {!showForm ? (
            <TouchableOpacity
              style={[styles.newBtn, atCap && styles.btnOff]}
              disabled={atCap}
              onPress={() => setShowForm(true)}
            >
              <Text style={styles.newTxt}>{atCap ? `Max ${max} agents` : '➕ Create custom agent'}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardName}>New agent</Text>
              <TextInput
                style={styles.input} value={name} onChangeText={setName}
                placeholder="Name (e.g. Evening Coach)" placeholderTextColor={BRAND.inkSoft}
              />
              <TextInput
                style={[styles.input, styles.soulInput]} value={soul} onChangeText={setSoul}
                placeholder="What should it do? (its personality + job)" placeholderTextColor={BRAND.inkSoft}
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
                      <Text style={[styles.dayTxt, on && styles.dayTxtOn]}>{w.label}</Text>
                    </TouchableOpacity>
                  );
                })}
                <TextInput
                  style={[styles.input, styles.timeInput]} value={time} onChangeText={setTime}
                  placeholder="08:00" placeholderTextColor={BRAND.inkSoft} keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.formActions}>
                <TouchableOpacity style={[styles.installBtn, styles.flex]} disabled={busy} onPress={submitCustom}>
                  {busy ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.installTxt}>Create</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={[styles.cancelBtn, styles.flex]} onPress={() => setShowForm(false)}>
                  <Text style={styles.cancelTxt}>Cancel</Text>
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
  cancelTxt: { color: BRAND.warmInk, fontFamily: FONTS.bodySemi, fontSize: 13 },
});
