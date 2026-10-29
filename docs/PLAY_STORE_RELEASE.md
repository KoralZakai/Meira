# מאירה ב-Google Play — שלב אחר שלב

עודכן: 7.10.2026. כל שלב מסומן מי עושה אותו: **את** או **Claude**.

---

## איפה אנחנו היום

- ✅ **אתר:** https://meirasecretary.github.io (עברית; אנגלית ב-`/en/`)
- ✅ **הורדת בטא (APK):** כפתור באתר. גרסה חדשה: `npm run android:local && npm run apk:publish`
- ✅ **רשימת בודקים:** הטופס באתר שומר לטבלה `waitlist` ב-Supabase (Table Editor ← waitlist). מבחוץ אפשר רק להוסיף, לא לקרוא.
- ✅ **מדיניות פרטיות:** https://meirasecretary.github.io/privacy.html
- ✅ **מחיקת חשבון:** באפליקציה (👤 ← Delete my account) + https://meirasecretary.github.io/delete-account.html
- ✅ **האפליקציה מוכנה טכנית:** גרסת Release, ‏targetSdk 36, ‏Expo 56 (תואם דרישת ה-16KB), השם בטלפון Meira, בלי מיקום ברקע, בלי שירות רקע מיותר, בלי גיבוי ל-Google Drive.
- ✅ **כניסה עם Google** פתוחה לכל אחד (עד 100 משתמשים, ראו "כניסה עם Google" למטה).

## הסדר והזמנים

```
חברים מנסים APK מהאתר (עכשיו)
   ↓
חשבון מפתחת ב-Play (1–3 ימים לאישור)
   ↓
בדיקה סגורה ב-Play: 12 בודקים × 14 יום רצופים
   ↓
בקשת הפצה לכולם (בדיקה של עד ~7 ימים)
   ↓
באוויר בחנות
```

**כ-3–4 שבועות מהיום**, אם מגייסים 12 בודקים מהר.

> ⚠️ **מי שהתקין APK מהאתר לא נספר.** Google סופרת רק בודקים שהצטרפו לבדיקה הסגורה והתקינו מ-Play. לכן: לפתוח את חשבון ה-Play כבר היום, ולהעביר את החברים לגרסת Play ברגע שהיא מוכנה.

---

## שלב 1 — חשבון מפתחת (את, ~20 דק׳ + המתנה)

1. https://play.google.com/console/signup ← **Personal** (חשבון אישי).
2. תשלום חד-פעמי: **25$**.
3. אימות זהות: תעודה מזהה וכתובת. אימות מייל וטלפון בקוד.
4. אימות מכשיר: להתקין את אפליקציית **Google Play Console** בטלפון אנדרואיד ולהיכנס איתה (חובה לחשבונות חדשים).
5. לחכות לאישור.

💡 בחנות יופיע **מייל המפתחת** לציבור (בחשבון אישי בלי הכנסות: רק המייל). אם לא רוצה את המייל הפרטי, לפתוח מייל ייעודי לפני ההרשמה ולהגיד לי, ואחליף אותו גם באתר.

## שלב 2 — יצירת האפליקציה (את, 10 דק׳)

Play Console ← **Create app**:
- שם: **Meira**
- שפת ברירת מחדל: **עברית**
- **App** (לא Game), ‏**Free**
- לאשר את ההצהרות

## שלב 3 — טפסי "App content" (את, ~45 דק׳)

Policy ← App content. מה לענות:

| טופס | תשובה |
|---|---|
| Privacy policy | `https://meirasecretary.github.io/privacy.html` |
| App access | "All or some functionality is restricted". לתת לבודקי Google חשבון Google ייעודי לבדיקה (לפתוח Gmail חדש לזה) + הוראה: *Sign in with Google → Advanced → continue* |
| Ads | **No** |
| Content rating | השאלון: קטגוריה Productivity / Utility, "לא" לכל השאלות ← Everyone |
| Target audience | **18+** בלבד (לא ילדים) |
| News app | No |
| Government app | No |
| Financial features | None |
| Health apps | No |
| Data safety | הטבלה למטה |
| Account deletion | `https://meirasecretary.github.io/delete-account.html` |
| Exact alarms | לא אמור להישאל: `USE_EXACT_ALARM` הוסרה ב-19.10 (מותרת רק לאפליקציות שעון מעורר). השעון המעורר מכוון באפליקציית השעון, ו-`SCHEDULE_EXACT_ALARM` לא דורשת טופס |
| Foreground service permissions | Special use (סשני לימוד). הטקסטים והסרטון: `docs/PLAY_DECLARATIONS.md` |

