/**
 * FindTimeScreen — "find time together" (Feature 3, Koral 20.10; results = option A grid).
 *
 *  no groupId  → her groups + "New": name, length, people from contacts, 1–6 slots.
 *                After sending: one share link per person (WhatsApp/SMS from her own phone).
 *  organizer   → the grid: people × slots, ✓/✗/? (why under every ?), best slot, lock.
 *  member      → join or not; per slot Meira's check and her own yes/no.
 *
 * Server: /app/groups/* (server/group_time.py). Every failed call says so in words.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView, Share, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  groupCreate, groupList, groupLock, groupRespond, groupView,
  type GroupListItem, type GroupView,
} from '../services/LumiServer';
import { pickPhoneContact } from '../services/PhoneContactsService';
import { getSettings } from '../services/TaskStorage';
import { loadProfile } from '../services/UserProfileStorage';
import {
  bestLabel, cellMark, cellNote, inviteMessage, slotLabel, validSlots,
} from '../utils/groupGrid';
import { getTodayString } from '../utils/timeUtils';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';
import { WashedSky } from '../components/ui/SkyBackdrop';

type Invite = { name: string; link: string };

function nextDays(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i += 1) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  return out;
}

export default function FindTimeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const groupId: string | undefined = route.params?.groupId;
  const [he, setHe] = useState(true);
  const [ownerName, setOwnerName] = useState('');

  useFocusEffect(useCallback(() => {
    getSettings().then((s) => setHe(s.language !== 'en')).catch((e) => console.warn('[FindTime] settings', e));
    loadProfile().then((p) => setOwnerName(p?.name || '')).catch(() => {});
  }, []));

  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const rtl = he ? styles.rtl : null;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <WashedSky />
      <View style={[styles.header, he && styles.rowRtl]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityRole="button"
          accessibilityLabel={T('Back', 'חזרה')} style={styles.back}>
          <Text style={styles.backText}>{he ? '›' : '‹'}</Text>
        </TouchableOpacity>
        <Text style={[styles.h1, rtl]}>{T('👥 Find time together', '👥 למצוא זמן ביחד')}</Text>
      </View>
      {groupId
        ? <Detail id={groupId} he={he} T={T} />
        : <ListAndCreate he={he} T={T} ownerName={ownerName}
            open={(id) => navigation.push('FindTime', { groupId: id })} />}
    </View>
  );
}

// ── list + create ───────────────────────────────────────────────────────────

function ListAndCreate({ he, T, ownerName, open }: {
  he: boolean; T: (en: string, h: string) => string; ownerName: string; open: (id: string) => void;
}) {
  const rtl = he ? styles.rtl : null;
  const [groups, setGroups] = useState<GroupListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(120);
  const [people, setPeople] = useState<Array<{ name: string; phone: string }>>([]);
  const [slots, setSlots] = useState<Array<{ day: string; start: string }>>([]);
  const [day, setDay] = useState(nextDays(1)[0]);
  const [time, setTime] = useState('20:00');
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [newId, setNewId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    groupList().then((r) => {
      if (!r.ok) { setError(r.reason); setGroups([]); return; }
      if (!r.data.ok) { setError(r.data.reason || 'failed'); setGroups([]); return; }
      setGroups(r.data.groups || []);
    });
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const addPerson = async () => {
    const c = await pickPhoneContact();
    if (!c) return;
    if (!c.phone) { Alert.alert(T('No phone number', 'אין מספר טלפון'), T('That contact has no number.', 'לאיש הקשר הזה אין מספר.')); return; }
    setPeople((p) => (p.some((x) => x.phone === c.phone) ? p : [...p, { name: c.name || c.phone!, phone: c.phone! }]));
  };

  const addSlot = () => {
    const next = validSlots([...slots, { day, start: time.trim() }], getTodayString());
    if (next.length === slots.length) {
      Alert.alert(T('Not added', 'לא נוסף'), T('Check the time (HH:MM), the day, or the 6-slot limit.', 'בדקי את השעה (HH:MM), את היום, או את המגבלה של 6 מועדים.'));
      return;
    }
    setSlots(next);
  };

  const send = async () => {
    if (!people.length || !slots.length) {
      Alert.alert(T('Almost', 'כמעט'), T('Add at least one person and one time.', 'הוסיפי לפחות איש קשר אחד ומועד אחד.'));
      return;
    }
    setBusy(true);
    const r = await groupCreate({ title: title.trim(), minutes, ownerName, slots, members: people });
    setBusy(false);
    if (!r.ok || !r.data.ok) {
      Alert.alert(T("Couldn't create it", 'לא הצלחתי ליצור'), r.ok ? (r.data.reason || '') : r.reason);
      return;
    }
    setInvites(r.data.invites || []);
    setNewId(r.data.groupId || null);
    load();
  };

  const shareOne = (inv: Invite) => {
    Share.share({ message: inviteMessage(title.trim(), inv.link, ownerName, he) })
      .catch((e) => console.warn('[FindTime] share failed', e));
  };

  if (invites) {
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.h2, rtl]}>{T('Sent. Now share each link:', 'נשלח. עכשיו שלחי לכל אחד את הקישור שלו:')}</Text>
        <Text style={[styles.sub, rtl]}>{T('Each person has their own link — they tap yes/no, no app needed.', 'לכל אחד קישור משלו — מסמנים כן/לא, בלי להתקין כלום.')}</Text>
        {invites.map((inv) => (
          <TouchableOpacity key={inv.link} style={[styles.rowCard, he && styles.rowRtl]} onPress={() => shareOne(inv)} accessibilityRole="button">
            <Text style={[styles.body, rtl, { flex: 1 }]}>{inv.name}</Text>
            <Text style={styles.link}>{T('Send ↗', 'לשלוח ↗')}</Text>
          </TouchableOpacity>
        ))}
        {newId ? (
          <TouchableOpacity style={styles.primary} onPress={() => open(newId)} accessibilityRole="button">
            <Text style={styles.primaryText}>{T('See the answers', 'לראות תשובות')}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    );
  }

  if (creating) {
    return (
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[styles.label, rtl]}>{T('What', 'מה')}</Text>
        <TextInput value={title} onChangeText={setTitle} placeholder={T('Party 🎉', 'מסיבה 🎉')}
          style={[styles.input, rtl]} maxLength={120} />
        <View style={[styles.chips, he && styles.rowRtl]}>
          {[60, 120, 180].map((m) => (
            <TouchableOpacity key={m} onPress={() => setMinutes(m)} style={[styles.chip, minutes === m && styles.chipOn]}
              accessibilityRole="radio" accessibilityState={{ selected: minutes === m }}>
              <Text style={styles.chipText}>{m / 60} {T('h', 'ש׳')}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.label, rtl]}>{T('Who (from your contacts)', 'מי (מאנשי הקשר)')}</Text>
        <View style={[styles.chips, he && styles.rowRtl]}>
          {people.map((p) => (
            <TouchableOpacity key={p.phone} style={styles.chip} onPress={() => setPeople((x) => x.filter((y) => y.phone !== p.phone))}
              accessibilityLabel={T(`Remove ${p.name}`, `להסיר את ${p.name}`)}>
              <Text style={styles.chipText}>{p.name} ✕</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.chip, styles.chipAdd]} onPress={addPerson} accessibilityRole="button">
            <Text style={styles.chipText}>{T('+ Add', '+ הוספה')}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.label, rtl]}>{T('When (2–6 options)', 'מתי (2–6 אפשרויות)')}</Text>
        {slots.map((s) => (
          <TouchableOpacity key={`${s.day}${s.start}`} onPress={() => setSlots((x) => x.filter((y) => y !== s))}
            accessibilityLabel={T('Remove this time', 'להסיר את המועד')}>
            <Text style={[styles.body, rtl]}>• {slotLabel(s, he)}  ✕</Text>
          </TouchableOpacity>
        ))}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
          {nextDays(21).map((d) => (
            <TouchableOpacity key={d} onPress={() => setDay(d)} style={[styles.chip, day === d && styles.chipOn]}>
              <Text style={styles.chipText}>{slotLabel({ day: d, start: '' }, he).trim()}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={[styles.chips, he && styles.rowRtl]}>
          <TextInput value={time} onChangeText={setTime} style={[styles.input, { width: 90, textAlign: 'center' }]}
            keyboardType="numbers-and-punctuation" maxLength={5} accessibilityLabel={T('Time', 'שעה')} />
          <TouchableOpacity style={[styles.chip, styles.chipAdd]} onPress={addSlot} accessibilityRole="button">
            <Text style={styles.chipText}>{T('+ Add time', '+ להוסיף מועד')}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.primary} onPress={send} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={BRAND.onGold} /> : <Text style={styles.primaryText}>{T('Send and check', 'לשלוח ולבדוק')}</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setCreating(false)} style={styles.secondary}>
          <Text style={styles.link}>{T('Cancel', 'ביטול')}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <TouchableOpacity style={styles.primary} onPress={() => setCreating(true)} accessibilityRole="button">
        <Text style={styles.primaryText}>{T('+ New', '+ חדש')}</Text>
      </TouchableOpacity>
      {groups === null ? <ActivityIndicator color={BRAND.goldInk} style={{ marginTop: 20 }} /> : null}
      {error ? (
        <TouchableOpacity onPress={load}>
          <Text style={[styles.sub, rtl]}>{T(`Couldn't load your groups · ${error} · tap to retry`, `לא הצלחתי לטעון · ${error} · הקישי לנסות שוב`)}</Text>
        </TouchableOpacity>
      ) : null}
      {groups && !error && groups.length === 0 ? (
        <Text style={[styles.sub, rtl]}>{T('Pick people and a few times — Meira checks who is free.', 'בחרי אנשים וכמה מועדים — מירה בודקת מי פנוי.')}</Text>
      ) : null}
      {(groups || []).map((g) => (
        <TouchableOpacity key={g.id} style={[styles.rowCard, he && styles.rowRtl]} onPress={() => open(g.id)} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={[styles.body, rtl]}>{g.title || T('Get-together', 'מפגש')}</Text>
            <Text style={[styles.sub, rtl]}>
              {g.role === 'owner' ? T('You organize', 'את מארגנת') : g.myStatus === 'invited' ? T('Invited — answer', 'הוזמנת — לענות') : T('Joined', 'הצטרפת')}
              {g.status === 'locked' ? T(' · locked', ' · נקבע') : ''}
            </Text>
          </View>
          <Text style={styles.link}>{he ? '‹' : '›'}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// ── one group ───────────────────────────────────────────────────────────────

function Detail({ id, he, T }: { id: string; he: boolean; T: (en: string, h: string) => string }) {
  const rtl = he ? styles.rtl : null;
  const [v, setV] = useState<GroupView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<string, 'yes' | 'no'>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    groupView(id).then((r) => {
      if (!r.ok) { setErr(r.reason); return; }
      setV(r.data);
      if (r.data.ok && r.data.role === 'member') {
        const pre: Record<string, 'yes' | 'no'> = {};
        r.data.me.cells.forEach((c) => { if (c.source === 'manual' && c.value !== 'unknown') pre[c.slotId] = c.value; });
        setMine(pre);
      }
    });
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (err) {
    return (
      <TouchableOpacity onPress={load} style={styles.scroll}>
        <Text style={[styles.sub, rtl]}>{T(`Couldn't load · ${err} · tap to retry`, `לא הצלחתי לטעון · ${err} · הקישי לנסות שוב`)}</Text>
      </TouchableOpacity>
    );
  }
  if (!v) return <ActivityIndicator color={BRAND.goldInk} style={{ marginTop: 24 }} />;
  if (!v.ok) {
    return <Text style={[styles.sub, rtl, styles.scroll]}>{v.reason === 'not_found' ? T('This group is not available.', 'הקבוצה לא זמינה.') : T(`Couldn't load · ${v.reason}`, `לא הצלחתי לטעון · ${v.reason}`)}</Text>;
  }

  const title = v.group.title || T('Get-together', 'מפגש');
  const locked = v.group.status === 'locked' ? v.slots.find((s) => s.id === v.group.lockedSlot) : undefined;

  if (v.role === 'owner') {
    const lock = (slotId: string) => {
      const s = v.slots.find((x) => x.id === slotId);
      if (!s) return;
      Alert.alert(T('Lock this time?', 'לקבוע את המועד?'), slotLabel(s, he), [
        { text: T('Cancel', 'ביטול'), style: 'cancel' },
        { text: T('Lock', 'לקבוע'), onPress: async () => {
          setBusy(true);
          const r = await groupLock(id, slotId);
          setBusy(false);
          if (!r.ok || !r.data.ok) {
            Alert.alert(T('Not locked', 'לא נקבע'), r.ok ? (r.data.reason || '') : r.reason);
            return;
          }
          const failed = r.data.failed ? T(` · ${r.data.failed} couldn't be added`, ` · ל-${r.data.failed} לא נוסף`) : '';
          Alert.alert('📅', T(`Added to ${r.data.added} calendars${failed}`, `נוסף ליומן של ${r.data.added}${failed}`));
          load();
        } },
      ]);
    };
    const best = bestLabel(v.slots, v.best, he);
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.h2, rtl]}>{title}</Text>
        {locked ? <Text style={[styles.body, rtl]}>{T(`📅 Locked: ${slotLabel(locked, false)}`, `📅 נקבע: ${slotLabel(locked, true)}`)}</Text> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[styles.gridRow, he && styles.rowRtl]}>
              <View style={styles.nameCell} />
              {v.slots.map((s) => (
                <TouchableOpacity key={s.id} disabled={!!locked} onPress={() => lock(s.id)}
                  style={[styles.headCell, s.id === v.best && styles.bestCell]} accessibilityRole="button"
                  accessibilityLabel={T(`${slotLabel(s, false)}: ${s.yes} free. Tap to lock`, `${slotLabel(s, true)}: ${s.yes} פנויים. הקישי לקבוע`)}>
                  <Text style={styles.headText}>{slotLabel(s, he)}{s.id === v.best ? ' ⭐' : ''}</Text>
                  <Text style={styles.noteText}>{s.yes} ✓ · {s.no} ✗ · {s.unknown} ?</Text>
                </TouchableOpacity>
              ))}
            </View>
            {v.rows.map((r) => (
              <View key={r.memberId} style={[styles.gridRow, he && styles.rowRtl]}>
                <Text style={[styles.nameCell, styles.body, rtl]} numberOfLines={1}>{r.role === 'owner' ? T('You', 'את') : r.name}</Text>
                {r.cells.map((c) => (
                  <View key={c.slotId} style={[styles.cell, c.slotId === v.best && styles.bestCell]}
                    accessible accessibilityLabel={`${r.name}: ${cellMark(c)} ${cellNote(c, he)}`}>
                    <Text style={[styles.mark, c.value === 'no' && styles.markNo]}>{cellMark(c)}</Text>
                    {cellNote(c, he) ? <Text style={styles.noteText}>{cellNote(c, he)}</Text> : null}
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
        <Text style={[styles.sub, rtl]}>{T('Meira checks only free/busy — nobody sees what you have.', 'מירה בודקת רק פנוי/תפוס — אף אחד לא רואה מה יש לך.')}</Text>
        {!locked && best ? (
          <TouchableOpacity style={styles.primary} onPress={() => v.best && lock(v.best)} disabled={busy} accessibilityRole="button">
            {busy ? <ActivityIndicator color={BRAND.onGold} /> : <Text style={styles.primaryText}>{best}</Text>}
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={load} style={styles.secondary}><Text style={styles.link}>{T('Refresh', 'רענון')}</Text></TouchableOpacity>
      </ScrollView>
    );
  }

  // member
  const status = v.me.status;
  const respond = async (body: { join?: boolean; answers?: Record<string, 'yes' | 'no'> }) => {
    setBusy(true);
    const r = await groupRespond(id, body);
    setBusy(false);
    if (!r.ok || !r.data.ok) {
      Alert.alert(T('Not sent', 'לא נשלח'), r.ok ? (r.data.reason || '') : r.reason);
      return;
    }
    load();
  };
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={[styles.h2, rtl]}>{T(`${v.organizer || 'Someone'} is finding a time: ${title}`, `${v.organizer || 'מישהו'} מחפש/ת זמן: ${title}`)}</Text>
      {locked ? <Text style={[styles.body, rtl]}>{T(`📅 Locked: ${slotLabel(locked, false)}`, `📅 נקבע: ${slotLabel(locked, true)}`)}</Text> : null}
      {status === 'invited' ? (
        <>
          <Text style={[styles.sub, rtl]}>{T('Join and Meira checks your calendar — only free/busy is sent, never what you have.', 'מצטרפת? מירה תבדוק ביומן שלך — נשלח רק פנוי/תפוס, לא מה יש לך.')}</Text>
          <View style={[styles.chips, he && styles.rowRtl]}>
            <TouchableOpacity style={styles.primarySmall} onPress={() => respond({ join: true })} disabled={busy}><Text style={styles.primaryText}>{T('Join', 'להצטרף')}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.chip} onPress={() => respond({ join: false })} disabled={busy}><Text style={styles.chipText}>{T('Not this time', 'לא הפעם')}</Text></TouchableOpacity>
          </View>
        </>
      ) : null}
      {v.slots.map((s) => {
        const cell = v.me.cells.find((c) => c.slotId === s.id);
        const meira = cell && cell.source === 'auto' ? (cell.value === 'yes' ? T('Meira: free', 'מירה: פנויה') : T('Meira: busy', 'מירה: תפוסה')) : cell ? cellNote(cell, he) : '';
        const pick = mine[s.id];
        return (
          <View key={s.id} style={[styles.rowCard, he && styles.rowRtl]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.body, rtl]}>{slotLabel(s, he)}</Text>
              {meira ? <Text style={[styles.sub, rtl]}>{meira}</Text> : null}
            </View>
            {(['yes', 'no'] as const).map((val) => (
              <TouchableOpacity key={val} onPress={() => setMine((m) => ({ ...m, [s.id]: val }))}
                style={[styles.chip, pick === val && styles.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: pick === val }}>
                <Text style={styles.chipText}>{val === 'yes' ? T('Yes', 'כן') : T('No', 'לא')}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
      {!locked && Object.keys(mine).length ? (
        <TouchableOpacity style={styles.primary} onPress={() => respond({ answers: mine })} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={BRAND.onGold} /> : <Text style={styles.primaryText}>{T('Send', 'לשלוח')}</Text>}
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 },
  back: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
  backText: { fontSize: 28, color: BRAND.warmInk },
  h1: { flex: 1, fontFamily: FONTS.display, fontSize: 22, color: BRAND.warmInk },
  h2: { fontFamily: FONTS.displaySemi, fontSize: 17, color: BRAND.warmInk, marginBottom: 8 },
  scroll: { padding: 16, paddingBottom: 48 },
  label: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, marginTop: 14, marginBottom: 4 },
  input: { borderWidth: 0.5, borderColor: BRAND.line, borderRadius: 12, paddingHorizontal: 12, minHeight: MIN_TOUCH,
    fontFamily: FONTS.body, fontSize: 15, color: BRAND.warmInk, backgroundColor: BRAND.creamCard },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, alignItems: 'center' },
  chip: { paddingHorizontal: 12, minHeight: MIN_TOUCH, justifyContent: 'center', borderRadius: 22,
    backgroundColor: BRAND.creamCard, borderWidth: 0.5, borderColor: BRAND.line, marginEnd: 6 },
  chipOn: { backgroundColor: BRAND.goldSoft, borderColor: BRAND.goldInk },
  chipAdd: { borderStyle: 'dashed' },
  chipText: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk },
  primary: { backgroundColor: BRAND.sunGold, borderRadius: 14, minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: 16 },
  primarySmall: { backgroundColor: BRAND.sunGold, borderRadius: 22, minHeight: MIN_TOUCH, paddingHorizontal: 18, justifyContent: 'center' },
  primaryText: { fontFamily: FONTS.displaySemi, fontSize: 15, color: BRAND.onGold },
  secondary: { minHeight: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
  link: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.goldInk },
  body: { fontFamily: FONTS.body, fontSize: 15, color: BRAND.warmInk },
  sub: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, marginTop: 6 },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: BRAND.creamCard, borderRadius: 14,
    borderWidth: 0.5, borderColor: BRAND.line, padding: 12, marginTop: 10, minHeight: MIN_TOUCH },
  gridRow: { flexDirection: 'row', alignItems: 'stretch' },
  nameCell: { width: 84, paddingVertical: 10, paddingHorizontal: 4 },
  headCell: { width: 104, padding: 6, alignItems: 'center', justifyContent: 'center', minHeight: MIN_TOUCH },
  headText: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.warmInk, textAlign: 'center' },
  cell: { width: 104, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderTopWidth: 0.5, borderColor: BRAND.line },
  bestCell: { backgroundColor: BRAND.goldSoft },
  mark: { fontSize: 18, color: BRAND.warmInk },
  markNo: { color: BRAND.danger },
  noteText: { fontFamily: FONTS.body, fontSize: 10, color: BRAND.inkFaint },
  rowRtl: { flexDirection: 'row-reverse' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
});
