/**
 * QuickMBTIScreen — 4-question quick personality assessment; records the
 * quick type + resumes partial progress.
 * Dependencies: PersonalityLearningService, QuizProgressService.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { MBTI_QUESTIONS, QUIZ_SECTION_SIZE, MBTI_PROFILES, MBTI_COMMUNICATION } from '../constants/mbti';
import { MBTIType, QuizProgress } from '../types';
import { PersonalityLearningService } from '../services/PersonalityLearningService';
import { loadProgress, saveProgress, clearProgress } from '../services/QuizProgressService';

type ScoreKey = 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P';

/** Total questions and how they split into sections of 5 (6 sections for 30 Q). */
const TOTAL = MBTI_QUESTIONS.length;
const TOTAL_SECTIONS = Math.ceil(TOTAL / QUIZ_SECTION_SIZE);

interface Props {
  /** Called once the user confirms their result. */
  onComplete: (type: MBTIType) => void;
  /**
   * Optional: close the quiz early, keeping saved progress (the "Save & finish
   * later" action). Additive — existing callers that don't pass it are unaffected.
   */
  onSaveLater?: () => void;
  /** Stable id for persistence (Supabase user id, or 'local' when signed out). */
  userId?: string;
  language?: 'en' | 'he';
}

/**
 * Derive the 4-letter MBTI type from the answer map by tallying the chosen
 * letter for each dichotomy (ties resolve to the first letter, matching the
 * original 4-question logic). Pure — used both to finish and to preview.
 */
function computeTypeFromAnswers(answers: Record<string, string>): MBTIType {
  const s: Record<ScoreKey, number> = { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 };
  for (const letter of Object.values(answers)) {
    if (letter in s) s[letter as ScoreKey] += 1;
  }
  return ((s.E >= s.I ? 'E' : 'I') +
    (s.S >= s.N ? 'S' : 'N') +
    (s.T >= s.F ? 'T' : 'F') +
    (s.J >= s.P ? 'J' : 'P')) as MBTIType;
}

const T = {
  en: {
    title: 'Personality Check 🧭',
    subtitle: '30 questions — 5 at a time. Save & continue anytime.',
    result: "You're",
    resultSub: "I'll tailor how I talk, remind, and plan around this. You can refine it anytime.",
    go: "Let's go",
    saving: 'Saving…',
    section: (n: number) => `Section ${n} of ${TOTAL_SECTIONS}`,
    checkpointTitle: 'Nice — section done! 🎉',
    checkpointSub: (a: number) => `${a} of ${TOTAL} answered. Keep going or come back later.`,
    continue: 'Continue',
    saveLater: 'Save & finish later',
    retake: 'Retake the quiz',
  },
  he: {
    title: 'בדיקת אישיות 🧭',
    subtitle: '30 שאלות — 5 בכל פעם. אפשר לשמור ולהמשיך מתי שרוצים.',
    result: 'אתה',
    resultSub: 'אתאים את הדיבור, התזכורות והתכנון לפי זה. אפשר לעדכן בכל רגע.',
    go: 'יאללה, מתחילים',
    saving: 'שומר…',
    section: (n: number) => `חלק ${n} מתוך ${TOTAL_SECTIONS}`,
    checkpointTitle: 'כל הכבוד — סיימת חלק! 🎉',
    checkpointSub: (a: number) => `${a} מתוך ${TOTAL} נענו. אפשר להמשיך או לחזור מאוחר יותר.`,
    continue: 'להמשיך',
    saveLater: 'לשמור ולסיים אחר כך',
    retake: 'למלא מחדש',
  },
};

/**
 * The MBTI quiz screen: 30 questions delivered 5-per-section with save/resume.
 * Progress (answer history + section cursor) is persisted via QuizProgressService
 * (local + cloud), so the user can stop after any section and continue later,
 * even on another device. On completion the derived type is saved so Lumi can
 * talk/act to the user's motives.
 */
