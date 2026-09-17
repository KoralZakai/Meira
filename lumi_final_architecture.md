# Lumi — Final Architecture Document v3.0
*עודכן אחרי כל שאלות העיצוב, הארכיטקטורה, הכלים והניווט*

---

## 1. צבעים ועיצוב

### פלטת צבעים ראשית
```
PRIMARY_YELLOW   = #FFD166   — כפתורים, פעולות, מיקרופון, הדגשות
PRIMARY_PURPLE   = #6C63FF   — לומי עצמה, avatar, הודעות לומי, AI elements
PASTEL_BG        = #FFFDF5   — רקע כללי (light mode)
DARK_BG          = #1A1A2E   — רקע (dark mode)
PASTEL_CARD      = #FFF8E7   — כרטיסיות משימה (light)
DARK_CARD        = #252542   — כרטיסיות משימה (dark)
SUCCESS_GREEN    = #06D6A0   — השלמה, הגעה בזמן
DANGER_RED       = #EF476F   — דדליין דחוף, איחור
WARNING_ORANGE   = #FF9F1C   — אזהרות, "צא עכשיו"
TEXT_PRIMARY     = #2D2D2D   — טקסט ראשי (light)
TEXT_SECONDARY   = #8A8A9A   — טקסט משני
```

### עקרונות עיצוב
- כרטיסיות עגולות (border-radius: 16px), צללים עדינים
- כפתור מיקרופון: עגול, צהוב בולט, מרכז תחתון המסך
- כפתור (+) ידני: קטן יותר, לצד המיקרופון
- אייקוני קטגוריות: ברורים, צבעוניים, פסטל לפי קטגוריה
- progress bars: עגולים, צבע לפי קטגוריה
- אנימציות: עדינות, לא מוגזמות
- פונט: עברית + אנגלית, קריא, 16px בסיס

---

## 2. קטגוריות (מעודכן לפי הרשימה שלך)

```typescript
export type TaskCategory =
  'interview'    // ראיונות עבודה       — 🎯 סגול
  'course'       // ללמוד קורס X        — 📚 כחול
  'conference'   // כנסים               — 🎪 כתום
  'class'        // שיעורים             — ✏️ צהוב
  'work'         // עבודה               — 💼 נייבי
  'meeting'      // פגישה               — 🤝 כחול בהיר
  'call'         // שיחת טלפון          — 📞 ירוק
  'doctor'       // תור לרופא           — ⚕️ אדום בהיר
  'gym'          // אימון               — 💪 כתום חם
  'aspiration'   // שאיפות              — ⭐ זהב
  'leisure'      // פנאי                — 🎮 ורוד
  'general'      // כללי                — 📌 אפור
  'zoom'         // זום                 — 💻 כחול זום
  'hobby_class'  // חוגים               — 🎨 טורקיז
```

---

## 3. ניווט — ללא בר תחתון

### עקרון הניווט
המסך הראשי (HomeScreen) הוא הבסיס.
כל שאר המסכים נפתחים כ-modal / popup עם כפתור חזרה.
מעבר בין מסכים ראשיים: swipe ימינה/שמאלה.

### מבנה הניווט
```
HomeScreen (מסך בסיס)
    ↕ swipe שמאל      → ScheduleScreen (לו"ז יומי)
    ↕ swipe שמאל x2   → GoalsScreen (יעדים)
    ↕ swipe שמאל x3   → StatsScreen (סטטיסטיקה)
    
    ↑ tap כפתור מיקרופון → AddTaskModal (popup)
    ↑ tap (+)           → AddTaskManualModal (popup)
    ↑ tap על כרטיסייה  → TaskDetailModal (popup עם back)
    ↑ לומי מזהה חור    → GapSuggestionModal (popup)
    ↑ 10 דקות אחרי משימה → TimeVerificationPopup
    ↑ אין משימות       → EmptyDaySuggestionModal
```

### אינדיקטור swipe
נקודות קטנות בצד ימין של המסך (כמו page indicator אנכי)
מראות באיזה מסך נמצאים.

---

## 4. מבנה HomeScreen

