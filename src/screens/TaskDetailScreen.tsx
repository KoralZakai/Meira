/**
 * TaskDetailScreen — one task, opened (the home's "הבא בלו״ז", any alert about a task).
 *
 * v3 (Koral, 28.10: "the content is great — when to leave, walk, train,
 * walk, arrive, the map, Google Maps / Waze / Moovit — update the design"):
 * the sky behind it, the task's hero (when, day, place, the yellow "צאי"),
 * the way there as the same short timeline the day card draws (TripTimeline),
 * the map, then one row to navigate in the app she likes. Edits happen in the
 * task card on Today (✏️), where every field and its re-planning live.
 */
import React, { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useLumiContext } from '../hooks/useLumiContext';
import { SubtaskList } from '../components/SubtaskList';
import RouteMap from '../components/RouteMap';
import { BRAND, FONTS, MIN_TOUCH, SHADOWS, surf, nline } from '../constants/theme';
import SkyBackdrop, { useSky } from '../components/ui/SkyBackdrop';
import LineIcon from '../components/ui/LineIcon';
import TaskSheetHero from '../components/today/TaskSheetHero';
import TripTimeline from '../components/today/TripTimeline';
import { N } from '../constants/nightTone';
import { useAppLanguage } from '../hooks/useAppLanguage';
import { getAllTasks } from '../services/TaskStorage';
import { getTodayString } from '../utils/timeUtils';
import { moovitLinks } from '../utils/moovitLink';
import { contactPhoneOf } from '../utils/lateNotice';
import { isRemoteTask } from '../utils/meetingLink';
import type { Task } from '../types/index';
import MeetingBriefCard from '../components/MeetingBriefCard';
import InterviewPrepHeader from '../components/today/InterviewPrepHeader';
import { briefForTask, interviewBrief } from '../services/MeetingBriefService';
import type { MeetingBriefResult } from '../services/LumiServer';
import { isInterview } from '../utils/interviewPrep';
import { FROM_CALENDAR_RE, prepSlotFor } from '../utils/interviewBrief';

