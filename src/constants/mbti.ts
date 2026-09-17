// src/constants/mbti.ts
// Complete 16 MBTI Personality Type Definitions for Lumi
// Copy this entire file into your project

import { MBTIType, MBTIProfile } from '../types';

// ============================================================
// MBTI QUICK ASSESSMENT (4 Questions)
// ============================================================

export const QUICK_MBTI_QUESTIONS = [
  {
    id: 'ei',
    text: 'How do you prefer to recharge?',
    textHe: 'איך אתה מעדיף להטעין אנרגיה?',
    options: [
      { 
        text: 'Spend time with friends/in social settings', 
        textHe: 'בילוי עם חברים/בהתכנסויות',
        score: 'E' 
      },
      { 
        text: 'Spend quiet time alone or with close people', 
        textHe: 'זמן שקט לבד או עם אנשים קרובים',
        score: 'I' 
      },
    ],
  },
  {
    id: 'sn',
    text: 'When learning something new, what helps?',
    textHe: 'כשאתה לומד משהו חדש, מה עוזר?',
    options: [
      { 
        text: 'Concrete examples and practical how-to steps', 
        textHe: 'דוגמאות קונקרטיות וצעדים מעשיים',
        score: 'S' 
      },
      { 
        text: 'Big picture ideas and underlying patterns', 
        textHe: 'רעיונות גדולים ודפוסים בסיסיים',
        score: 'N' 
      },
    ],
  },
  {
    id: 'tf',
    text: 'When I suggest something, I prefer you...',
    textHe: 'כשאני מציע משהו, אני מעדיף שאתה...',
    options: [
      { 
        text: 'Give me the logic and evidence', 
        textHe: 'תן לי את ההיגיון והראיות',
        score: 'T' 
      },
      { 
        text: 'Show me how it helps my wellbeing', 
        textHe: 'הראה לי איך זה עוזר לרווחתי',
        score: 'F' 
      },
    ],
  },
  {
    id: 'jp',
    text: 'Your schedule preference?',
    textHe: 'העדפת התכנון שלך?',
    options: [
      { 
        text: 'Clear plan with deadlines keeps me on track', 
        textHe: 'תוכנית ברורה עם תאריכי סיום שומרים על מסלול',
        score: 'J' 
      },
      { 
        text: 'Flexibility to adapt as I go works better', 
        textHe: 'גמישות להתאמה תוך כדי התנעות טוב יותר',
        score: 'P'
      },
    ],
  },
];

// ============================================================
// FULL MBTI QUIZ — 30 questions, 6 sections of 5
// Same shape as QUICK_MBTI_QUESTIONS + a `dichotomy` tag. Each option carries a
// letter `score`; scoring just tallies letters (see personalityScoring.ts).
// Balanced ~8/8/7/7 across E-I · S-N · T-F · J-P.
// ============================================================

export type MBTIDichotomyTag = 'E/I' | 'S/N' | 'T/F' | 'J/P';