```
┌─────────────────────────────────┐
│  ☀️ בוקר טוב, [שם]!    [avatar] │  ← header + לומי avatar (סגול)
│  ⭐ 340 נקודות · רמה 3 · 🔥 5  │  ← gamification bar
│  ████████░░ 6/10 משימות היום    │  ← progress bar צהוב
├─────────────────────────────────┤
│  🎯 MUST DO                      │
│  [כרטיסיית משימה]               │
│  [כרטיסיית משימה]               │
├─────────────────────────────────┤
│  📋 HAVE TO                      │
│  [כרטיסיית משימה]               │
├─────────────────────────────────┤
│  💡 הצעת לומי לחור בלו"ז        │  ← כרטיס הצעה סגול/צהוב
│  "קרא פרק בספר — 20 דקות 📚"   │
│  [✓ הוסף]  [✗ לא עכשיו]        │
├─────────────────────────────────┤
│         🎤          +            │  ← מיקרופון גדול צהוב + כפתור +
└─────────────────────────────────┘
```

---

## 5. כלים לסוכן — רשימה סופית (11 כלים)

```typescript
const LUMI_TOOLS = [

  // 1. קטגוריזציה וניתוח
  {
    name: "categorize_task",
    description: "נתח משימה — קטגוריה, עדיפות, משך זמן, האם קבועה עם אחרים",
    input: { task_text, context? }
    output: { category, priority, durationMinutes, isFixed, confidence }
  },

  // 2. פיצול למשימות משנה
  {
    name: "split_into_subtasks", 
    description: "פצל משימה מורכבת לצעדים מסודרים עם זמן לכל אחד",
    input: { task_text, already_done?, context? }
    output: { subtasks: [{text, durationMinutes, order}] }
  },

  // 3. זמן נסיעה (עם פירוט תחבורה ציבורית)
  {
    name: "get_transit_plan",
    description: "חשב תוכנית נסיעה מהבית ליעד כולל הליכה לתחנה, אוטובוס, זמן הגעה",
    input: { destination_address, arrival_deadline_HHmm, date, transport_type }
    output: { TransitPlan } // ראה טיפוס מלא בסעיף 6
  },

  // 4. חישוב זמן קימה
  {
    name: "calculate_wake_time",
    description: "חשב מתי צריך לקום ומתי לצאת מהבית",
    input: { fixed_time, travel_minutes, routine_minutes, buffer_minutes }
    output: { wakeBy, leaveHomeBy }
  },

  // 5. חיפוש אנשי קשר
  {
    name: "search_contacts",
    description: "חפש איש קשר בטלפון לפי שם, כולל גרסאות עברית/אנגלית",
    input: { name_query }
    output: { matches: [{name, phone, email, contactId, score}] }
  },

  // 6. חיפוש Gmail
  {
    name: "search_gmail",
    description: "חפש מיילים קשורים למשימה",
    input: { keywords, date_range? }
    output: { threadId, subject, sender, snippet } | null
  },

  // 7. אירועי יומן Google
  {
    name: "get_calendar_events",
    description: "קבל אירועים מGoogle Calendar לתאריך מסוים",
    input: { date }
    output: { CalendarEvent[] }
  },

  // 8. בניית לו"ז
  {
    name: "build_schedule",
    description: "בנה לו"ז יומי מסודר — קודם קבועים, אחר כך גמישים לפי עדיפות",
    input: { tasks[], wake_constraint?, sleep_time, gaps? }
    output: { DailySchedule }
  },

  // 9. הצעות למילוי חורים (כלי חדש!)
  {
    name: "suggest_gap_filler",
    description: "זהה חורים בלו"ז ומלא אותם — קודם שואלת את המשתמש, אחר כך מציעה משאיפות",
    input: { 
      schedule: DailySchedule,
      gap_start: string,      // HH:MM
      gap_end: string,        // HH:MM  
      user_goals: Goal[],     // יעדים ושאיפות מהפרופיל
      energy_level?: 'high' | 'medium' | 'low'
    }
    output: { 
      suggestion: Task,
      reason: string,         // "זה טוב לך עכשיו כי..."
      source: 'user_asked' | 'from_goals' | 'lumi_suggestion'
    }
  },

  // 10. ניהול יעדים
  {
    name: "manage_goal",
    description: "צור, עדכן או בדוק התקדמות ביעד",
    input: { 
      action: 'create' | 'update_progress' | 'check_status',
      goal?: Goal,
      linked_task_id?: string
    }
    output: { goal: Goal, progress_percent: number, next_step?: string }
  },

  // 11. אימות זמן (כלי חדש!)
  {
    name: "verify_task_duration",
    description: "שלח פופ-אפ 10 דקות אחרי שעון המשימה אמור להיגמר לאמת כמה זמן לקח",
    input: { task_id, estimated_minutes, scheduled_end_time }
    output: { schedules_popup_at: string } // HH:MM
    // הפופ-אפ שואל: "כמה זמן לקח לך באמת?"
    // התשובה מועברת ל-LearningService
  }
]
```

