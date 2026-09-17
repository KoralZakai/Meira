"""Server-side behavioral learning — mirrors src/services/PersonalityLearningService.ts.

Same inference rules as the mobile app, backed by user_store instead of
AsyncStorage (it used to name a `personality_signals` Postgres table that was
never provisioned, so every signal it recorded was thrown away).

Dependencies: user_store (users + signals).
get_learned_personality is called by main.whatsapp_webhook each turn and feeds
lumi_agent._system_prompt; parity with the TS twin is guarded by
test_personality_parity.py (shared fixture personality_parity_fixture.json).
"""
from typing import Optional

import user_store
from user_store import DatabaseService

# signal_type -> (dichotomy, direction). +1 => first letter (E/S/T/J).
SIGNAL_MAP = {
    "suggestion_accepted": ("E/I", 1),
    "suggestion_rejected": ("E/I", -1),
    "detail_requested": ("S/N", 1),
    "big_picture_preferred": ("S/N", -1),
    "logic_motivated": ("T/F", 1),
    "emotion_motivated": ("T/F", -1),
    "fixed_task_completed": ("J/P", 1),
    "flexible_task_completed": ("J/P", -1),
}

DICHOTOMY_LETTERS = {
    "E/I": ("E", "I"),
    "S/N": ("S", "N"),
    "T/F": ("T", "F"),
    "J/P": ("J", "P"),
}
ORDER = ["E/I", "S/N", "T/F", "J/P"]


def compute_personality(user_id: str, quick_type: Optional[str], quick_conf: float,
                         signals: list) -> dict:
    """Pure scoring step, no DB — mirrors PersonalityLearningService.ts's getLearnedPersonality.
    signals: list of (signal_type, confidence) tuples."""
    scores = {d: 0.0 for d in ORDER}
    counts = {d: 0 for d in ORDER}
    for signal_type, confidence in signals:
        mapping = SIGNAL_MAP.get(signal_type)
        if not mapping:
            continue
        dichotomy, direction = mapping
        scores[dichotomy] += direction * float(confidence)
        counts[dichotomy] += 1

    behavioral = ""
    final = ""
    for i, dichotomy in enumerate(ORDER):
        first, second = DICHOTOMY_LETTERS[dichotomy]
        quick_letter = quick_type[i] if quick_type and len(quick_type) == 4 else first
        if counts[dichotomy] == 0:
            behavioral += quick_letter
            final += quick_letter
        else:
            letter = first if scores[dichotomy] >= 0 else second
            behavioral += letter
            final += letter

    signal_count = len(signals)
    behavioral_conf = min(signal_count / 10.0, 1.0)
    final_conf = max(quick_conf, behavioral_conf)

    return {
        "userId": user_id,
        "quickAssessmentType": quick_type,
        "quickAssessmentConfidence": quick_conf,
        "behavioralType": behavioral if signal_count else None,
        "behavioralConfidence": behavioral_conf,
        "finalType": final if (quick_type or signal_count) else None,
        "finalConfidence": final_conf,
        "signalCount": signal_count,
    }


class PersonalityLearningService:
    """DB-backed twin of the app's PersonalityLearningService (same math)."""

    @staticmethod
    async def record_signal(user_id: str, signal_type: str, confidence: float = 0.4) -> None:
        """Store one behavioral signal (must be a SIGNAL_MAP key; others ignored)."""
        if signal_type not in SIGNAL_MAP:
            return
        dichotomy, _ = SIGNAL_MAP[signal_type]
        user_store.add_signal(user_id, signal_type, dichotomy,
                              max(0.0, min(1.0, confidence)))

    @staticmethod
    async def get_learned_personality(user_id: str) -> Optional[dict]:
        """Quiz type + accumulated signals -> compute_personality dict, or None if no user."""
        user = await DatabaseService.get_user_by_id(user_id)
        if not user:
            return None
        quick_type = user.get("mbti_type")
        quick_conf = float(user.get("mbti_confidence") or 0.4)
        signals = user_store.signals_for(user_id)
        return compute_personality(user_id, quick_type, quick_conf, signals)

    @staticmethod
    async def suggest_personality_refinement(user_id: str) -> Optional[str]:
        """A user-facing line when behavior contradicts (or strongly confirms) the
        quiz type — None until there's enough signal to say anything."""
        learned = await PersonalityLearningService.get_learned_personality(user_id)
        if not learned or learned["signalCount"] < 10:
            return None
        pct = round((learned["behavioralConfidence"] or 0) * 100)
        if (learned["behavioralConfidence"] or 0) >= 0.8 and \
                learned["behavioralType"] != learned["quickAssessmentType"]:
            return (f"I think you're actually {learned['behavioralType']}, "
                    f"not {learned['quickAssessmentType']}. Sound right? ({pct}% sure)")
        if learned["signalCount"] >= 15 and (learned["behavioralConfidence"] or 0) >= 0.85:
            return f"I know you pretty well now — {learned['finalType']} ({pct}% confident)."
        return None