export interface MBTIQuestion {
  id: string;
  dichotomy: MBTIDichotomyTag;
  text: string;
  textHe: string;
  options: { text: string; textHe: string; score: 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P' }[];
}

export const QUIZ_SECTION_SIZE = 5;

export const MBTI_QUESTIONS: MBTIQuestion[] = [
  // ─── E / I (8) ───
  { id: 'ei1', dichotomy: 'E/I', text: 'After a long week, you recharge by…', textHe: 'אחרי שבוע ארוך, אתה נטען דרך…',
    options: [{ text: 'Going out with people', textHe: 'בילוי עם אנשים', score: 'E' }, { text: 'Quiet time on your own', textHe: 'זמן שקט לעצמך', score: 'I' }] },
  { id: 'ei2', dichotomy: 'E/I', text: 'At a party you tend to…', textHe: 'במסיבה אתה נוטה…',
    options: [{ text: 'Talk with many new people', textHe: 'לדבר עם הרבה אנשים חדשים', score: 'E' }, { text: 'Stick with a few you know', textHe: 'להישאר עם כמה שאתה מכיר', score: 'I' }] },
  { id: 'ei3', dichotomy: 'E/I', text: 'You think best…', textHe: 'אתה חושב הכי טוב…',
    options: [{ text: 'Out loud, talking it through', textHe: 'בקול, תוך כדי דיבור', score: 'E' }, { text: 'Quietly, in your head', textHe: 'בשקט, בתוך הראש', score: 'I' }] },
  { id: 'ei4', dichotomy: 'E/I', text: 'Your ideal weekend is…', textHe: 'הסופ״ש האידיאלי שלך…',
    options: [{ text: 'Full of plans and friends', textHe: 'מלא תוכניות וחברים', score: 'E' }, { text: 'Calm, with space for yourself', textHe: 'רגוע, עם מקום לעצמך', score: 'I' }] },
  { id: 'ei5', dichotomy: 'E/I', text: 'In a group you usually…', textHe: 'בקבוצה אתה בדרך כלל…',
    options: [{ text: 'Speak up early', textHe: 'מדבר מוקדם', score: 'E' }, { text: 'Listen first', textHe: 'מקשיב קודם', score: 'I' }] },
  { id: 'ei6', dichotomy: 'E/I', text: 'Meeting new people feels…', textHe: 'להכיר אנשים חדשים מרגיש…',
    options: [{ text: 'Energizing', textHe: 'ממריץ', score: 'E' }, { text: 'Draining after a while', textHe: 'מתיש אחרי זמן מה', score: 'I' }] },
  { id: 'ei7', dichotomy: 'E/I', text: 'You’d rather work…', textHe: 'אתה מעדיף לעבוד…',
    options: [{ text: 'In a lively team', textHe: 'בצוות תוסס', score: 'E' }, { text: 'Focused on your own', textHe: 'בריכוז לבד', score: 'I' }] },
  { id: 'ei8', dichotomy: 'E/I', text: 'When something exciting happens you…', textHe: 'כשקורה משהו מרגש אתה…',
    options: [{ text: 'Tell everyone right away', textHe: 'מספר לכולם מיד', score: 'E' }, { text: 'Enjoy it privately first', textHe: 'נהנה ממנו בשקט קודם', score: 'I' }] },

  // ─── S / N (8) ───
  { id: 'sn1', dichotomy: 'S/N', text: 'You trust more…', textHe: 'אתה סומך יותר על…',
    options: [{ text: 'Concrete facts and experience', textHe: 'עובדות וניסיון', score: 'S' }, { text: 'Patterns and hunches', textHe: 'דפוסים ותחושות', score: 'N' }] },
  { id: 'sn2', dichotomy: 'S/N', text: 'When learning you prefer…', textHe: 'בלימוד אתה מעדיף…',
    options: [{ text: 'Practical, step-by-step', textHe: 'מעשי, צעד-אחר-צעד', score: 'S' }, { text: 'The big idea and possibilities', textHe: 'הרעיון הגדול והאפשרויות', score: 'N' }] },
  { id: 'sn3', dichotomy: 'S/N', text: 'You focus more on…', textHe: 'אתה מתמקד יותר ב…',
    options: [{ text: 'What’s real and present', textHe: 'מה שקיים ועכשווי', score: 'S' }, { text: 'What could be, the future', textHe: 'מה שיכול להיות, העתיד', score: 'N' }] },
  { id: 'sn4', dichotomy: 'S/N', text: 'You’d describe yourself as…', textHe: 'היית מתאר את עצמך כ…',
    options: [{ text: 'Down-to-earth', textHe: 'מעשי ומקורקע', score: 'S' }, { text: 'Imaginative', textHe: 'בעל דמיון', score: 'N' }] },
  { id: 'sn5', dichotomy: 'S/N', text: 'You notice first…', textHe: 'אתה שם לב קודם ל…',
    options: [{ text: 'The details', textHe: 'הפרטים', score: 'S' }, { text: 'The overall pattern', textHe: 'התמונה הכללית', score: 'N' }] },
  { id: 'sn6', dichotomy: 'S/N', text: 'Instructions should be…', textHe: 'הוראות צריכות להיות…',
    options: [{ text: 'Specific and literal', textHe: 'מדויקות ומפורשות', score: 'S' }, { text: 'A direction to run with', textHe: 'כיוון כללי להתקדם איתו', score: 'N' }] },
  { id: 'sn7', dichotomy: 'S/N', text: 'You’re drawn to…', textHe: 'אתה נמשך ל…',
    options: [{ text: 'Proven methods', textHe: 'שיטות מוכחות', score: 'S' }, { text: 'New, untested ideas', textHe: 'רעיונות חדשים ולא בדוקים', score: 'N' }] },
  { id: 'sn8', dichotomy: 'S/N', text: 'A good story is…', textHe: 'סיפור טוב הוא…',
    options: [{ text: 'Realistic and believable', textHe: 'מציאותי ואמין', score: 'S' }, { text: 'Full of meaning and metaphor', textHe: 'מלא משמעות ומטאפורה', score: 'N' }] },

  // ─── T / F (7) ───
  { id: 'tf1', dichotomy: 'T/F', text: 'You make decisions mainly with…', textHe: 'אתה מקבל החלטות בעיקר לפי…',
    options: [{ text: 'Logic', textHe: 'היגיון', score: 'T' }, { text: 'Your values and feelings', textHe: 'הערכים והרגשות שלך', score: 'F' }] },
  { id: 'tf2', dichotomy: 'T/F', text: 'It matters more to be…', textHe: 'חשוב יותר להיות…',
    options: [{ text: 'Honest and fair', textHe: 'כן והוגן', score: 'T' }, { text: 'Kind and tactful', textHe: 'אדיב ורגיש', score: 'F' }] },
  { id: 'tf3', dichotomy: 'T/F', text: 'When a friend has a problem you…', textHe: 'כשלחבר יש בעיה אתה…',
    options: [{ text: 'Help them solve it', textHe: 'עוזר לו לפתור אותה', score: 'T' }, { text: 'Help them feel heard', textHe: 'עוזר לו להרגיש מובן', score: 'F' }] },
  { id: 'tf4', dichotomy: 'T/F', text: 'You’re convinced more by…', textHe: 'משכנע אותך יותר…',
    options: [{ text: 'Solid reasoning', textHe: 'נימוק מוצק', score: 'T' }, { text: 'How it affects people', textHe: 'איך זה משפיע על אנשים', score: 'F' }] },
  { id: 'tf5', dichotomy: 'T/F', text: 'Giving feedback you tend to be…', textHe: 'במתן משוב אתה נוטה להיות…',
    options: [{ text: 'Direct and frank', textHe: 'ישיר וגלוי', score: 'T' }, { text: 'Gentle and encouraging', textHe: 'עדין ומעודד', score: 'F' }] },
  { id: 'tf6', dichotomy: 'T/F', text: 'In a conflict you value…', textHe: 'בקונפליקט אתה מעריך…',
    options: [{ text: 'Getting to the truth', textHe: 'להגיע לאמת', score: 'T' }, { text: 'Keeping harmony', textHe: 'לשמור על הרמוניה', score: 'F' }] },
  { id: 'tf7', dichotomy: 'T/F', text: 'You’d rather be seen as…', textHe: 'היית מעדיף להיתפס כ…',
    options: [{ text: 'Competent', textHe: 'מוכשר', score: 'T' }, { text: 'Caring', textHe: 'אכפתי', score: 'F' }] },

  // ─── J / P (7) ───
  { id: 'jp1', dichotomy: 'J/P', text: 'You prefer your days…', textHe: 'אתה מעדיף את הימים שלך…',
    options: [{ text: 'Planned in advance', textHe: 'מתוכננים מראש', score: 'J' }, { text: 'Open and spontaneous', textHe: 'פתוחים וספונטניים', score: 'P' }] },
  { id: 'jp2', dichotomy: 'J/P', text: 'A to-do list makes you feel…', textHe: 'רשימת מטלות גורמת לך להרגיש…',
    options: [{ text: 'In control', textHe: 'בשליטה', score: 'J' }, { text: 'Boxed in', textHe: 'כלוא', score: 'P' }] },
  { id: 'jp3', dichotomy: 'J/P', text: 'With deadlines you…', textHe: 'עם דדליינים אתה…',
    options: [{ text: 'Finish early', textHe: 'מסיים מוקדם', score: 'J' }, { text: 'Work best near the wire', textHe: 'עובד הכי טוב ברגע האחרון', score: 'P' }] },
  { id: 'jp4', dichotomy: 'J/P', text: 'Your space tends to be…', textHe: 'המרחב שלך נוטה להיות…',
    options: [{ text: 'Organized', textHe: 'מסודר', score: 'J' }, { text: 'Comfortably messy', textHe: 'מבולגן בנוחות', score: 'P' }] },
  { id: 'jp5', dichotomy: 'J/P', text: 'You like decisions…', textHe: 'אתה אוהב החלטות…',
    options: [{ text: 'Settled and closed', textHe: 'סגורות וברורות', score: 'J' }, { text: 'Kept open a while', textHe: 'שנשארות פתוחות זמן מה', score: 'P' }] },
  { id: 'jp6', dichotomy: 'J/P', text: 'Last-minute plan changes are…', textHe: 'שינויים ברגע האחרון הם…',
    options: [{ text: 'Stressful', textHe: 'מלחיצים', score: 'J' }, { text: 'No problem — even fun', textHe: 'לא בעיה — אפילו כיף', score: 'P' }] },
  { id: 'jp7', dichotomy: 'J/P', text: 'You’d rather…', textHe: 'אתה מעדיף…',
    options: [{ text: 'Have a clear routine', textHe: 'שגרה ברורה', score: 'J' }, { text: 'Keep things flexible', textHe: 'לשמור על גמישות', score: 'P' }] },
];

// ============================================================
// COMPLETE 16 MBTI PROFILES
// ============================================================

export const MBTI_PROFILES: Record<MBTIType, MBTIProfile> = {
  // ─── INTJ: The Architect ───
  'INTJ': {
    type: 'INTJ',
    name: 'The Architect',
    emoji: '🏗️',
    energySource: 'Introvert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Judging',
    pacePreference: 'aggressive',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'needs_breaks',
    riskTolerance: 'balanced',
    communicationStyle: 'direct',
  },
  // ─── INTP: The Logician ───
  'INTP': {
    type: 'INTP',
    name: 'The Logician',
    emoji: '🧪',
    energySource: 'Introvert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'needs_breaks',
    riskTolerance: 'experimental',
    communicationStyle: 'analytical',
  },
  // ─── ENTJ: The Commander ───
  'ENTJ': {
    type: 'ENTJ',
    name: 'The Commander',
    emoji: '👑',
    energySource: 'Extrovert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Judging',
    pacePreference: 'aggressive',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'balanced',
    communicationStyle: 'direct',
  },
  // ─── ENTP: The Debater ───
  'ENTP': {
    type: 'ENTP',
    name: 'The Debater',
    emoji: '⚡',
    energySource: 'Extrovert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'experimental',
    communicationStyle: 'debating',
  },
  // ─── INFJ: The Advocate ───
  'INFJ': {
    type: 'INFJ',
    name: 'The Advocate',
    emoji: '🕊️',
    energySource: 'Introvert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Judging',
    pacePreference: 'balanced',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'needs_breaks',
    riskTolerance: 'conservative',
    communicationStyle: 'values_driven',
  },
  // ─── INFP: The Mediator ───
  'INFP': {
    type: 'INFP',
    name: 'The Mediator',
    emoji: '🌱',
    energySource: 'Introvert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'needs_breaks',
    riskTolerance: 'conservative',
    communicationStyle: 'authentic',
  },
  // ─── ENFJ: The Protagonist ───
  'ENFJ': {
    type: 'ENFJ',
    name: 'The Protagonist',
    emoji: '🎤',
    energySource: 'Extrovert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Judging',
    pacePreference: 'balanced',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'balanced',
    communicationStyle: 'inspiring',
  },
  // ─── ENFP: The Campaigner ───
  'ENFP': {
    type: 'ENFP',
    name: 'The Campaigner',
    emoji: '🎨',
    energySource: 'Extrovert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'experimental',
    communicationStyle: 'enthusiastic',
  },
  // ─── ISTJ: The Logistician ───
  'ISTJ': {
    type: 'ISTJ',
    name: 'The Logistician',
    emoji: '📋',
    energySource: 'Introvert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Judging',
    pacePreference: 'steady',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'needs_breaks',
    riskTolerance: 'conservative',
    communicationStyle: 'direct',
  },
  // ─── ISFJ: The Defender ───
  'ISFJ': {
    type: 'ISFJ',
    name: 'The Defender',
    emoji: '🛡️',
    energySource: 'Introvert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Judging',
    pacePreference: 'steady',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'needs_breaks',
    riskTolerance: 'conservative',
    communicationStyle: 'warm',
  },
  // ─── ISTP: The Virtuoso ───
  'ISTP': {
    type: 'ISTP',
    name: 'The Virtuoso',
    emoji: '🔧',
    energySource: 'Introvert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'needs_breaks',
    riskTolerance: 'balanced',
    communicationStyle: 'direct',
  },
  // ─── ISFP: The Adventurer ───
  'ISFP': {
    type: 'ISFP',
    name: 'The Adventurer',
    emoji: '🌄',
    energySource: 'Introvert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'needs_breaks',
    riskTolerance: 'conservative',
    communicationStyle: 'authentic',
  },
  // ─── ESTJ: The Executive ───
  'ESTJ': {
    type: 'ESTJ',
    name: 'The Executive',
    emoji: '💼',
    energySource: 'Extrovert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Judging',
    pacePreference: 'aggressive',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'conservative',
    communicationStyle: 'direct',
  },
  // ─── ESFJ: The Consul ───
  'ESFJ': {
    type: 'ESFJ',
    name: 'The Consul',
    emoji: '❤️',
    energySource: 'Extrovert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Judging',
    pacePreference: 'steady',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'conservative',
    communicationStyle: 'warm',
  },
  // ─── ESTP: The Entrepreneur ───
  'ESTP': {
    type: 'ESTP',
    name: 'The Entrepreneur',
    emoji: '🚀',
    energySource: 'Extrovert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Perceiving',
    pacePreference: 'aggressive',
    deadlineStyle: 'flexible',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'aggressive',
    communicationStyle: 'direct',
  },
  // ─── ESFP: The Entertainer ───
  'ESFP': {
    type: 'ESFP',
    name: 'The Entertainer',
    emoji: '🎪',
    energySource: 'Extrovert',
    informationProcessing: 'Sensing',
    decisionMaking: 'Feeling',
    lifeOrientation: 'Perceiving',
    pacePreference: 'balanced',
    deadlineStyle: 'flexible',
    socialOverload: 'energized_by_interaction',
    riskTolerance: 'experimental',
    communicationStyle: 'enthusiastic',
  },
};

// ============================================================
// COMMUNICATION & PERSONALIZATION GUIDE
// ============================================================

export interface CommunicationGuide {
  motivationalTone: string;
  reminderFrequency: 'sparse' | 'moderate' | 'frequent';
  suggestionStyle: string;
  breakFrequency: string;
  idealResponseLength: 'brief' | 'moderate' | 'detailed';
  exampleSuggestion: string;
}

export const MBTI_COMMUNICATION: Record<MBTIType, CommunicationGuide> = {
  // ─── INTJ: The Architect ───
  'INTJ': {
    motivationalTone: 'Strategic. Here\'s the long-term impact and efficiency gain.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Evidence-based, direct, no fluff, big-picture focused',
    breakFrequency: 'After deep work blocks (90+ min)',
    idealResponseLength: 'brief',
    exampleSuggestion: 'You\'ve blocked 90min for the project. Data shows you\'re most productive 10am-12pm. Schedule then?',
  },

  // ─── INTP: The Logician ───
  'INTP': {
    motivationalTone: 'Let\'s analyze this intellectually. What are all the angles?',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Analytical, exploratory, offer multiple options, appeal to curiosity',
    breakFrequency: 'Every 45min to restore focus',
    idealResponseLength: 'detailed',
    exampleSuggestion: '3 ways to approach: A) Fastest (2h), B) Most thorough (4h), C) Unconventional (1.5h). Which appeals to you?',
  },

  // ─── ENTJ: The Commander ───
  'ENTJ': {
    motivationalTone: 'Here\'s the winning strategy. Clear competitive advantage.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Action-focused, direct, competitive framing, results-oriented',
    breakFrequency: 'After intense sessions (recharge via social)',
    idealResponseLength: 'brief',
    exampleSuggestion: 'You\'re behind on Project X. Competitors ship Week 3. You can catch up if you prioritize hard. Game plan?',
  },

  // ─── ENTP: The Debater ───
  'ENTP': {
    motivationalTone: 'Interesting angle! What if we tried something unconventional?',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Present multiple options, encourage creative thinking, debate-style',
    breakFrequency: 'Frequent (thrive on variety and stimulation)',
    idealResponseLength: 'detailed',
    exampleSuggestion: 'Workshop due Tuesday. 4 approaches: traditional, AI-assisted, collaborative, unconventional. Brain dump all ideas first?',
  },

  // ─── INFJ: The Advocate ───
  'INFJ': {
    motivationalTone: 'This aligns with your values. Here\'s the impact on people.',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Connect to values, show human impact, purposeful framing',
    breakFrequency: 'After intense social/emotional tasks',
    idealResponseLength: 'moderate',
    exampleSuggestion: 'Your mentorship project matters. 5 mentees expecting feedback. You care deeply. 2h this week? I\'ll space it out.',
  },

  // ─── INFP: The Mediator ───
  'INFP': {
    motivationalTone: 'This is a chance to grow and express yourself authentically.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Encourage exploration, affirm values, support personal growth',
    breakFrequency: 'When they signal they need one (self-aware)',
    idealResponseLength: 'detailed',
    exampleSuggestion: 'Creative writing stalled. Fear of judgment? Your voice is valuable. 30min pure creative flow, no editing. Ready?',
  },

  // ─── ENFJ: The Protagonist ───
  'ENFJ': {
    motivationalTone: 'You\'re making a real difference. Here\'s your next leadership move.',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Connect to people impact, affirm leadership, inspire action',
    breakFrequency: 'Through social interaction and connection',
    idealResponseLength: 'moderate',
    exampleSuggestion: 'Team meeting prep. Your team looks up to you. Spend 30min on engagement strategy? You\'re natural at it.',
  },

  // ─── ENFP: The Campaigner ───
  'ENFP': {
    motivationalTone: 'This could be FUN and help people! Let\'s explore together!',
    reminderFrequency: 'frequent',
    suggestionStyle: 'Make it exciting, offer variety, connect to people, conversational',
    breakFrequency: 'Frequent (need stimulation and novelty)',
    idealResponseLength: 'detailed',
    exampleSuggestion: 'You\'re tackling 4 projects. Great energy! Pick 2 for this week (rotate next week). Which excite you most?',
  },

  // ─── ISTJ: The Logistician ───
  'ISTJ': {
    motivationalTone: 'Here\'s the clear plan. Step by step, measurable outcomes.',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Structured, step-by-step, clear criteria and metrics',
    breakFrequency: 'After task completion (earned break)',
    idealResponseLength: 'brief',
    exampleSuggestion: 'Project checklist: 1) Requirements (done), 2) Design (due Wed), 3) Build (due Fri), 4) Test (due Sun). On track?',
  },

  // ─── ISFJ: The Defender ───
  'ISFJ': {
    motivationalTone: 'You\'re doing great. I\'m here to support you through this.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Warm, supportive, show appreciation, offer help',
    breakFrequency: 'When they\'ve done enough for others (self-care nudge)',
    idealResponseLength: 'moderate',
    exampleSuggestion: 'You\'ve supported 5 people this week. Amazing heart. Now: what do YOU need? One hour for yourself this weekend?',
  },

  // ─── ISTP: The Virtuoso ───
  'ISTP': {
    motivationalTone: 'Here\'s what works best. Practical and effective.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Practical, efficient, no BS, options-focused',
    breakFrequency: 'When boredom/restlessness sets in',
    idealResponseLength: 'brief',
    exampleSuggestion: 'Stuck on Task A. Quickest fix (30min), best long-term (2h), learning opportunity (4h). Which matters now?',
  },

  // ─── ISFP: The Adventurer ───
  'ISFP': {
    motivationalTone: 'Let\'s do this in a way that feels right and authentic to you.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Honor autonomy, appeal to aesthetics and authenticity',
    breakFrequency: 'When they need restoration (respect their rhythm)',
    idealResponseLength: 'moderate',
    exampleSuggestion: 'Creative task is draining you. Take a break doing something beautiful. 30min drawing/music? Then approach fresh?',
  },

  // ─── ESTJ: The Executive ───
  'ESTJ': {
    motivationalTone: 'Clear goal and execution plan. Results-focused timeline.',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Goal-focused, structured, step-by-step, measurable results',
    breakFrequency: 'After task/milestone completion',
    idealResponseLength: 'brief',
    exampleSuggestion: 'Q3 goal: Ship Feature X. Design (2w), Dev (4w), Testing (1w). Start Monday. Feasible?',
  },

  // ─── ESFJ: The Consul ───
  'ESFJ': {
    motivationalTone: 'You\'re amazing at bringing people together. Keep it up!',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Affirm their care, organize support, team-focused',
    breakFrequency: 'Through social connection and appreciation',
    idealResponseLength: 'moderate',
    exampleSuggestion: 'Team morale is up because of you. Organize team celebration this week? You excel at that.',
  },

  // ─── ESTP: The Entrepreneur ───
  'ESTP': {
    motivationalTone: 'New challenge! Let\'s tackle this head-on. Competitive edge?',
    reminderFrequency: 'moderate',
    suggestionStyle: 'Action-focused, challenge-framed, competitive, tangible results',
    breakFrequency: 'Change activities (avoid boredom)',
    idealResponseLength: 'brief',
    exampleSuggestion: 'Project deadline Friday. Competition: 3 other teams ship Week 3. Can you go first? 60h work. In?',
  },

  // ─── ESFP: The Entertainer ───
  'ESFP': {
    motivationalTone: 'This could be FUN! Let\'s make it exciting and social!',
    reminderFrequency: 'frequent',
    suggestionStyle: 'Playful, social, exciting, energetic, make it enjoyable',
    breakFrequency: 'Through social fun and variety',
    idealResponseLength: 'detailed',
    exampleSuggestion: 'Work party needed? You\'re perfect at energizing teams. Organize something fun this Friday? People will love it.',
  },
};

// ============================================================
// TASK PREFERENCES BY TYPE
// ============================================================

export interface TaskPreferences {
  preferredTaskTypes: string[];
  avoidTaskTypes: string[];
  idealDeadlineStyle: 'early_bird' | 'deadline_driven' | 'flexible';
  estimatePaddingPercent: number; // How much buffer to add to time estimates
  preferredTeamSize: 'solo' | 'small_group' | 'large_team';
  completionMotivator: string;
}

export const MBTI_TASK_PREFERENCES: Record<MBTIType, TaskPreferences> = {
  'INTJ': {
    preferredTaskTypes: ['Complex problems', 'Strategic planning', 'Independent work', 'High-impact projects'],
    avoidTaskTypes: ['Routine admin', 'Excessive meetings', 'Emotional support work', 'Repetitive tasks'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 10,
    preferredTeamSize: 'solo',
    completionMotivator: 'Mastery, competence, strategic impact',
  },
  'INTP': {
    preferredTaskTypes: ['Novel problems', 'Analysis, research', 'Learning opportunities', 'Creative problem-solving'],
    avoidTaskTypes: ['Strict deadlines', 'Routine execution', 'Constant meetings', 'Finish-and-polish tasks'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 25,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Understanding, intellectual challenge, learning',
  },
  'ENTJ': {
    preferredTaskTypes: ['Leadership roles', 'High-impact projects', 'Strategic decisions', 'Competitive challenges'],
    avoidTaskTypes: ['Maintenance work', 'Slow processes', 'Emotional negotiations', 'Detail-heavy tasks'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 5,
    preferredTeamSize: 'large_team',
    completionMotivator: 'Winning, clear results, advancement',
  },
  'ENTP': {
    preferredTaskTypes: ['Brainstorming', 'Exploring options', 'Creative solutions', 'Debating ideas', 'Variety'],
    avoidTaskTypes: ['Execution-only work', 'Boring routines', 'Commitment too early', 'Details without context'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 30,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Novel angles, intellectual stimulation, fun',
  },
  'INFJ': {
    preferredTaskTypes: ['Meaningful work', 'Helping others', 'Strategic impact', 'Personal growth', 'Values-aligned'],
    avoidTaskTypes: ['Meaningless tasks', 'Harm to others', 'Competitive work', 'Shallow relationships'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 15,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Purpose, helping people, meaningful impact',
  },
  'INFP': {
    preferredTaskTypes: ['Creative expression', 'Personal growth', 'Authentic work', 'Helping causes they care about', 'Writing/art'],
    avoidTaskTypes: ['Meaningless work', 'Competitive tasks', 'Rigid processes', 'Emotionally draining'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 20,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Authenticity, personal meaning, creative expression',
  },
  'ENFJ': {
    preferredTaskTypes: ['Leadership', 'Team building', 'Inspiring others', 'Organized projects', 'People development'],
    avoidTaskTypes: ['Boring admin', 'Solo work for long periods', 'Conflict without resolution', 'Detached work'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 10,
    preferredTeamSize: 'large_team',
    completionMotivator: 'Helping team, leadership, positive impact on people',
  },
  'ENFP': {
    preferredTaskTypes: ['Variety', 'Social interaction', 'Creative projects', 'Fun initiatives', 'People-focused work'],
    avoidTaskTypes: ['Routine', 'Solo work', 'Boring details', 'Restrictive rules', 'Emotional burden without hope'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 35,
    preferredTeamSize: 'large_team',
    completionMotivator: 'Fun, variety, helping people, excitement',
  },
  'ISTJ': {
    preferredTaskTypes: ['Structured projects', 'Clear processes', 'Responsibility', 'Detail work', 'Execution'],
    avoidTaskTypes: ['Ambiguous goals', 'Constant changes', 'Emotional neediness', 'Incomplete information'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 5,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Duty fulfilled, responsibility met, measurable results',
  },
  'ISFJ': {
    preferredTaskTypes: ['Helping others', 'Supporting teams', 'Organized work', 'Caring for people', 'Practical help'],
    avoidTaskTypes: ['Hurting people', 'Conflict', 'Spotlight', 'Neglecting relationships', 'Being taken for granted'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 10,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Helping others, appreciation, loyalty',
  },
  'ISTP': {
    preferredTaskTypes: ['Hands-on work', 'Problem-solving', 'Practical skills', 'Troubleshooting', 'Independence'],
    avoidTaskTypes: ['Theory without application', 'Emotional processing', 'Meetings', 'Commitment beyond needed'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 0,
    preferredTeamSize: 'solo',
    completionMotivator: 'Efficiency, competence, practical results',
  },
  'ISFP': {
    preferredTaskTypes: ['Creative expression', 'Aesthetic work', 'Personal meaning', 'Flexible pace', 'Beauty'],
    avoidTaskTypes: ['Rigid rules', 'Judgment', 'Superficial interactions', 'Meaningless work', 'Time pressure'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 25,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Authenticity, beauty, personal satisfaction',
  },
  'ESTJ': {
    preferredTaskTypes: ['Leadership', 'Organization', 'Results-driven work', 'Structured plans', 'Team management'],
    avoidTaskTypes: ['Ambiguity', 'Slow processes', 'Emotional drama', 'Rule-breaking', 'Inefficiency'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 5,
    preferredTeamSize: 'large_team',
    completionMotivator: 'Results, organization, leadership success',
  },
  'ESFJ': {
    preferredTaskTypes: ['Team support', 'Organizing people', 'Care work', 'Collaboration', 'Practical help'],
    avoidTaskTypes: ['Ingratitude', 'Conflict', 'Detached work', 'Rule-breaking', 'Neglecting relationships'],
    idealDeadlineStyle: 'deadline_driven',
    estimatePaddingPercent: 10,
    preferredTeamSize: 'large_team',
    completionMotivator: 'Helping team, appreciation, harmony',
  },
  'ESTP': {
    preferredTaskTypes: ['Action', 'Problem-solving', 'Competitive challenges', 'Hands-on work', 'Variety'],
    avoidTaskTypes: ['Theory only', 'Slow processes', 'Routine', 'Sitting still', 'Emotional processing'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 0,
    preferredTeamSize: 'small_group',
    completionMotivator: 'Competition, tangible results, action',
  },
  'ESFP': {
    preferredTaskTypes: ['Social interaction', 'Fun activities', 'Hands-on work', 'Entertainment', 'Variety'],
    avoidTaskTypes: ['Boring routine', 'Solo work', 'Theory', 'Sadness', 'Responsibility without joy'],
    idealDeadlineStyle: 'flexible',
    estimatePaddingPercent: 30,
    preferredTeamSize: 'large_team',
    completionMotivator: 'Fun, social connection, immediate enjoyment',
  },
};

// ============================================================
// REMINDER FREQUENCY VALUES (For Backend)
// ============================================================

export const REMINDER_FREQUENCY_SETTINGS: Record<
  'sparse' | 'moderate' | 'frequent',
  { hoursInterval: number; maxPerDay: number }
> = {
  sparse: { hoursInterval: 48, maxPerDay: 1 },
  moderate: { hoursInterval: 24, maxPerDay: 2 },
  frequent: { hoursInterval: 12, maxPerDay: 4 },
};

// ============================================================
// BREAK PATTERNS (For Backend Task Scheduling)
// ============================================================

export const BREAK_PATTERNS: Record<string, { minutes: number; frequency: string }> = {
  'After deep work 90+ min': { minutes: 15, frequency: '90min work' },
  'Every 45min to restore focus': { minutes: 10, frequency: '45min work' },
  'After intense sessions (recharge via social)': { minutes: 20, frequency: 'end of session' },
  'Frequent (thrive on variety and stimulation)': { minutes: 10, frequency: '60min work' },
  'After intense social/emotional tasks': { minutes: 15, frequency: 'after social task' },
  'When they signal they need one (self-aware)': { minutes: 15, frequency: 'user-initiated' },
  'Through social interaction and connection': { minutes: 30, frequency: 'between tasks' },
  'Frequent (need stimulation and novelty)': { minutes: 10, frequency: '45min work' },
  'After task completion (earned break)': { minutes: 10, frequency: 'task completion' },
  'When they\'ve done enough for others (self-care nudge)': { minutes: 30, frequency: 'after helping' },
  'When boredom/restlessness sets in': { minutes: 15, frequency: 'user-initiated' },
  'When they need restoration (respect their rhythm)': { minutes: 20, frequency: 'user-initiated' },
  'After task/milestone completion': { minutes: 10, frequency: 'task completion' },
  'Through social connection and appreciation': { minutes: 20, frequency: 'between tasks' },
  'Change activities (avoid boredom)': { minutes: 10, frequency: '60min work' },
  'Through social fun and variety': { minutes: 15, frequency: '45min work' },
};

// ============================================================
// RESPONSE LENGTH MAPPING
// ============================================================

export const RESPONSE_LENGTH_TOKENS: Record<
  'brief' | 'moderate' | 'detailed',
  { min: number; max: number; sentences: number }
> = {
  brief: { min: 10, max: 30, sentences: 1 },
  moderate: { min: 30, max: 80, sentences: 2 },
  detailed: { min: 80, max: 150, sentences: 3 },
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

export function getMBTITypeFromAnswers(
  eiScore: number,
  snScore: number,
  tfScore: number,
  jpScore: number
): MBTIType {
  const type =
    (eiScore >= 0.5 ? 'E' : 'I') +
    (snScore >= 0.5 ? 'S' : 'N') +
    (tfScore >= 0.5 ? 'T' : 'F') +
    (jpScore >= 0.5 ? 'J' : 'P');

  return type as MBTIType;
}

export function getPersonalizedSystemPrompt(mbtiType: MBTIType, userName: string): string {
  const profile = MBTI_PROFILES[mbtiType];
  const comm = MBTI_COMMUNICATION[mbtiType];
  const prefs = MBTI_TASK_PREFERENCES[mbtiType];

  return `
You are Lumi, a warm, personality-aware task AI.

USER PROFILE:
- Name: ${userName}
- Personality Type: ${mbtiType} (${profile.name})
- Communication Style: ${profile.communicationStyle}

PERSONALIZATION GUIDE:
- Tone: ${comm.motivationalTone}
- Response Length: ${comm.idealResponseLength}
- How often to remind: ${comm.reminderFrequency} (max ${REMINDER_FREQUENCY_SETTINGS[comm.reminderFrequency].maxPerDay}/day)
- Break after: ${comm.breakFrequency}
- Suggestion Style: ${comm.suggestionStyle}

TASK PREFERENCES:
- Preferred: ${prefs.preferredTaskTypes.join(', ')}
- Avoid: ${prefs.avoidTaskTypes.join(', ')}
- Ideal deadline style: ${prefs.idealDeadlineStyle}
- Best team size: ${prefs.preferredTeamSize}
- What motivates completion: ${prefs.completionMotivator}

YOUR JOB:
1. Extract task details (minimal input → rich context)
2. Suggest tasks aligned with preferences
3. Respond in personality-aware style
4. Keep WhatsApp responses SHORT (max 2 sentences)
5. Use personality guidance above

Remember: This person is ${profile.name}. ${comm.motivationalTone}
  `;
}

// ============================================================
// EXPORT ALL
// ============================================================

export default {
  QUICK_MBTI_QUESTIONS,
  MBTI_PROFILES,
  MBTI_COMMUNICATION,
  MBTI_TASK_PREFERENCES,
  REMINDER_FREQUENCY_SETTINGS,
  BREAK_PATTERNS,
  RESPONSE_LENGTH_TOKENS,
  getMBTITypeFromAnswers,
  getPersonalizedSystemPrompt,
};