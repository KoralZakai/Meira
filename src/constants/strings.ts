import { AppLanguage, CheckInType } from '../types/models';

type PromptSet = {
  morningIntroNoBacklog: string;
  morningIntroWithBacklog: (tasks: string) => string;
  morningConfirm: (tasks: string) => string;
  afternoonIntro: string;
  afternoonConfirm: (tasks: string) => string;
  eveningIntro: string;
  eveningConfirmDone: (tasks: string) => string;
  eveningAllDone: string;
  eveningMoveSummary: (count: number) => string;
  noSpeechRetry: string;
  backlogSummary: (taskCount: number, dayCount: number) => string;
};

export const STRINGS: Record<AppLanguage, PromptSet> = {
  en: {
    morningIntroNoBacklog: 'Good morning! What are your plans for today?',
    morningIntroWithBacklog: (tasks: string) =>
      `Good morning! Here is what you did not finish yesterday: ${tasks}. Now, what are your plans for today?`,
    morningConfirm: (tasks: string) =>
      `Got it! Here are your tasks for today: ${tasks}. Good luck with your day!`,
    afternoonIntro: 'What are your plans for today? Tell me your to-do list!',
    afternoonConfirm: (tasks: string) => `Great! I marked ${tasks} as done.`,
    eveningIntro: 'Good evening! What did you complete today?',
    eveningConfirmDone: (tasks: string) => `Nice work. I marked ${tasks} as completed.`,
    eveningAllDone: 'Amazing! You completed everything today!',
    eveningMoveSummary: (count: number) => `I moved ${count} tasks to tomorrow. Good night!`,
    noSpeechRetry: 'I did not catch that, can you try again?',
    backlogSummary: (taskCount: number, dayCount: number) =>
      `You have ${taskCount} tasks from the past ${dayCount} days. Let us review them.`,
  },
  he: {
    morningIntroNoBacklog: 'בוקר טוב! מה התוכניות שלך להיום?',
    morningIntroWithBacklog: (tasks: string) =>
      `בוקר טוב! הנה מה שלא סיימת אתמול: ${tasks}. מה התוכניות שלך להיום?`,
    morningConfirm: (tasks: string) => `הבנתי! הנה המשימות שלך להיום: ${tasks}. בהצלחה!`,
    afternoonIntro: 'צהריים טובים! מה הספקת להשלים הבוקר?',
    afternoonConfirm: (tasks: string) => `מעולה! סימנתי כהושלם: ${tasks}.`,
    eveningIntro: 'ערב טוב! מה השלמת היום?',
    eveningConfirmDone: (tasks: string) => `מעולה. סימנתי כהושלם: ${tasks}.`,
    eveningAllDone: 'מדהים! השלמת הכול היום!',
    eveningMoveSummary: (count: number) => `העברתי ${count} משימות למחר. לילה טוב!`,
    noSpeechRetry: 'לא קלטתי, אפשר לנסות שוב?',
    backlogSummary: (taskCount: number, dayCount: number) =>
      `יש לך ${taskCount} משימות מ-${dayCount} הימים האחרונים. בוא נעבור עליהן.`,
  },
};

export const CHECK_IN_TITLES: Record<AppLanguage, Record<CheckInType, string>> = {
  en: {
    morning: 'Morning check-in',
    afternoon: 'Afternoon check-in',
    evening: 'Evening check-in',
  },
  he: {
    morning: 'צק-אין בוקר',
    afternoon: 'צק-אין צהריים',
    evening: 'צק-אין ערב',
  },
};

export const LUMI_FILLER_WORDS = ['um', 'uh', 'like', 'so', 'you know', 'kind of'];