export default function QuickMBTIScreen({ onComplete, onSaveLater, userId = 'local', language = 'en' }: Props) {
  const isHe = language === 'he';
  const t = isHe ? T.he : T.en;

  // 'loading' → restoring saved progress; then question ↔ checkpoint ↔ result.
  const [phase, setPhase] = useState<'loading' | 'question' | 'checkpoint' | 'result'>('loading');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentQ, setCurrentQ] = useState(0);          // index of the question to show next
  const [result, setResult] = useState<MBTIType | null>(null);
  const [saving, setSaving] = useState(false);

  // On mount: restore any saved progress. If already completed, jump to result.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const p = await loadProgress(userId);
      if (!mounted) return;
      if (p?.completed && p.finalType) {
        setResult(p.finalType);
        setPhase('result');
        return;
      }
      if (p?.answers) {
        setAnswers(p.answers);
        setCurrentQ(Object.keys(p.answers).length); // resume at first unanswered
      }
      setPhase('question');
    })();
    return () => {
      mounted = false;
    };
  }, [userId]);

  /** Persist the current answer map (+ optional completion) — best-effort. */
  const persist = (nextAnswers: Record<string, string>, completed = false, finalType?: MBTIType) => {
    const progress: QuizProgress = {
      answers: nextAnswers,
      sectionIndex: Math.floor(Object.keys(nextAnswers).length / QUIZ_SECTION_SIZE),
      completed,
      finalType,
      updatedAt: Date.now(),
    };
    void saveProgress(userId, progress);
  };

  const handleAnswer = async (letter: string) => {
    const q = MBTI_QUESTIONS[currentQ];
    const nextAnswers = { ...answers, [q.id]: letter };
    setAnswers(nextAnswers);
    const answered = Object.keys(nextAnswers).length; // === currentQ + 1 (answered in order)

    // Finished the whole quiz → compute, persist result, save learned blend.
    if (answered >= TOTAL) {
      const type = computeTypeFromAnswers(nextAnswers);
      setSaving(true);
      persist(nextAnswers, true, type);
      try {
        await PersonalityLearningService.saveQuickAssessment(userId, type);
      } catch (e) {
        console.warn('[QuizMBTI] saveQuickAssessment failed', e);
      }
      setSaving(false);
      setResult(type);
      setPhase('result');
      return;
    }

    persist(nextAnswers);
    setCurrentQ(answered);
    // End of a 5-question section → show the checkpoint (save / continue).
    if (answered % QUIZ_SECTION_SIZE === 0) {
      setPhase('checkpoint');
    }
  };

  /** Start over: wipe local progress and the working state. */
  const retake = () => {
    void clearProgress();
    setAnswers({});
    setCurrentQ(0);
    setResult(null);
    persist({});
    setPhase('question');
  };

  // ─── Loading ───
  if (phase === 'loading') {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: BRAND.cream }]}>
        <ActivityIndicator color={BRAND.sunGold} size="large" />
      </View>
    );
  }

  // ─── Result card ───
  if (phase === 'result' && result) {
    const profile = MBTI_PROFILES[result];
    const comm = MBTI_COMMUNICATION[result];
    return (
      <ScrollView
        style={[styles.container, { backgroundColor: BRAND.cream }]}
        contentContainerStyle={styles.resultContent}
      >
        <Text style={styles.resultEmoji}>{profile.emoji}</Text>
        <Text style={[styles.resultType, isHe && styles.rtl]}>{t.result} {result}</Text>
        <Text style={[styles.resultName, isHe && styles.rtl]}>{profile.name}</Text>
        <View style={styles.toneCard}>
          <Text style={[styles.toneText, isHe && styles.rtl]}>“{comm.motivationalTone}”</Text>
        </View>
        <Text style={[styles.resultSub, isHe && styles.rtl]}>{t.resultSub}</Text>
        <Pressable style={styles.goBtn} onPress={() => onComplete(result)}>
          <Text style={styles.goText}>{t.go}</Text>
        </Pressable>
        <Pressable style={styles.retakeBtn} onPress={retake}>
          <Text style={styles.retakeText}>{t.retake}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  // ─── Section checkpoint (save / continue) ───
  if (phase === 'checkpoint') {
    const answered = Object.keys(answers).length;
    return (
      <View style={[styles.container, styles.center, { backgroundColor: BRAND.cream }]}>
        <Text style={styles.checkpointEmoji}>🎉</Text>
        <Text style={[styles.checkpointTitle, isHe && styles.rtl]}>{t.checkpointTitle}</Text>
        <Text style={[styles.checkpointSub, isHe && styles.rtl]}>{t.checkpointSub(answered)}</Text>
        <View style={styles.progressBarWide}>
          <View style={[styles.progressFill, { width: `${(answered / TOTAL) * 100}%` }]} />
        </View>
        <Pressable style={styles.goBtn} onPress={() => setPhase('question')}>
          <Text style={styles.goText}>{t.continue}</Text>
        </Pressable>
        <Pressable style={styles.retakeBtn} onPress={() => onSaveLater?.()}>
          <Text style={styles.retakeText}>{t.saveLater}</Text>
        </Pressable>
      </View>
    );
  }

  // ─── Question card ───
  const q = MBTI_QUESTIONS[currentQ];
  const sectionNum = Math.floor(currentQ / QUIZ_SECTION_SIZE) + 1;
  const progress = (currentQ / TOTAL) * 100;

  return (
    <ScrollView style={[styles.container, { backgroundColor: BRAND.cream }]}>
      <Text style={[styles.title, isHe && styles.rtl]}>{t.title}</Text>
      <Text style={[styles.subtitle, isHe && styles.rtl]}>{t.subtitle}</Text>

      <Text style={[styles.sectionLabel, isHe && styles.rtl]}>
        {t.section(sectionNum)} · {currentQ + 1}/{TOTAL}
      </Text>
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progress}%` }]} />
      </View>

      <Text style={[styles.question, isHe && styles.rtl]}>{isHe ? q.textHe : q.text}</Text>

      <View style={styles.options}>
        {q.options.map((opt, i) => (
          <Pressable
            key={i}
            style={({ pressed }) => [styles.optionBtn, pressed && styles.optionPressed]}
            disabled={saving}
            onPress={() => handleAnswer(opt.score)}
          >
            <Text style={[styles.optionText, isHe && styles.rtl]}>{isHe ? opt.textHe : opt.text}</Text>
          </Pressable>
        ))}
      </View>

      {saving && (
        <View style={styles.savingRow}>
          <ActivityIndicator color={BRAND.sunGold} />
          <Text style={styles.progress}>  {t.saving}</Text>
        </View>
      )}

      {/* Let the user bail out mid-section too — progress is already saved. */}
      {onSaveLater && !saving && (
        <Pressable style={styles.retakeBtn} onPress={() => onSaveLater()}>
          <Text style={styles.retakeText}>{t.saveLater}</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  center: { alignItems: 'center', justifyContent: 'center' },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
  title: { fontSize: 28, fontFamily: FONTS.bodyBold, marginTop: 20, marginBottom: 8, color: BRAND.warmInk },
  subtitle: { fontSize: 14, color: BRAND.inkSoft, marginBottom: 16 },
  sectionLabel: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.sunGold, marginBottom: 8 },
  progressBar: {
    height: 6,
    backgroundColor: BRAND.line,
    borderRadius: 3,
    marginBottom: 30,
    overflow: 'hidden',
  },
  progressBarWide: {
    height: 8,
    width: '80%',
    backgroundColor: BRAND.line,
    borderRadius: 4,
    overflow: 'hidden',
    marginVertical: 24,
  },
  progressFill: { height: '100%', backgroundColor: BRAND.sunGold, borderRadius: 3 },
  question: { fontSize: 20, fontFamily: FONTS.bodySemi, marginBottom: 24, color: BRAND.warmInk },
  options: { gap: 12, marginBottom: 24 },
  optionBtn: {
    padding: 18,
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    borderWidth: 2,
    borderColor: BRAND.line,
  },
  optionPressed: { borderColor: BRAND.sunGold, backgroundColor: BRAND.honey },
  optionText: { color: BRAND.warmInk, fontSize: 16, lineHeight: 22 },
  progress: { textAlign: 'center', color: BRAND.inkSoft, fontSize: 13 },
  savingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },

  // Checkpoint
  checkpointEmoji: { fontSize: 56, marginBottom: 12 },
  checkpointTitle: { fontSize: 24, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, textAlign: 'center' },
  checkpointSub: { fontSize: 15, color: BRAND.inkSoft, textAlign: 'center', marginTop: 8, paddingHorizontal: 20 },

  // Result
  resultContent: { alignItems: 'center', paddingTop: 60, paddingBottom: 40 },
  resultEmoji: { fontSize: 72, marginBottom: 12 },
  resultType: { fontSize: 40, fontFamily: FONTS.bodyBold, color: BRAND.sunGold, letterSpacing: 2 },
  resultName: { fontSize: 20, color: BRAND.warmInk, marginTop: 4, marginBottom: 24 },
  toneCard: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    padding: 18,
    borderWidth: 1,
    borderColor: BRAND.line,
    marginBottom: 20,
  },
  toneText: { fontSize: 15, color: BRAND.warmInk, fontStyle: 'italic', textAlign: 'center' },
  resultSub: {
    fontSize: 14,
    color: BRAND.inkSoft,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 20,
    paddingHorizontal: 10,
  },
  goBtn: {
    backgroundColor: BRAND.sunGold,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: RADIUS.card,
  },
  goText: { fontSize: 18, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  retakeBtn: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 24 },
  retakeText: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },
});
