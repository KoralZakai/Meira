/**
 * FocusLectureHost — "📚 You said you were studying!!", over whichever screen she is on.
 *
 * Mounted once at the root (App.tsx), like MeiraAskHost. It is the trigger for the focus feature
 * while the app is open (CalendarAutoSync covers the closed app):
 *
 *   - on mount and on every AppState 'active': reconcile with the native side, collect bypasses,
 *     put the study-task alarms in step (focusTick), then show the lecture that is waiting;
 *   - when FocusBypassService finds something while a screen is open (the 10 s wait just ended);
 *   - after a "set up blocking" nudge: the chooser sheet.
 *
 * The lecture is SHORT — a title, one line, and the ways back: resume with the block re-armed,
 * a 5-minute break then auto-resume, move the rest to a free time, or done for today. A failed
 * answer (permission missing) stays on screen with its reason and the button that fixes it.
 * Everything is 44dp or more and wraps instead of overflowing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import BottomSheet from './ui/BottomSheet';
import FocusSessionSheet from './FocusSessionSheet';
import { BRAND, FONTS, MIN_TOUCH, RADIUS } from '../constants/theme';
import { useAppLanguage } from '../hooks/useAppLanguage';
import {
  answerLecture, dismissLecture, focusTick, nextLecture, onBypassesWaiting, type ShownLecture,
} from '../services/FocusBypassService';
import { getSettings } from '../services/TaskStorage';
import { acceptDisclosure, requestPermission, takeSetupPrompt } from '../services/FocusSessionService';
import FocusDisclosureCard from './FocusDisclosureCard';
import { focusStrings, type FailureText } from '../utils/focusSession';
import type { AppLanguage } from '../types/index';
import type { Offer } from '../utils/focusBypass';

const warnShow = (e: unknown) => console.warn('[FocusLecture] could not show a waiting lecture', e);

export default function FocusLectureHost() {
  const { language, he } = useAppLanguage();
  const S = focusStrings(language);
  const [shown, setShown] = useState<ShownLecture | null>(null);
  const [failure, setFailure] = useState<FailureText | null>(null);
  /** The Play disclosure, before a fix button may open Settings. */
  const [disclose, setDisclose] = useState<'usage' | 'overlay' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  // The hook starts as English until settings load, so the lecture asks settings itself (see check).
  const langRef = useRef<AppLanguage>('en');
  const openRef = useRef(false);
  openRef.current = shown !== null;

  const showWaiting = useCallback(async () => {
    if (openRef.current) return; // one lecture at a time
    const next = await nextLecture(langRef.current);
    if (next) {
      setFailure(null);
      setSaid(null);
      setShown(next);
    }
  }, []);

  const check = useCallback(async (reason: string) => {
    try {
      // The hook's language starts as English until settings load; ask settings directly.
      const settings = await getSettings().catch((e) => { console.warn('[FocusLecture] settings unreadable', e); return null; });
      if (settings?.language) langRef.current = settings.language;
      await focusTick(langRef.current, reason);
      await showWaiting();
      if (await takeSetupPrompt()) setSetupOpen(true);
    } catch (e) {
      console.warn('[FocusLecture] check failed', reason, e);
    }
  }, [showWaiting]);

  useEffect(() => {
    check('mount');
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check('active'); });
    const off = onBypassesWaiting(() => { showWaiting().catch(warnShow); });
    return () => { sub.remove(); off(); };
  }, [check, showWaiting]);

  const close = async () => {
    const s = shown;
    setShown(null);
    setFailure(null);
    setSaid(null);
    if (s) await dismissLecture(s.event).catch((e) => console.warn('[FocusLecture] dismiss failed', e));
    // Another event may be waiting (a different session): show it next.
    setTimeout(() => { showWaiting().catch(warnShow); }, 300);
  };

  const choose = async (offer: Offer) => {
    if (!shown) return;
    setBusy(offer.kind);
    setFailure(null);
    try {
      const r = await answerLecture(shown, offer, langRef.current);
      if (!r.ok) {
        setFailure(r.failure);
        return;
      }
      setSaid(r.line);
      setTimeout(() => {
        setShown(null);
        setSaid(null);
        setTimeout(() => { showWaiting().catch(warnShow); }, 300);
      }, 1400);
    } finally {
      setBusy(null);
    }
  };

  const L = shown?.lecture;
  const align = he ? ({ textAlign: 'right', writingDirection: 'rtl' } as const) : undefined;
  const fix = failure && failure.fix !== 'none' ? failure.fix : null;

  return (
    <>
      <BottomSheet visible={shown !== null} onClose={close}>
        {L ? (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={[styles.title, align]}>{L.title}</Text>
            {said ? (
              <Text style={[styles.body, align]}>{said}</Text>
            ) : (
              <>
                <Text style={[styles.body, align]}>{L.body}</Text>
                {L.hint ? <Text style={[styles.hint, align]}>{L.hint}</Text> : null}

                {disclose ? (
                  <FocusDisclosureCard
                    lang={langRef.current}
                    onAccept={() => {
                      const which = disclose;
                      setDisclose(null);
                      acceptDisclosure()
                        .then(() => requestPermission(which, langRef.current))
                        .then((r) => { if (!r.ok) setFailure(r.failure); })
                        .catch((e) => console.warn('[FocusLecture] disclosure', e));
                    }}
                    onDecline={() => setDisclose(null)}
                  />
                ) : failure ? (
                  <View style={styles.notice}>
                    <Text style={[styles.noticeTitle, align]}>{failure.title}</Text>
                    <Text style={[styles.hint, align]}>{failure.body}</Text>
                    {fix ? (
                      <TouchableOpacity
                        style={styles.primary}
                        onPress={() => {
                          requestPermission(fix, langRef.current).then((r) => {
                            if (r.ok) return;
                            if (r.reason === 'disclosure_needed') setDisclose(fix);
                            else setFailure(r.failure);
                          }).catch((e) => console.warn('[FocusLecture] could not open Settings', e));
                        }}
                        accessibilityRole="button"
                      >
                        <Text style={styles.primaryText}>{S.allow}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : null}

                {L.offers.map((o, i) => {
                  const isDone = o.kind === 'done';
                  return (
                    <TouchableOpacity
                      key={o.kind}
                      style={isDone ? styles.tertiary : i === 0 ? styles.primary : styles.secondary}
                      disabled={busy !== null}
                      onPress={() => choose(o)}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy !== null }}
                    >
                      <Text style={isDone ? styles.tertiaryText : i === 0 ? styles.primaryText : styles.secondaryText}>
                        {o.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </>
            )}
          </ScrollView>
        ) : <View />}
      </BottomSheet>

      <FocusSessionSheet visible={setupOpen} lang={language} onClose={() => setSetupOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8, gap: 10 },
  title: { fontFamily: FONTS.display, fontSize: 22, color: BRAND.warmInk },
  body: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.inkSoft },
  hint: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkFaint },
  notice: { backgroundColor: BRAND.goldSoft, borderRadius: RADIUS.card - 4, padding: 12, gap: 8 },
  noticeTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  primary: {
    minHeight: 52, borderRadius: RADIUS.button, backgroundColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 8,
  },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold, textAlign: 'center' },
  secondary: {
    minHeight: MIN_TOUCH + 4, borderRadius: RADIUS.button, backgroundColor: BRAND.creamCard,
    borderWidth: 1, borderColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 16, paddingVertical: 8,
  },
  secondaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk, textAlign: 'center' },
  tertiary: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  tertiaryText: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkFaint, textAlign: 'center' },
});