### Data safety — התשובות

- Does your app collect or share user data? **Yes**
- Encrypted in transit? **Yes**
- Can users request deletion? **Yes** (באפליקציה + הקישור למעלה)
- **Shared with third parties: No.** ספקים שמעבדים בשבילנו (Supabase, ‏Nebius, ‏Groq, ‏Google Maps) לא נחשבים "שיתוף" לפי ההגדרה של Google.

| סוג (ב-Play) | נאסף? | חובה/אופציונלי | מטרה | הערה |
|---|---|---|---|---|
| Location ← Precise location | כן | אופציונלי | App functionality | רק כשהאפליקציה בשימוש |
| Personal info ← Name | כן | חובה | App functionality, Account management | |
| Personal info ← Email address | כן | חובה | App functionality, Account management | |
| Personal info ← Address | כן | אופציונלי | App functionality | כתובת הבית |
| Personal info ← Phone number | כן | אופציונלי | App functionality | רק בחיבור וואטסאפ |
| Messages ← Other in-app messages | כן | אופציונלי | App functionality | הצ׳אט עם מאירה |
| Calendar ← Calendar events | כן | אופציונלי | App functionality | |
| Contacts ← Contacts | כן | אופציונלי | App functionality | רק איש קשר שצורף למשימה |
| Audio ← Voice or sound recordings | כן | אופציונלי | App functionality | ✔ Processed ephemerally |
| App activity ← Other user-generated content | כן | חובה | App functionality | משימות, הערות, שגרות |
| Device or other IDs | כן | חובה | App functionality | מזהה התראות |

סשני לימוד (Usage access, overlay) לא מוסיפים שורה: המידע לא יוצא מהטלפון. ההסבר ב-`docs/PLAY_DECLARATIONS.md`, סעיף 4.

## שלב 4 — דף האפליקציה בחנות (את; Claude יכול לנסח ולהכין גרפיקה)

Grow ← Store presence ← Main store listing:
- **שם** (עד 30 תווים): `Meira – מזכירה אישית`
- **תיאור קצר** (עד 80): `מחשבת אחורה מהיומן: מתי לקום, מתי לצאת ובאיזו דרך, ומזכירה בזמן.`
- **תיאור מלא:** אפשר לקחת מהאתר. רוצה, אנסח.
- **אייקון** 512×512, ‏**Feature graphic** 1024×500, ‏**לפחות 4 צילומי מסך** של טלפון. אני יכול להכין.
- קטגוריה: **Productivity**. אתר: `https://meirasecretary.github.io`

## שלב 5 — בנייה והעלאה לבדיקה סגורה

1. **Claude:** בונה AAB לחנות: `npm run android:store` (פרופיל production).
2. **את:** Testing ← Closed testing ← Create track ← מעלים את ה-AAB. **ההעלאה הראשונה חייבת להיות ידנית** דרך האתר.
3. **App signing:** להשאיר את ברירת המחדל: Google מייצרת ושומרת את מפתח החתימה.
4. **Testers:** הכי קל עם **Google Group**: groups.google.com ← קבוצה חדשה (למשל meira-beta) ← לבחור אותה כרשימת הבודקים. כל מי שמצטרף לקבוצה הופך לבודק.
5. Countries: **Israel**.
6. **Send for review.** אחרי האישור יופיע **קישור הצטרפות (opt-in link)**.

## שלב 6 — ⚠️ חובה מיד אחרי ההעלאה הראשונה

Google חותמת על גרסת Play במפתח משלה, ולמפתח המפה מותר לעבוד רק עם החתימה הישנה. **בלי הצעד הזה, המפה בגרסת Play שחורה.**

1. Play Console ← Setup ← **App signing** ← להעתיק את ה-**SHA-1** של App signing key.
2. Google Cloud (פרויקט **alarm clock**) ← Credentials ← המפתח **"API key"** (של הטלפון) ← Android apps ← **Add**: ‏`meira.secretary` + ה-SHA-1 החדש. **לא למחוק את `com.lumi.app`.** ה-APK הישן מהאתר עדיין צריך אותו.
3. לבדוק בגרסת Play: מפה, מסלול, כניסה עם Google. משהו נכשל? להגיד לי.

## שלב 7 — 12 בודקים × 14 יום

