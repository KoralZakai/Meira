/**
 * FocusSessionPanel — "Block during learning": the apps, the permissions, Start, and the running
 * session with its 10-second "End early".
 *
 * One panel, two homes: inline on FocusNowScreen, and inside FocusSessionSheet (Menu › Helpers ›
 * "Learning sessions — blocked apps", and the first-time setup nudge).
 *
 * It never shows a button that does nothing: a start that cannot work shows WHY, in words that
 * name the fix, with the button that does it (silent-state rule 3). Permissions are re-checked
 * every time the app comes back to the front, because the user flips them on a Settings page.
 *
 * Dependencies: FocusSessionService, FocusBypassService, utils/focusSession.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS } from '../constants/theme';
import {
  acceptDisclosure, endEarly, getReadiness, getRunning, installedAppIds, loadChoice, requestPermission,
  saveChoice, startLearning, type Readiness, type RunningView,
} from '../services/FocusSessionService';
import FocusDisclosureCard from './FocusDisclosureCard';
import { focusTick, weeklyCountLine } from '../services/FocusBypassService';
import {
  DEFAULT_SESSION_MINUTES, END_EARLY_SECONDS, FOCUS_APPS, appName, failureText, focusStrings,
  type FailureText,
} from '../utils/focusSession';
import type { AppLanguage, Task } from '../types/index';

const PRESET_MINUTES = [25, 45, 60, 90];

const warnRefresh = (e: unknown) => console.warn('[FocusPanel] refresh failed', e);

interface Props {
  lang: AppLanguage;
  /** The task being studied, when there is one: gives the title, the id and the default length. */
  task?: Task;
  /** Called after a session started or ended, so a parent can refresh its own line. */
  onChanged?: () => void;
}