export const LUMI_AGENT_SYSTEM_PROMPT = [
  'You are Lumi, a warm and friendly AI time assistant.',
  'You receive the user transcript and must return ONLY valid JSON.',
  'Detect intent and extract tasks in a way that supports task planning and check-ins.',
  'JSON shape:',
  '{',
  '  "intent": "add_tasks" | "check_in" | "task_update" | "conflict" | "optimize" | "wake_up" | "profile_update" | "empty_list" | "classify_group",',
  '  "tasks": [',
  '    {',
  '      "text": string,',
  '      "priority": "must" | "have_to" | "need_to" | "nice_to_do",',
  '      "category": "interview" | "course" | "conference" | "class" | "work" | "meeting" | "call" | "doctor" | "gym" | "aspiration" | "leisure" | "zoom" | "hobby_class" | "general",',
  '      "subgroup": string | null,   // dynamic label e.g. "Gym", "AI Course", "Calls", "Doctor" etc.',
  '      "hasLocation": boolean,',
  '      "location": string | null,   // place name or address if mentioned',
  '      "hasDeadline": boolean,',
  '      "deadline": string | null,   // time/date string if mentioned (HH:MM or ISO)',
  '      "how": string | null,        // method or approach (e.g. "via WhatsApp", "in person", "by email")',
  '      "why": string | null,        // reason or context (e.g. "to reschedule", "order was wrong")',
  '      "contact_name": string | null,  // person to contact if applicable (e.g. "Mom", "Dr. Levy")',
  '      "contact_phone": string | null  // phone number if spoken',
  '    }',
  '  ],',
  '  "task_updates": [',
  '    {',
  '      "target_text": string,',
  '      "new_text": string | null,',
  '      "new_location": string | null,',
  '      "new_deadline": string | null',
  '    }',
  '  ],',
  '  "matched_task_texts": string[],',
  '  "conflicts": any[],',
  '  "suggestions": any[],',
  '  "permissions_needed": string[],',
  '  "lumi_message": string',
  '}',
  'Rules:',
  '- In capture mode, set intent to "add_tasks" and fill tasks array.',
  '- In review mode, set intent to "check_in" and fill matched_task_texts.',
  '- If user asks to change/update/reschedule an existing task, set intent to "task_update" and fill task_updates.',
  '- If user asks to update routine/profile info (habits/transport/work start/sleep), set intent to "profile_update".',
  '- For tasks involving calling/phoning/emailing a person, extract contact_name and contact_phone when present.',
  '- For tasks where a method is clear ("via WhatsApp", "by email", "in person"), set how.',
  '- For tasks where a reason is mentioned ("because", "since", "to", "so I can"), set why.',
  '- subgroup must be a short descriptive label that groups related tasks (e.g. "Gym", "Work", "Calls", "AI Course", "Doctor").',
  '- Strip fillers and keep task text concise.',
  '- Never include markdown or explanations, JSON only.',
].join('\n');

export const LUMI_ONBOARDING_AGENT_SYSTEM_PROMPT = [
  'You are Lumi, a warm and friendly AI time assistant doing a first-time onboarding conversation.',
  '',
  'The user just answered one of your onboarding questions by voice.',
  '',
  'Extract as much profile information as you can from their answer. Return ONLY valid JSON matching this shape:',
  '{',
  '  "name": string or null,',
  '  "transportMode": "car" | "foot" | "bicycle" | "transit" | null,',
  '  "homeAddress": string or null,',
  '  "workAddress": string or null,',
  '  "morningHabits": [ { "habit": string, "estimatedMinutes": number } ] or [],',
  '  "totalMorningMinutesEstimate": number or null,',
  '  "workStartTime": string (HH:MM) or null,',
  '  "sleepTime": string (HH:MM) or null,',
  '  "missingFields": [ list of field names still needed ],',
  '  "followUpQuestion": "Lumi\'s next warm friendly question to get missing info, or empty string if all done",',
  '  "isComplete": boolean',
  '}',
  '',
  'Required fields that MUST be collected before isComplete = true:',
  '- name',
  '- transportMode',
  '- morningHabits (at least 2 habits with times, OR totalMorningMinutesEstimate)',
  '- workStartTime',
  '- sleepTime',
  '',
  'Optional (collect if mentioned):',
  '- homeAddress (tell user it stays private on device)',
  '- workAddress — the place they commute TO. The opening question asks for it,',
  '  so never ask again for something they already said.',
  '- constraints / habits: anything true about their days that a calendar will',
  '  never show — a school pickup, a standing class, an hour that is never free,',
  '  "I cannot do mornings". Put these verbatim in routinesNotes. They are the',
  '  reason a technically valid plan can still be wrong.',
  '',
  '  "routinesNotes": string or null,   // constraints + habits, in their words',
  '',
  'If the user gives a rough total time for their morning (e.g. "about an hour") and no specific habits, set totalMorningMinutesEstimate and leave morningHabits empty.',
  '',
  'Always be warm, encouraging, and concise in followUpQuestion. One question at a time only.',
  'The opening question already asked for everything at once, so most people',
  'answer several fields in one breath. Read the whole answer before deciding',
  'what is still missing — asking again for something they just said is the',
  'fastest way to lose them.',
  'Answer in the language the user wrote in.',
].join('\n');