---

## 6. טיפוסי נתונים חדשים/מעודכנים

### Goal (יעד)
```typescript
interface Goal {
  id: string
  text: string                    // "לרדת 5 קילו", "לסיים קורס AI"
  category: TaskCategory
  type: 'project' | 'aspiration' // project = כמה ימים, aspiration = חיים
  
  // ויזואל לפי סוג:
  // project → timeline (תאריך התחלה, תאריך יעד, אחוז השלמה)
  // aspiration → progress bar (כמה משימות בוצעו מתוך כמה)
  
  targetDate?: string             // YYYY-MM-DD (לפרויקטים)
  linkedTaskIds: string[]         // משימות שתורמות ליעד
  completedTasksCount: number
  totalTasksCount: number
  progressPercent: number
  status: 'active' | 'achieved' | 'paused'
  createdAt: number
  achievedAt?: number
}
```

### GapSuggestion (הצעה לחור בלו"ז)
```typescript
interface GapSuggestion {
  id: string
  taskToAdd: Partial<Task>
  reason: string                  // "לא היה לך זמן לעצמך היום"
  gapStart: string                // HH:MM
  gapEnd: string                  // HH:MM
  source: 'user_asked' | 'from_goals' | 'lumi_suggestion'
  status: 'pending' | 'accepted' | 'rejected'
}
```

### TimeVerification (אימות זמן)
```typescript
interface TimeVerification {
  taskId: string
  estimatedMinutes: number
  actualMinutes?: number          // ממלא אחרי שהמשתמש עונה
  popupScheduledAt: number        // timestamp
  answeredAt?: number
  accuracy?: number               // actual / estimated ratio
}
```

---

## 7. מסכים — מבנה סופי

### HomeScreen (מסך בסיס)
- Header: ברכה + avatar לומי סגול
- Gamification bar: נקודות + רמה + streak
- Progress bar: X/Y משימות
- רשימת משימות לפי עדיפות (כרטיסיות)
- כרטיס הצעת לומי לחורים (אם יש)
- כפתור מיקרופון צהוב גדול + כפתור (+) לצידו

### ScheduleScreen (swipe שמאל 1)
- באנר קימה: "⏰ קום בשעה 07:35"
- באנר יציאה: "🚪 צא בשעה 08:28 — אוטובוס 251 מ-ארלוזורוב"
- משימות מסודרות לפי עדיפות → זמן יציאה מהבית
- כרטיסיות עם: שעה + קטגוריה + משך + פירוט נסיעה אם יש

### GoalsScreen (swipe שמאל 2)
- יעדי פרויקט: timeline עם תאריך התחלה/סיום + אחוז
- שאיפות: progress bar + מספר משימות שבוצעו
- כפתור: "הוסף יעד" עם מיקרופון

### StatsScreen (swipe שמאל 3)
- רמה + נקודות + streak
- גרף שבועי
- פירוט לפי קטגוריות
- הצלחות לאחרונה

### Modals (popups עם back)
- AddTaskModal: מיקרופון → שאלות ממוקדות
- TaskDetailModal: פרטי משימה + עריכה
- GapSuggestionModal: הצעת לומי עם הסבר
- TimeVerificationPopup: "כמה זמן לקח באמת?"
- MapPinConfirmModal: אישור מיקום על מפה
- CheckInModal: morning/afternoon/evening

---

## 8. זרימת הוספת משימה (UX סופי)