export default function FocusSessionPanel({ lang, task, onChanged }: Props) {
  const he = lang === 'he';
  const S = focusStrings(lang);
  const rowDir = he ? ('row-reverse' as const) : ('row' as const);
  const align = he ? ({ textAlign: 'right', writingDirection: 'rtl' } as const) : undefined;

  const [readiness, setReadiness] = useState<Readiness>(() => getReadiness());
  const [choice, setChoice] = useState<string[]>([]);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [running, setRunning] = useState<RunningView | null>(null);
  const [runningError, setRunningError] = useState<string | undefined>();
  const [minutes, setMinutes] = useState<number>(
    task && task.durationMinutes > 0 ? task.durationMinutes : DEFAULT_SESSION_MINUTES,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureText | null>(null);
  /** The permission she tapped "Allow" on, while the Play disclosure is on screen. */
  const [disclose, setDisclose] = useState<'usage' | 'overlay' | null>(null);
  const [weekly, setWeekly] = useState('');
  const [countdownEndsAt, setCountdownEndsAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const r = getReadiness();
    const c = await loadChoice();
    const run = getRunning();
    if (!mounted.current) return;
    setReadiness(r);
    setChoice(c);
    setRunning(run.running);
    setRunningError(run.error);
    setInstalled(r.native ? installedAppIds(FOCUS_APPS.map((a) => a.id)).installed : null);
    weeklyCountLine(lang).then((l) => mounted.current && setWeekly(l))
      .catch((e) => console.warn('[FocusPanel] weekly count unreadable', e));
  }, [lang]);

  useEffect(() => {
    mounted.current = true;
    refresh().catch((e) => console.warn('[FocusPanel] refresh failed', e));
    // The permission pages are outside the app: look again whenever she comes back.
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh().catch(warnRefresh); });
    return () => { mounted.current = false; sub.remove(); };
  }, [refresh]);

  // A clock only while something is counting: the session's minutes, or the 10-second wait.
  const ticking = Boolean(running) || countdownEndsAt > 0;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (running && Date.now() >= running.session.endsAtMs) refresh().catch(warnRefresh);
    }, 500);
    return () => clearInterval(id);
  }, [ticking, running, refresh]);

  const toggle = async (id: string) => {
    const next = choice.includes(id) ? choice.filter((x) => x !== id) : [...choice, id];
    setChoice(next);
    setFailure(null);
    await saveChoice(next).catch((e) => console.warn('[FocusPanel] could not save the choice', e));
  };

  const start = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const r = await startLearning({
        minutes, title: task?.text ?? '', taskId: task?.id ?? null, lang, ids: choice,
      });
      if (!r.ok) {
        setFailure(r.failure);
        setReadiness(getReadiness());
        return;
      }
      await refresh();
      onChanged?.();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const allow = async (which: 'usage' | 'overlay') => {
    const r = await requestPermission(which, lang);
    if (r.ok) return;
    if (r.reason === 'disclosure_needed') setDisclose(which);
    else setFailure(r.failure);
  };

  // The disclosure takes the whole panel, so it cannot be scrolled past, and Settings opens only
  // from its "Got it".
  if (disclose) {
    return (
      <FocusDisclosureCard
        lang={lang}
        onAccept={() => {
          const which = disclose;
          setDisclose(null);
          acceptDisclosure().then(() => allow(which)).catch((e) => console.warn('[FocusPanel] disclosure', e));
        }}
        onDecline={() => setDisclose(null)}
      />
    );
  }

  const secondsLeft = countdownEndsAt === 0 ? -1 : Math.max(0, Math.ceil((countdownEndsAt - now) / 1000));

  const stop = () => {
    const r = endEarly();
    setCountdownEndsAt(0);
    if (!r.ok) {
      setFailure(failureText(r.reason, lang));
      return;
    }
    onChanged?.();
    // The native side writes "ended early" a moment after; collect it so Meira can answer.
    setTimeout(() => {
      focusTick(lang, 'ended-early').catch((e) => console.warn('[FocusPanel] could not collect the early end', e));
      refresh().catch(warnRefresh);
    }, 800);
  };

  // ── Running ──────────────────────────────────────────────────────────────
  if (running) {
    const minutesLeft = Math.max(0, Math.ceil((running.session.endsAtMs - now) / 60_000));
    const warn = running.warn === 'usage' ? S.warnUsage
      : running.warn === 'overlay' ? S.warnOverlay
      : running.warn === 'block_failed' ? S.warnFailed : '';
    return (
      <View style={styles.card}>
        <Text style={[styles.runTitle, align]}>{S.running(minutesLeft)}</Text>
        {running.session.title ? <Text style={[styles.sub, align]} numberOfLines={2}>{running.session.title}</Text> : null}
        {running.restarted ? <Text style={[styles.warn, align]}>{S.notRunning}</Text> : null}
        {warn ? <Text style={[styles.warn, align]}>{warn}</Text> : null}
        {warn && running.warn !== 'block_failed' ? (
          <TouchableOpacity style={styles.primary} onPress={() => allow(running.warn === 'overlay' ? 'overlay' : 'usage')} accessibilityRole="button">
            <Text style={styles.primaryText}>{S.allow}</Text>
          </TouchableOpacity>
        ) : null}
        {secondsLeft === -1 ? (
          <TouchableOpacity style={styles.secondary} onPress={() => setCountdownEndsAt(Date.now() + END_EARLY_SECONDS * 1000)} accessibilityRole="button">
            <Text style={styles.secondaryText}>{S.endEarly}</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.secondary, secondsLeft > 0 && styles.disabled]}
              disabled={secondsLeft > 0}
              onPress={stop}
              accessibilityRole="button"
              accessibilityState={{ disabled: secondsLeft > 0 }}
            >
              <Text style={styles.secondaryText}>{secondsLeft > 0 ? S.endCountdown(secondsLeft) : S.endNow}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primary} onPress={() => setCountdownEndsAt(0)} accessibilityRole="button">
              <Text style={styles.primaryText}>{S.keepGoing}</Text>
            </TouchableOpacity>
          </>
        )}
        {runningError ? <Text style={[styles.warn, align]}>{runningError}</Text> : null}
        {weekly ? <Text style={[styles.faint, align]}>{weekly}</Text> : null}
      </View>
    );
  }

  // ── Not running: choose, allow, start ───────────────────────────────────
  const noneChosen = choice.length === 0;
  const durations = PRESET_MINUTES.includes(minutes) ? PRESET_MINUTES : [...PRESET_MINUTES, minutes].sort((a, b) => a - b);
  const needsSetup = readiness.native && !readiness.ready;
  const unavailable = failureText('native_unavailable', lang);

  return (
    <View style={styles.card}>
      <Text style={[styles.heading, align]}>{S.sectionTitle}</Text>
      <Text style={[styles.sub, align]}>{S.blockedHint}</Text>

      <View style={[styles.chips, { flexDirection: rowDir }]}>
        {FOCUS_APPS.map((a) => {
          const on = choice.includes(a.id);
          const missing = installed !== null && !installed.includes(a.id);
          return (
            <TouchableOpacity
              key={a.id}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => toggle(a.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={appName(a, lang)}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                {on ? '✓ ' : ''}{appName(a, lang)}
              </Text>
              {missing ? <Text style={styles.chipNote}>{S.notInstalled}</Text> : null}
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[styles.faint, align]}>{S.callsNote}</Text>

      {!readiness.native ? (
        <View style={styles.notice}>
          <Text style={[styles.noticeTitle, align]}>{unavailable.title}</Text>
          <Text style={[styles.sub, align]}>{unavailable.body}</Text>
        </View>
      ) : null}

      {needsSetup ? (
        <View style={styles.notice}>
          <Text style={[styles.noticeTitle, align]}>{S.permHeader}</Text>
          <PermRow label={S.stepUsage} on={readiness.usageAccess} S={S} rowDir={rowDir} align={align} onAllow={() => allow('usage')} />
          <PermRow label={S.stepOverlay} on={readiness.overlay} S={S} rowDir={rowDir} align={align} onAllow={() => allow('overlay')} />
          <Text style={[styles.faint, align]}>{S.permFooter}</Text>
        </View>
      ) : null}

      {readiness.native && !readiness.notifications ? <Text style={[styles.warn, align]}>{S.notificationsOff}</Text> : null}

      <View style={[styles.chips, { flexDirection: rowDir }]}>
        {durations.map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.chip, m === minutes && styles.chipOn]}
            onPress={() => setMinutes(m)}
            accessibilityRole="radio"
            accessibilityState={{ selected: m === minutes }}
          >
            <Text style={[styles.chipText, m === minutes && styles.chipTextOn]}>{he ? `${m} דק׳` : `${m} min`}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {failure ? (
        <View style={styles.notice}>
          <Text style={[styles.noticeTitle, align]}>{failure.title}</Text>
          <Text style={[styles.sub, align]}>{failure.body}</Text>
          {failure.fix !== 'none' ? (
            <TouchableOpacity style={styles.primary} onPress={() => allow(failure.fix === 'overlay' ? 'overlay' : 'usage')} accessibilityRole="button">
              <Text style={styles.primaryText}>{S.allow}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.primary, (noneChosen || busy) && styles.disabled]}
        onPress={start}
        disabled={noneChosen || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: noneChosen || busy }}
      >
        {busy ? <ActivityIndicator color={BRAND.onGold} /> : <Text style={styles.primaryText}>{noneChosen ? S.pickOne : S.start(minutes)}</Text>}
      </TouchableOpacity>
      <Text style={[styles.faint, align]}>{S.autoOn}</Text>
      {weekly ? <Text style={[styles.faint, align]}>{weekly}</Text> : null}
    </View>
  );
}

function PermRow({ label, on, S, rowDir, align, onAllow }: {
  label: string; on: boolean; S: ReturnType<typeof focusStrings>;
  rowDir: 'row' | 'row-reverse'; align: object | undefined; onAllow: () => void;
}) {
  return (
    <View style={[styles.permRow, { flexDirection: rowDir }]}>
      <Text style={[styles.permLabel, align]}>{label}</Text>
      {on ? (
        <Text style={styles.permOk}>{S.allowed}</Text>
      ) : (
        <TouchableOpacity style={styles.allowBtn} onPress={onAllow} accessibilityRole="button" accessibilityLabel={label}>
          <Text style={styles.allowText}>{S.allow}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.card, padding: 16, gap: 10,
  },
  heading: { fontFamily: FONTS.display, fontSize: 18, color: BRAND.warmInk },
  runTitle: { fontFamily: FONTS.display, fontSize: 20, color: BRAND.warmInk },
  sub: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.inkSoft },
  faint: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint },
  warn: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.lateInk },
  chips: { flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: MIN_TOUCH, paddingHorizontal: 14, borderRadius: RADIUS.chip + 8,
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
    alignItems: 'center', justifyContent: 'center',
  },
  chipOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  chipTextOn: { color: BRAND.onGold },
  chipNote: { fontFamily: FONTS.body, fontSize: 10, color: BRAND.inkFaint },
  notice: {
    backgroundColor: BRAND.goldSoft, borderRadius: RADIUS.card - 4, padding: 12, gap: 8,
  },
  noticeTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  permRow: { alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: MIN_TOUCH },
  permLabel: { flex: 1, flexShrink: 1, fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.warmInk },
  permOk: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.success },
  allowBtn: {
    minHeight: MIN_TOUCH, paddingHorizontal: 16, borderRadius: RADIUS.button,
    backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center',
  },
  allowText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  primary: {
    minHeight: 52, borderRadius: RADIUS.button, backgroundColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16,
  },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.onGold, textAlign: 'center' },
  secondary: {
    minHeight: MIN_TOUCH + 4, borderRadius: RADIUS.button, backgroundColor: BRAND.creamCard,
    borderWidth: 1, borderColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16,
  },
  secondaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk, textAlign: 'center' },
  disabled: { opacity: 0.55 },
});
