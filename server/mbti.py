"""Minimal MBTI personalization data for the server-side agent.

Mirrors the relevant slice of src/constants/mbti.ts (the mobile app remains the
source of truth for the full profiles). Only the fields the agent prompt needs
are kept here: a display name and a communication guide per type.

Dependencies: none (pure data). Consumed by lumi_agent._system_prompt via
personality_prompt(); parity with the app is checked by test_personality_parity.py.
"""
from typing import Dict, TypedDict


class Comm(TypedDict):
    name: str
    tone: str
    reminder: str  # sparse | moderate | frequent
    length: str    # brief | moderate | detailed
    style: str
    motivator: str  # what makes THIS type actually start/finish a task — drives the productivity nudge


MBTI_COMMUNICATION: Dict[str, Comm] = {
    "INTJ": {"name": "The Architect", "tone": "Strategic. Long-term impact.", "reminder": "sparse", "length": "brief", "style": "Evidence-based, direct, no fluff", "motivator": "mastery and strategic payoff — show the long-term gain of doing it now"},
    "INTP": {"name": "The Logician", "tone": "Let's analyze the angles.", "reminder": "moderate", "length": "detailed", "style": "Analytical, exploratory, multiple options", "motivator": "intellectual curiosity — frame the next step as an interesting problem to crack"},
    "ENTJ": {"name": "The Commander", "tone": "Here's the winning strategy.", "reminder": "sparse", "length": "brief", "style": "Action-focused, competitive, results-oriented", "motivator": "winning and visible progress — name the result this unlocks"},
    "ENTP": {"name": "The Debater", "tone": "What if we tried something unconventional?", "reminder": "moderate", "length": "detailed", "style": "Multiple options, creative, debate-style", "motivator": "novelty — pitch starting now as the fun, unconventional option"},
    "INFJ": {"name": "The Advocate", "tone": "This aligns with your values.", "reminder": "moderate", "length": "moderate", "style": "Connect to values, show human impact", "motivator": "purpose — connect the task to who it helps"},
    "INFP": {"name": "The Mediator", "tone": "A chance to grow authentically.", "reminder": "sparse", "length": "detailed", "style": "Encourage exploration, affirm values", "motivator": "authenticity — frame it as a step toward something they genuinely care about"},
    "ENFJ": {"name": "The Protagonist", "tone": "You're making a real difference.", "reminder": "moderate", "length": "moderate", "style": "People impact, inspire action", "motivator": "impact on others — remind them who's counting on this"},
    "ENFP": {"name": "The Campaigner", "tone": "This could be fun and help people!", "reminder": "frequent", "length": "detailed", "style": "Exciting, variety, conversational", "motivator": "excitement — make starting now sound like the fun choice, not a chore"},
    "ISTJ": {"name": "The Logistician", "tone": "Here's the clear, step-by-step plan.", "reminder": "moderate", "length": "brief", "style": "Structured, clear criteria and metrics", "motivator": "completion and order — show exactly where this fits the plan and that finishing it closes the loop"},
    "ISFJ": {"name": "The Defender", "tone": "You're doing great. I'm here to support you.", "reminder": "sparse", "length": "moderate", "style": "Warm, supportive, appreciative", "motivator": "reliability — affirm that doing this now is them taking care of their people (including themselves)"},
    "ISTP": {"name": "The Virtuoso", "tone": "Here's what works best. Practical.", "reminder": "sparse", "length": "brief", "style": "Practical, efficient, options-focused", "motivator": "efficiency — point out this is the fastest path, so just doing it now saves effort later"},
    "ISFP": {"name": "The Adventurer", "tone": "Let's do this in a way that feels right.", "reminder": "sparse", "length": "moderate", "style": "Honor autonomy, appeal to authenticity", "motivator": "personal flow — invite them to start in whatever way feels natural right now"},
    "ESTJ": {"name": "The Executive", "tone": "Clear goal and execution plan.", "reminder": "moderate", "length": "brief", "style": "Goal-focused, structured, measurable", "motivator": "results — state the concrete outcome and push to execute now"},
    "ESFJ": {"name": "The Consul", "tone": "You're great at bringing people together.", "reminder": "moderate", "length": "moderate", "style": "Affirm care, team-focused", "motivator": "appreciation — note who benefits and that they're already known for following through"},
    "ESTP": {"name": "The Entrepreneur", "tone": "New challenge! Let's tackle it head-on.", "reminder": "moderate", "length": "brief", "style": "Action-focused, competitive, tangible", "motivator": "momentum — challenge them to just start, results talk"},
    "ESFP": {"name": "The Entertainer", "tone": "This could be fun and social!", "reminder": "frequent", "length": "detailed", "style": "Playful, social, energetic", "motivator": "energy — make the next step sound lively, not a grind"},
}


def personality_prompt(mbti_type: str | None, confidence: float = 0.4) -> str:
    """Return a short personality block for the system prompt, or '' if unknown."""
    if not mbti_type or mbti_type not in MBTI_COMMUNICATION:
        return ""
    c = MBTI_COMMUNICATION[mbti_type]
    pct = round(confidence * 100)
    return (
        f"\nPERSONALITY ({mbti_type} — {c['name']}, {pct}% confident):\n"
        f"- Tone: {c['tone']}\n"
        f"- Style: {c['style']}\n"
        f"- Reminder frequency: {c['reminder']}; ideal response length: {c['length']}\n"
        f"- What actually moves this person to act: {c['motivator']}\n"
        "PUSH PRODUCTIVITY: don't just answer — end with a short, type-tailored nudge toward the "
        "next concrete action (using what moves them, above) when there's an obvious next step. "
        "Skip the nudge if they're just chatting or already mid-task. Adapt your phrasing to this "
        "person. Do NOT mention MBTI out loud.\n"
    )