export const ONBOARDING_STRINGS = {
  title: 'Your Lumi Profile',
  /**
   * The first thing Lumi ever says. It asks for the WHOLE picture in one open
   * question rather than marching through a form, because that is how someone
   * describes their life when you actually ask — and because every field here
   * is one the travel chain cannot work without: no home, no origin; no work,
   * no commute; no routine, no wake time.
   *
   * "Constraints" earns its place: the things that are true about a day and
   * never appear on a calendar — school pickup, a standing appointment, an
   * hour that is never free. Those are what make a plan wrong in a way the
   * user cannot explain afterwards.
   */
  openingMessage:
    "Hi, I'm Lumi — your personal secretary. Tell me all about you: where do you live, "
    + 'where do you work, and how do you get there? What are your morning routines, '
    + 'your constraints, and your habits?',
  openingMessageHe:
    'היי, אני לומי — העוזרת האישית שלך. ספרי לי הכל עלייך: איפה את גרה, איפה את עובדת, '
    + 'ואיך את מגיעה לשם? מה שגרת הבוקר שלך, מה האילוצים שלך, ומה ההרגלים?',
  /** Both ways in, said out loud — a mic-only screen strands anyone whose
   *  speech recognition does not work, and they cannot get past onboarding. */
  typeHint: 'Type here, or tap the mic…',
  typeHintHe: 'אפשר גם לכתוב כאן…',
  sttRetry: "I didn't catch that \u2014 tap the mic, or just type it \ud83c\udf99",
  agentRetry: "Something went wrong \u2014 let's try that again",
  fallbackFollowUp: 'Tell me a little more so I can complete your profile.',
  defaultHabitLabel: 'Morning routine',
  sensitiveHomeHint: 'Your home address stays private on this device.',
  typingLabel: 'Lumi is typing...',
  micIcon: '\ud83c\udf99',
  completionMessage: (name: string) =>
    `Perfect, ${name}! I saved your profile. Review it here and edit anything by voice.`,
};

export const PROFILE_EDIT_STRINGS = {
  title: 'Your Profile',
  intro: 'Tell me what changed about your habits, public transportation or travel mode, work start, sleep time, or home location.',
  noProfile: 'I could not find your profile yet. Please complete onboarding first.',
  sttRetry: "I didn't catch that. Tap the mic and try again.",
  saveError: 'I could not update your profile this time. Try again.',
  emptyProfileHint: 'No profile yet. Tap below and tell Lumi about your habits.',
  startProfile: 'Tell Lumi About You',
};

export const NEARBY_REMINDER_STRINGS = {
  title: 'Nearby task reminder',
  body: (taskText: string, location: string) =>
    `You are close to ${location}. You can complete \"${taskText}\".`,
};

export const WAKE_REMINDER_STRINGS = {
  title: 'Lumi timing reminder',
  prepBody: (taskText: string, arrivalTime: string, leaveTime: string, prepMinutes: number) =>
    `To be on time for "${taskText}" at ${arrivalTime}, start getting ready now (~${prepMinutes} min). Leave by ${leaveTime}.`,
  leaveNowBody: (taskText: string, arrivalTime: string) =>
    `It is time to leave now for "${taskText}" so you can arrive by ${arrivalTime}.`,
};