type Props = NativeStackScreenProps<RootStackParamList, 'TaskDetail'>;

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function TaskDetailScreen({ route, navigation }: Props) {
  const { taskId } = route.params;
  const { tasksState } = useLumiContext();
  const { he } = useAppLanguage();
  const insets = useSafeAreaInsets();
  const sky = useSky();
  const night = sky.dark;
  const [task, setTask] = useState<Task | null>(null);
  const [missing, setMissing] = useState(false);
  // The research for this meeting (server/meeting_brief.py via Tavily): the
  // company, the role, who she is meeting, questions candidates were asked,
  // what to prepare — every line with its source (28.10: "where is it? show it
  // on the task"). Trigger: opening the task page; cached on both sides.
  const [brief, setBrief] = useState<MeetingBriefResult | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  // A forced refresh is a full paid rebuild — one a minute at most.
  const lastForce = React.useRef(0);
  const interview = task ? isInterview(task) : false;
  const loadBrief = React.useCallback(async (t: Task, force = false) => {
    setBriefBusy(true);
    try {
      const b = isInterview(t) ? await interviewBrief(t, force) : await briefForTask(t, force);
      setBrief(b);
    } catch (e) {
      console.warn('[TaskDetail] brief failed', t.id, e);
      setBrief({ ok: false, reason: 'unreachable' } as MeetingBriefResult);
    } finally {
      setBriefBusy(false);
    }
  }, []);
  const briefFor = task?.id;
  useEffect(() => {
    if (!task) return;
    // Interviews always; other meetings only when a calendar invite carries the
    // company / people (a self-typed "call Mom" must not buy web searches).
    const meeting = isInterview(task)
      || ((Boolean(task.calendarEventId) || FROM_CALENDAR_RE.test(task.id)) && ['meeting', 'zoom', 'conference'].includes(String(task.category)));
    if (meeting) void loadBrief(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefFor]);

  useEffect(() => {
    const found = tasksState.tasks.find((t: any) => t.id === taskId) as Task | undefined;
    if (found) { setTask(found); return; }
    // Not in the hook's list (another day, or not loaded yet): read the store — and say so if it is gone.
    getAllTasks().then((all) => {
      const t = all.find((x) => x.id === taskId);
      if (t) setTask(t); else setMissing(true);
    }).catch((e) => { console.warn('[TaskDetail] task unreadable', e); setMissing(true); });
  }, [taskId, tasksState.tasks]);

  if (!task) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
        <SkyBackdrop sky={sky} />
        <Text style={[styles.loading, { color: sky.ink }]}>
          {missing ? (he ? 'המשימה הזו כבר לא קיימת' : 'This task is gone') : (he ? 'טוענת…' : 'Loading…')}
        </Text>
      </View>
    );
  }

  const loc: any = task.location && typeof task.location === 'object' ? task.location : null;
  const label = loc?.displayName || loc?.address || '';
  const hasPoint = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && (loc.lat || loc.lng);
  const remote = isRemoteTask(task as any);
  const plan = loc?.transitPlan;
  const transit = Boolean(plan?.legs?.some((l: any) => l.type !== 'walk')) || loc?.transportType === 'bus' || loc?.transportType === 'train';
  const moovit = transit && !remote ? moovitLinks({ lat: loc?.lat, lng: loc?.lng, name: label }) : null;
  const phone = contactPhoneOf(task);
  const isToday = task.date === getTodayString();
  const dir = he ? 'row-reverse' : 'row';
  const rtl = he && styles.rtl;

  const open = (url: string, fallback?: string) =>
    Linking.openURL(url).catch(() => (fallback ? Linking.openURL(fallback) : Promise.reject()))
      .catch((e) => Alert.alert(he ? 'לא נפתח' : "Couldn't open", String(e)));
  const navs: Array<{ key: string; label: string; go: () => void }> = [];
  if (hasPoint || label) {
    const q = hasPoint ? `${loc.lat},${loc.lng}` : encodeURIComponent(label);
    navs.push({ key: 'google', label: 'Google Maps', go: () => open(`google.navigation:q=${q}`, `https://www.google.com/maps/dir/?api=1&destination=${q}`) });
    navs.push({ key: 'waze', label: 'Waze', go: () => open(hasPoint ? `waze://?ll=${loc.lat},${loc.lng}&navigate=yes` : `waze://?q=${q}&navigate=yes`,
      hasPoint ? `https://waze.com/ul?ll=${loc.lat},${loc.lng}&navigate=yes` : `https://waze.com/ul?q=${q}&navigate=yes`) });
  }
  if (moovit) navs.push({ key: 'moovit', label: 'Moovit', go: () => open(moovit.app, moovit.web) });

  return (
    <View style={styles.root}>
      <SkyBackdrop sky={sky} />
      <View style={[styles.top, { paddingTop: insets.top + 8, flexDirection: dir }]}>
        <Pressable style={[styles.round, night && N.chip]} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel={he ? 'סגירה' : 'Close'}>
          <Text style={[styles.roundText, night && N.ink]}>×</Text>
        </Pressable>
        <Text style={[styles.title, { color: sky.ink }, rtl]} numberOfLines={2}>{task.text}</Text>
        <Pressable style={[styles.round, night && N.chip]} accessibilityRole="button" accessibilityLabel={he ? 'עריכה' : 'Edit'}
          onPress={() => (navigation as any).navigate('MainTabs', { screen: 'Today', params: { editTask: task.id, nonce: Date.now() } })}>
          <Text style={[styles.roundText, night && N.ink]}>✏️</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]} showsVerticalScrollIndicator={false}>
        <TaskSheetHero task={task} he={he} />

        {loc?.leaveHomeBy || plan?.leaveHomeAt ? (
          <View style={[styles.card, night && N.card]}>
            <Text style={[styles.cap, night && N.goldInk, rtl]}>{he ? 'הדרך לשם' : 'Getting there'}</Text>
            <TripTimeline task={task} he={he} now={isToday ? nowHHMM() : undefined} readyAt={loc?.wakeUpBy} night={night} />
          </View>
        ) : null}

        {plan && hasPoint ? (
          <View style={[styles.mapCard, night && N.surface]}>
            <RouteMap plan={plan} destLat={loc.lat} destLng={loc.lng} destLabel={label} hideNavigate />
          </View>
        ) : null}

        {navs.length ? (
          <View style={[styles.navRow, { flexDirection: dir }]}>
            {navs.map((n, i) => (
              <Pressable key={n.key} style={[styles.nav, night && N.chip, i === 0 && styles.navMain]} onPress={n.go} accessibilityRole="button">
                {i === 0 ? <LineIcon name="map" size={16} color={BRAND.onGold} /> : null}
                <Text style={[styles.navText, night && N.ink, i === 0 && styles.navMainText]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{n.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {interview || brief ? (
          <View style={styles.card}>
            {interview ? (
              <InterviewPrepHeader task={task} he={he}
                prep={prepSlotFor(task, tasksState.tasks as Task[], getTodayString(), nowHHMM())} />
            ) : null}
            {brief ? (
              <MeetingBriefCard brief={brief} language={he ? 'he' : 'en'} refreshing={briefBusy}
                onRefresh={() => {
                  if (Date.now() - lastForce.current < 60 * 1000) return;
                  lastForce.current = Date.now();
                  void loadBrief(task, true);
                }} />
            ) : (
              <Text style={[styles.body, rtl]}>{he ? 'אוספת מידע על החברה, התפקיד והמראיין…' : 'Researching the company, the role and who you are meeting…'}</Text>
            )}
          </View>
        ) : null}

        {task.contact?.name || phone ? (
          <View style={[styles.card, night && N.card, styles.rowCard, { flexDirection: dir }]}>
            <Text style={styles.rowIcon}>👤</Text>
            <Text style={[styles.rowText, night && N.ink, rtl]} numberOfLines={1}>{task.contact?.name || phone}</Text>
            {phone ? (
              <Pressable style={[styles.call, night && N.goldSoft]} onPress={() => open(`tel:${phone.replace(/[^\d+]/g, '')}`)} accessibilityRole="button"
                accessibilityLabel={he ? 'להתקשר' : 'Call'}>
                <Text style={styles.callText}>📞</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {(task as any).how ? (
          <View style={[styles.card, night && N.card]}>
            <Text style={[styles.cap, night && N.goldInk, rtl]}>{he ? 'להכין' : 'To prepare'}</Text>
            <Text style={[styles.body, night && N.ink, rtl]}>{(task as any).how}</Text>
          </View>
        ) : null}

        {task.subtasks?.length ? (
          <View style={[styles.card, night && N.card]}>
            <SubtaskList subtasks={task.subtasks} onToggle={() => setTask(task)} />
          </View>
        ) : null}

        {task.deadline ? (
          <View style={[styles.card, night && N.card, styles.rowCard, { flexDirection: dir }]}>
            <Text style={styles.rowIcon}>📅</Text>
            <Text style={[styles.rowText, night && N.ink, rtl]} numberOfLines={2}>{`${he ? 'עד' : 'Due'} ${task.deadline}${task.deadlineTime ? ` ${task.deadlineTime}` : ''}`}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  loading: { fontFamily: FONTS.bodyHeavy, fontSize: 16, textAlign: 'center', marginTop: 40 },
  top: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 10 },
  title: { flex: 1, fontFamily: FONTS.display, fontSize: 20 },
  round: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, backgroundColor: surf('rgba(255,255,255,0.8)'), alignItems: 'center', justifyContent: 'center' },
  roundText: { fontSize: 20, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  scroll: { paddingHorizontal: 16, gap: 12 },
  card: {
    padding: 14, borderRadius: 22, backgroundColor: surf('rgba(255,255,255,0.92)'),
    borderWidth: 1, borderColor: nline('rgba(255,255,255,0.9)'), ...SHADOWS.card,
  },
  cap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, marginBottom: 8 },
  body: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.warmInk, lineHeight: 20 },
  mapCard: { borderRadius: 22, overflow: 'hidden', backgroundColor: surf('rgba(255,255,255,0.92)') },
  navRow: { gap: 8 },
  nav: {
    flex: 1, minWidth: 0, minHeight: MIN_TOUCH + 4, paddingHorizontal: 10, borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
    backgroundColor: surf('rgba(255,255,255,0.92)'), borderWidth: 1, borderColor: BRAND.line,
  },
  navMain: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  navText: { flexShrink: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  navMainText: { color: BRAND.onGold },
  rowCard: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  rowIcon: { fontSize: 20 },
  rowText: { flex: 1, minWidth: 0, fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  call: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center' },
  callText: { fontSize: 18 },
});