- לשלוח לחברים: (1) קישור לקבוצה, (2) ה-opt-in link, (3) להתקין מ-Play.
- **מי שהתקין APK מהאתר:** קודם למחוק אותו (חתימה אחרת), ואז להתקין מ-Play.
- **לגייס 15–20**, כי חלק נושרים. צריך **12 לפחות, 14 ימים רצופים**.
- לבקש מהבודקים פידבק קצר: שואלים על זה בבקשת ההפצה.
- המיילים מהאתר: Supabase ← Table Editor ← **waitlist**. להזמין אותם לקבוצה.

## שלב 8 — הפצה לכולם

1. Dashboard ← **Apply for production**: שלושה חלקים של שאלות (על הבדיקה הסגורה, על האפליקציה, על המוכנות).
2. בדיקה של עד כ-7 ימים.
3. אחרי האישור: Production ← Create release ← ה-AAB ← **Rollout**.
4. להגיד לי, ואחליף באתר את כפתור ההורדה בכפתור Google Play.

---

## כניסה עם Google: לפני שעוברים 100 משתמשים

- **היום:** מסך "Google לא אימתה את האפליקציה", ומקסימום **100 משתמשים לכל החיים** לפני אימות.
- **יומן (Calendar)** היא הרשאה "רגישה": אימות **חינמי** (סרטון הדגמה, דומיין מאומת, מדיניות פרטיות). לוקח ימים עד שבועות.
- **Gmail** היא הרשאה "מוגבלת": דורשת **בדיקת אבטחה בתשלום (CASA) כל 12 חודשים** אצל חברה שמאושרת על ידי Google.
- **בוצע 19.10:** גרסת החנות בלי Gmail, רק יומן, ולכן האימות חינמי. Gmail יחזור כשיש מספיק משתמשים שמצדיקים את העלות. המתג: `GMAIL_ENABLED` ב-`src/utils/gmailAccess.ts`, ואז מחזירים את שורת Emails ב-Data safety ואת השורות במדיניות הפרטיות.
- לאימות כדאי **דומיין משלך** (למשל getmeira.app או meira.co.il, בערך 15$ לשנה). את קונה, אני מחבר לאתר.

## אבטחה: מה נשאר (בקונסולות שלך)

1. **EAS** ← Environment variables ← preview: למחוק סודות שרת שלא צריכים להיות שם (ANTHROPIC_API_KEY, ‏DATABASE_URL, ‏HF_TOKEN, ‏LANGSMITH_API_KEY, ‏WHATSAPP_*). הם כבר ב-Fly. ההחלטה שלך (CLAUDE.md).
2. **Supabase** ← Advisors ← **Security Advisor**: לתקן כל שגיאה, בעיקר טבלה בלי RLS.
3. **Google Cloud** ← Quotas: מכסה יומית ל-Directions, ‏Places ו-Geocoding בשני המפתחות. ‏Billing ← **Budget alert**.
4. **מפתח השרת** (lumi-server): להסיר ממנו את "Maps SDK for Android". זה תפקיד הטלפון.
5. **מסך ההסכמה של Google:** לשנות את השם מ-**Lumi** ל-**Meira** ולעדכן את הכתובות לאתר החדש. אני יכול לעשות את זה ב-Chrome.

## פרסומות: ההמלצה היא לא עכשיו

- **כסף:** עם מעט משתמשים ההכנסה מפרסומות זניחה, והעלויות היום קטנות ומכוסות בקרדיטים ובמכסות החינמיות.
- **עבודה:** פרסומות מוסיפות תווית "Contains ads", מזהה פרסום בטופס Data safety, חלון הסכמה למשתמשים מאירופה, חשבון AdMob וקובץ app-ads.txt באתר.
- **פרטיות שלך:** אפליקציה שמרוויחה כסף עלולה לחייב הצגה ציבורית של הכתובת והטלפון שלך בחנות (באירופה).
- **אמון:** פרסומת ליד "צאו עכשיו" פוגעת ברגע הכי חשוב של מאירה.
- **אם בכל זאת:** באנר אחד, רק במסך פחות קריטי (תפריט או סטטיסטיקה), ורק אחרי האישור בחנות. ‏app-ads.txt כבר אפשרי: ‏`meirasecretary.github.io/app-ads.txt`.

## פקודות

| פקודה | מה היא עושה |
|---|---|
| `npm run android:local` | בונה APK במחשב (~10 דק׳) |
| `npm run apk:publish` | מעלה את ה-APK לכפתור ההורדה באתר |
| `npm run site:publish` | מפרסם את `site/` לאתר (אחרי commit) |
| `npm run android:store` | בונה AAB לחנות (ענן EAS) |