// Extended strings for new features
export const EXTENDED_STRINGS = {
  en: {
    // Greetings
    morningGreeting: "Good morning! What are your plans for today?",
    afternoonGreeting: "Good afternoon! What did you get done?",
    eveningGreeting: "Good evening! Let's wrap up your day.",
    // Listening
    listeningPrompt: "I'm listening...",
    typeInstead: "Type instead",
    // Tasks
    taskConfirm: "Got it! Here are your tasks:",
    noTasks: "You have a free day! Want to add a workout, some reading, or tell me what's on your mind?",
    // Questions Lumi asks
    askDuration: "How long do you think this will take?",
    askDeadline: "When do you need to submit this?",
    askStarted: "Have you started any part of this yet?",
    askConfirmLocation: "Is this the right place?",
    // Transit
    leaveNow: "Time to leave now for {task}! Bus {line} departs {stop} in {minutes} min.",
    missedBus: "Your bus is in {minutes} min and you haven't left yet! Next bus at {next}.",
    arrivedConfirm: "You made it to {place}! Great job! +25 points 🎉",
    // Rewards
    levelUp: "Amazing! You reached level {level}! Keep it up! 🎉",
    streakMessage: "You're on a {streak}-day streak! Unstoppable! 🔥",
    perfectDay: "Perfect day! You completed everything! +50 points 👑",
    timeAccurate: "Spot on! You estimated {task} perfectly! +10 points ⭐",
    // Gap filler
    gapQuestion: "You have {duration} free. What would you like to do?",
    gapSuggestion: "How about: {suggestion}",
    gapReason: "{reason}",
    // Motivational
    motivational: [
      "Every task you complete brings you closer to your goals! 💪",
      "You're doing great — one step at a time! 🚀",
      "Progress, not perfection! Keep going! ⭐",
    ],
    // Time verification popup
    timeVerifyTitle: "How long did {task} actually take?",
    timeVerifyLearned: "Got it! I'll remember {task} takes about {minutes} min for you.",
  },
  he: {
    morningGreeting: "בוקר טוב! מה התוכניות שלך להיום?",
    afternoonGreeting: "צהריים טובים! מה הספקת לעשות?",
    eveningGreeting: "ערב טוב! בואי נסכם את היום.",
    listeningPrompt: "מקשיבה...",
    typeInstead: "הקלד במקום",
    taskConfirm: "מעולה! הנה המשימות שלך:",
    noTasks: "יש לך יום פנוי! רוצה להוסיף אימון, קריאה, או לספר לי מה יש לך?",
    askDuration: "כמה זמן לדעתך זה ייקח?",
    askDeadline: "מתי צריך להגיש?",
    askStarted: "כבר התחלת חלק מזה?",
    askConfirmLocation: "זה המקום הנכון?",
    leaveNow: "הגיע הזמן לצאת ל{task}! אוטובוס {line} יוצא מ{stop} בעוד {minutes} דקות.",
    missedBus: "האוטובוס שלך בעוד {minutes} דקות ועוד לא יצאת! האוטובוס הבא ב-{next}.",
    arrivedConfirm: "הגעת ל{place}! כל הכבוד! +25 נקודות 🎉",
    levelUp: "וואו! הגעת לרמה {level}! המשך כך! 🎉",
    streakMessage: "אתה ב-streak של {streak} ימים! אין לך עצירה! 🔥",
    perfectDay: "יום מושלם! השלמת הכל! +50 נקודות 👑",
    timeAccurate: "מדויק! הערכת את {task} בול! +10 נקודות ⭐",
    gapQuestion: "יש לך {duration} פנויות. מה תרצה לעשות?",
    gapSuggestion: "מה דעתך על: {suggestion}",
    gapReason: "{reason}",
    motivational: [
      "כל משימה שאתה מסיים מקרבת אותך ליעדים שלך! 💪",
      "אתה עושה עבודה נהדרת — צעד אחד בכל פעם! 🚀",
      "התקדמות, לא שלמות! המשך! ⭐",
    ],
    timeVerifyTitle: "כמה זמן {task} לקח לך באמת?",
    timeVerifyLearned: "הבנתי! אזכור ש{task} לוקח לך כ-{minutes} דקות.",
  },
};
