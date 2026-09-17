/**
 * Pure MBTI scoring — NO React Native / storage imports, so it runs anywhere
 * (app, node, tsx test). This is the TS half of a hand-maintained mirror with
 * server/personality_learning_service.py `compute_personality`; the parity test
 * (tests/run-personality-parity.ts) asserts both produce identical output for the
 * same fixture, so the two can't silently drift.
 */
import { LearnedPersonality, MBTIType, MBTIDichotomy, PersonalitySignalType } from '../types';

// Each signal nudges one side of one dichotomy. +direction => first letter (E/S/T/J).
export const SIGNAL_TO_DICHOTOMY: Record<PersonalitySignalType, { dichotomy: MBTIDichotomy; direction: 1 | -1 }> = {
  suggestion_accepted: { dichotomy: 'E/I', direction: 1 },
  suggestion_rejected: { dichotomy: 'E/I', direction: -1 },
  detail_requested: { dichotomy: 'S/N', direction: 1 },
  big_picture_preferred: { dichotomy: 'S/N', direction: -1 },
  logic_motivated: { dichotomy: 'T/F', direction: 1 },
  emotion_motivated: { dichotomy: 'T/F', direction: -1 },
  fixed_task_completed: { dichotomy: 'J/P', direction: 1 },
  flexible_task_completed: { dichotomy: 'J/P', direction: -1 },
};

/** First/second letter per dichotomy — order matches the Python twin. */
export const DICHOTOMY_LETTERS: Record<MBTIDichotomy, [string, string]> = {
  'E/I': ['E', 'I'],
  'S/N': ['S', 'N'],
  'T/F': ['T', 'F'],
  'J/P': ['J', 'P'],
};

const DICHOTOMY_ORDER: MBTIDichotomy[] = ['E/I', 'S/N', 'T/F', 'J/P'];

/** Mirrors server compute_personality() exactly. `signals` is the flat observation list. */
export function computePersonality(
  userId: string,
  quickType: MBTIType | undefined,
  quickConf: number,
  signals: { signalType: PersonalitySignalType; confidence: number }[],
): LearnedPersonality {
  const scores: Record<MBTIDichotomy, number> = { 'E/I': 0, 'S/N': 0, 'T/F': 0, 'J/P': 0 };
  const counts: Record<MBTIDichotomy, number> = { 'E/I': 0, 'S/N': 0, 'T/F': 0, 'J/P': 0 };
  for (const sig of signals) {
    const mapping = SIGNAL_TO_DICHOTOMY[sig.signalType];
    if (!mapping) continue;
    scores[mapping.dichotomy] += mapping.direction * sig.confidence;
    counts[mapping.dichotomy] += 1;
  }

  let behavioral = '';
  let final = '';
  DICHOTOMY_ORDER.forEach((dich, i) => {
    const [first, second] = DICHOTOMY_LETTERS[dich];
    const quickLetter = quickType && quickType.length === 4 ? quickType[i] : first;
    if (counts[dich] === 0) {
      behavioral += quickLetter;
      final += quickLetter;
    } else {
      const letter = scores[dich] >= 0 ? first : second;
      behavioral += letter;
      final += letter;
    }
  });

  const signalCount = signals.length;
  const behavioralConfidence = Math.min(signalCount / 10, 1.0);
  const finalConfidence = Math.max(quickConf, behavioralConfidence);

  return {
    userId,
    quickAssessmentType: quickType,
    quickAssessmentConfidence: quickConf,
    behavioralType: signalCount ? (behavioral as MBTIType) : undefined,
    behavioralConfidence,
    finalType: quickType || signalCount ? (final as MBTIType) : undefined,
    finalConfidence,
    signalCount,
    lastUpdated: Date.now(),
  };
}
