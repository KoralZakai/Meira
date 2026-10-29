/**
 * PersonalityLearningService — behavioral MBTI learning stored in
 * AsyncStorage; records signals (suggestion accepted, detail requested…) and
 * blends them with the quick-quiz type.
 *
 * Dependencies: personalityScoring (pure shared math), AsyncStorage.
 * Server twin: server/personality_learning_service.py — parity is guarded by
 * server/test_personality_parity.py; change the math in BOTH places.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import {
  LearnedPersonality,
  MBTIType,
  PersonalitySignal,
  PersonalitySignalType,
} from '../types';
import { computePersonality, SIGNAL_TO_DICHOTOMY } from './personalityScoring';

/**
 * PersonalityLearningService — SMART MBTI behavioral learning.
 *
 * Phase 1 (Day 0): a 4-question quick assessment gives an initial type at
 * ~0.4 confidence (see QuickMBTIScreen + saveQuickAssessment).
 * Phase 2 (Days 1-15): every meaningful interaction records a PersonalitySignal.
 * From the accumulated signals we infer a per-dichotomy "behavioral" type whose
 * confidence climbs toward ~0.9 as evidence builds.
 *
 * Persistence: AsyncStorage only (offline-first, ships today). The same shape
 * mirrors the Postgres `personality_signals` table used by the WhatsApp backend,
 * so a future cloud sync is a drop-in.
 */

const SIGNALS_KEY = 'lumi.personalitySignals.v1';
const LEARNED_KEY = 'lumi.learnedPersonality.v1';

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await AsyncStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** AsyncStorage-backed behavioral MBTI learning; records signals and blends with the quiz type (math shared with the Python twin via personalityScoring). */
export const PersonalityLearningService = {
  /** Persist the Day-0 quick assessment result (confidence ~0.4). */
  async saveQuickAssessment(userId: string, type: MBTIType): Promise<LearnedPersonality> {
    const existing = await readJSON<LearnedPersonality | null>(LEARNED_KEY, null);
    const learned: LearnedPersonality = {
      userId,
      quickAssessmentType: type,
      quickAssessmentConfidence: 0.4,
      behavioralType: existing?.behavioralType,
      behavioralConfidence: existing?.behavioralConfidence,
      finalType: type,
      finalConfidence: Math.max(0.4, existing?.behavioralConfidence ?? 0),
      signalCount: existing?.signalCount ?? 0,
      lastUpdated: Date.now(),
    };
    await writeJSON(LEARNED_KEY, learned);
    return learned;
  },

  /** Record one behavioral observation, then refresh the learned personality. */
  async recordSignal(
    userId: string,
    signalType: PersonalitySignalType,
    confidence = 0.4,
  ): Promise<void> {
    const mapping = SIGNAL_TO_DICHOTOMY[signalType];
    if (!mapping) {
      console.warn('[PersonalityLearning] unknown signal type', signalType);
      return;
    }
    const signals = await readJSON<PersonalitySignal[]>(SIGNALS_KEY, []);
    signals.push({
      id: randomId(),
      userId,
      signalType,
      dichotomy: mapping.dichotomy,
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: Date.now(),
    });
    // Cap history so storage stays bounded.
    await writeJSON(SIGNALS_KEY, signals.slice(-500));
    await this.getLearnedPersonality(userId); // recompute + persist
  },

  async getSignals(userId: string): Promise<PersonalitySignal[]> {
    const all = await readJSON<PersonalitySignal[]>(SIGNALS_KEY, []);
    return all.filter((s) => s.userId === userId);
  },

  /**
   * Infer the behavioral type from accumulated signals and blend it with the
   * quick assessment. Per dichotomy: sum signed (direction × confidence); the
   * winning letter is whichever side has the larger magnitude. Behavioral
   * confidence scales toward 1.0 at ~10 signals.
   */
  async getLearnedPersonality(userId: string): Promise<LearnedPersonality | null> {
    const stored = await readJSON<LearnedPersonality | null>(LEARNED_KEY, null);
    const signals = await this.getSignals(userId);

    const quickType = stored?.quickAssessmentType;
    const quickConfidence = stored?.quickAssessmentConfidence ?? (quickType ? 0.4 : 0);

    if (!stored && signals.length === 0) return null;

    const learned = computePersonality(
      userId,
      quickType,
      quickConfidence,
      signals.map((s) => ({ signalType: s.signalType, confidence: s.confidence })),
    );
    await writeJSON(LEARNED_KEY, learned);
    return learned;
  },

  /**
   * After enough evidence, return a SHORT message (EN/HE) inviting the user to
   * confirm a refined type — or confirming the original was right. null until
   * there's enough data (keeps the learning phase quiet, no UI noise).
   */
  async suggestPersonalityRefinement(
    userId: string,
    language: 'en' | 'he' = 'en',
  ): Promise<string | null> {
    const learned = await this.getLearnedPersonality(userId);
    if (!learned || learned.signalCount < 10) return null;

    const pct = Math.round((learned.behavioralConfidence ?? 0) * 100);

    if (
      (learned.behavioralConfidence ?? 0) >= 0.8 &&
      learned.behavioralType &&
      learned.behavioralType !== learned.quickAssessmentType
    ) {
      return language === 'he'
        ? `נראה לי שאתה דווקא ${learned.behavioralType}, לא ${learned.quickAssessmentType}. נכון? (${pct}% בטוח)`
        : `I think you're actually ${learned.behavioralType}, not ${learned.quickAssessmentType}. Sound right? (${pct}% sure)`;
    }

    if (learned.signalCount >= 15 && (learned.behavioralConfidence ?? 0) >= 0.85) {
      return language === 'he'
        ? `אני מכיר אותך טוב עכשיו — ${learned.finalType} (${pct}% בטוח).`
        : `I know you pretty well now — ${learned.finalType} (${pct}% confident).`;
    }

    return null;
  },

  /** Apply a user's confirmation/correction of the suggested type. */
  async confirmType(userId: string, type: MBTIType): Promise<LearnedPersonality> {
    const learned = (await this.getLearnedPersonality(userId)) ?? {
      userId,
      quickAssessmentConfidence: 0.4,
      finalType: type,
      finalConfidence: 0.9,
      signalCount: 0,
      lastUpdated: Date.now(),
    };
    const next: LearnedPersonality = {
      ...learned,
      finalType: type,
      finalConfidence: Math.max(0.9, learned.finalConfidence),
      lastUpdated: Date.now(),
    };
    await writeJSON(LEARNED_KEY, next);
    return next;
  },

  /** Test/debug helper — clears all learned data for the device. */
  async reset(): Promise<void> {
    await AsyncStorage.multiRemove([SIGNALS_KEY, LEARNED_KEY]);
  },
};

export default PersonalityLearningService;