```
משתמש לוחץ על 🎤
        ↓
מיקרופון מתחיל מיד — לומי שותקת
        ↓
משתמש מדבר על משימה
        ↓
ReAct agent רץ — מזהה מה חסר
        ↓
לומי שואלת רק מה שהכי חסר (1 שאלה בכל פעם):
  ❓ "כמה זמן לדעתך?"  → כפתורים: 15 / 30 / 60 / 120 / תחשבי את
  ❓ מפה: "זה המקום?" → [כן] [חפשי שוב]
  ❓ "מתי הדדליין?"   → date picker
  ❓ "כבר התחלת?"     → [לא] [כן, חלקית]
        ↓
מתחת לשאלה: "אפשר גם להוסיף: 📍 מיקום | 👤 איש קשר | 📅 דדליין"
(המשתמש יכול ללחוץ להוסיף בנוסף)
        ↓
[שמור משימה] → +5 נקודות
```

---

## 9. זרימת אימות זמן

```
משימה "ריצה" — הוערכה: 45 דקות
scheduledEnd = 09:45
        ↓
10 דקות אחרי = 09:55: popup קצר
"🏃 סיימת את הריצה?"
[כן, לקח ~45 דקות] [לקח פחות ▾] [לקח יותר ▾]
        ↓
אם "לקח פחות/יותר": slider בחירת דקות
        ↓
LearningService.recordTaskCompletion()
        ↓
לומי: "תודה! עכשיו אני יודעת שריצה לוקחת לך 35 דקות 💪"
```

---

## 10. suggest_gap_filler — לוגיקה מלאה

```
לומי מזהה חור בלו"ז: 14:00–15:30
        ↓
שלב 1: שואלת את המשתמש
  "יש לך שעה וחצי פנויה. מה תרצה לעשות?"
  [מיקרופון] [+ הוסף ידנית]
        ↓
אם אין תשובה תוך 30 שניות:
שלב 2: בודקת רשימת שאיפות המשתמש
  → יש יעד: "לקרוא ספר"? מציעה: 📚 "קרא פרק — 30 דקות"
  → יש יעד: "להתקשר לאמא"? מציעה: 📞 "התקשר לאמא — 15 דקות"
        ↓
כרטיס הצעה על המסך:
┌────────────────────────────────┐
│ 💡 לומי מציעה                  │
│ 📚 קרא פרק בספר               │
│ "לא קראת כבר 3 ימים,          │
│  זה זמן טוב לנשום ולהתרכז"    │
│ [✓ הוסף ללו"ז] [✗ לא עכשיו]  │
└────────────────────────────────┘
```

---

## 11. נקודות ורמות — טבלה סופית

| פעולה | נקודות |
|-------|--------|
| משימה הושלמה | +10 |
| הושלמה בזמן | +20 |
| הגעה בזמן (GPS מאמת) | +25 |
| יום מושלם (הכל בוצע) | +50 |
| streak יומי | +15 × מכפיל |
| משימה עם פרטים מלאים | +5 |
| יעד הושג | +100 |
| אימות זמן מדויק (<10% סטייה) | +10 |

| רמה | נקודות | תואר |
|-----|--------|------|
| 1 | 0 | מתחיל 🌱 |
| 2 | 100 | בדרך 🚀 |
| 3 | 300 | בתנופה 🔥 |
| 4 | 600 | מאסטר זמן ⚡ |
| 5 | 1000 | אלוף לומי 👑 |

---

## 12. שאלות פתוחות אחרונות לפני קוד

1. **Qwen model** — צריך לאמת: האם qwen3-235B-A22B תומך ב-tool_use?
   בדוק ב: https://dashscope.aliyuncs.com
   אם לא — נשתמש ב-qwen-plus שתומך בוודאות.

2. **Moovit API** — צריך לבקש מפתח ב: https://moovit.com/maas
   בלי זה: Google Maps בלבד (עדיין עובד).

3. **Google Cloud Console** — צריך:
   - Directions API ✓
   - Places API ✓  
   - Gmail API ✓
   - Calendar API ✓
   - לאפשר Billing (חינמי עד מכסה מסוימת)

4. **Hebrew STT** — לבדוק בEAS build הראשון.

