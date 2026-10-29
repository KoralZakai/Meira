# Play Console — הצהרות על סשני לימוד (focus-guard)

עודכן: 19.10.2026. משלים את `docs/PLAY_STORE_RELEASE.md` (שלב 3, App content).
הטקסטים להדבקה כתובים באנגלית, כי בודקי Play קוראים אנגלית. ההסברים בעברית.

**מה הפיצ׳ר עושה:** בזמן סשן לימוד שהיא קבעה, מאירה חוסמת את האפליקציות שהיא בחרה (וואטסאפ, אינסטגרם וכו׳). זה עובד עם שלוש יכולות של אנדרואיד:

| יכולת | בשביל מה | הצהרה ב-Play |
|---|---|---|
| Foreground service מסוג `specialUse` | הטיימר של הסשן רץ גם כשמאירה סגורה | **כן**: App content ← Foreground service permissions |
| Usage access (`PACKAGE_USAGE_STATS`) | לדעת איזו אפליקציה פתוחה על המסך | אין טופס. חובה גילוי נאות באפליקציה (קיים, ראו סעיף 3) |
| Display over other apps (`SYSTEM_ALERT_WINDOW`) | להציג את מסך "את בלמידה" מעל אפליקציה חסומה | אין טופס. אותו גילוי נאות |

foreground service אחר לא יופיע בבקשה. ל-expo-location יש שירות מסוג `location`, אבל ההרשאה `FOREGROUND_SERVICE_LOCATION` לא נכנסת ל-build, כי מיקום ברקע כבוי. גם `USE_EXACT_ALARM` הוסרה ב-19.10 (`app.json`, ו-`tests/run-release-config.ts` מוודא).

---

## 1. Foreground service — הטופס

Play Console ← Policy ← App content ← **Foreground service permissions** ← Start.

**Type:** Special use (`FOREGROUND_SERVICE_SPECIAL_USE`)

**Describe the feature that uses this permission** (להדבקה):

> Meira has an optional "learning session" (Menu › Helpers › Learning sessions). The user picks a study time and the apps she wants blocked during it, such as WhatsApp or Instagram. The session starts when she taps "Start learning", or at the time of a study task she put in her own schedule. While it runs, a foreground service with an ongoing notification ("Learning mode · N min left") checks which app is in front (Usage access) and, if it is one of the apps she chose, shows a full-screen "📚 You're learning" screen with a "Back to learning" button over it (Display over other apps). The service stops by itself when the session's time ends, or when she ends it early after a visible 10-second wait. The phone dialer, emergency calls, Settings and Meira itself are never blocked. Nothing the service sees leaves the device.

**Why a foreground service, and why no other type fits** (להדבקה):

> The block has to work while Meira is closed, for the whole session (25–90 minutes, chosen by the user), and react within a second when a blocked app comes to the front. WorkManager and alarms run at most every ~15 minutes and cannot watch the foreground app. None of the standard foreground service types (dataSync, mediaPlayback, location, health, etc.) describes a user-started study timer that blocks distracting apps, so the type is specialUse, with the subtype declared in the manifest (PROPERTY_SPECIAL_USE_FGS_SUBTYPE).

**User impact if the task is deferred or interrupted** (להדבקה):

> The session the user started fails silently: the apps she asked to have blocked open normally in the middle of her study time, which is the one thing the feature exists to prevent. Meira detects a killed service and tells her ("The block is not running — restarting it"), but a deferred start would leave her unprotected until then.

**Video link:** סרטון לא רשום (Unlisted) ביוטיוב, לפי התסריט בסעיף 2.

**ה-subtype ב-manifest** (`modules/focus-guard/android/src/main/AndroidManifest.xml`, כבר קיים):
`Learning-session app blocker: while the user's own study timer runs, it watches which app is in front (Usage access) and shows a 'you are learning' screen over social apps the user chose to block.`

---

## 2. סרטון הדגמה — 30 שניות

מקליטים מסך בטלפון (Quick Settings ← Screen record), בהתקנה נקייה, באנגלית (Menu ← שפה ← English). בלי קול; הכיתובים מוסיפים בעריכה. העלאה ליוטיוב כ-**Unlisted**.

| שנייה | על המסך | כיתוב |
|---|---|---|
| 0–4 | Menu ← Helpers ← **Learning sessions — blocked apps**. בוחרים WhatsApp ו-Instagram | "The user chooses which apps to block while studying" |
| 4–9 | מקישים **Allow ›** ← כרטיס **Before you allow** עם 4 השורות. מקישים **Got it, open Settings ›** | "Prominent disclosure before any special access" |
| 9–13 | Settings ← Usage access ← Meira ← ON. חוזרים. אותו דבר ל-Display over other apps | "Granted by the user in Android Settings" |
| 13–16 | בוחרים 25 min ← **Start learning**. מושכים את שורת ההתראות: ההתראה הקבועה "Learning mode · 25 min left" | "Foreground service: an ongoing, visible notification" |
| 16–21 | Home ← פותחים את Instagram ← מסך "You're learning" מופיע מעליו ← **Back to learning** | "A blocked app is covered while the session runs" |
| 21–24 | פותחים את החייגן: הוא נפתח רגיל | "The phone and emergency calls are never blocked" |
| 24–30 | חוזרים למאירה ← **End early (10 s)** ← הספירה ← **End now**. ההתראה נעלמת, ו-Instagram נפתח רגיל | "The service stops when the session ends" |

---

## 3. Usage access ו-overlay — הגילוי הנאות

אין עליהם טופס הצהרה ב-Play. מדיניות User Data דורשת **גילוי נאות באפליקציה, לפני הבקשה**, כשהגישה למידע לא צפויה מאליה. זה קיים מ-19.10:

- **מתי מוצג:** בהקשה הראשונה על **Allow ›**, לפני שנפתחות ההגדרות. הכרטיס תופס את כל הפאנל.
- **אכיפה:** `FocusSessionService.requestPermission` מסרב (`disclosure_needed`) עד ההקשה על "Got it", כך ששום מסך לא יכול לדלג עליו.
- **הקוד:** `src/components/FocusDisclosureCard.tsx`. הטקסט ב-`focusDisclosure` ב-`src/utils/focusSession.ts`.
- **הבדיקות:** `tests/run-focus-session.ts`, ו-B13 ב-`tests/run-focus-bypass.ts`.

הטקסט שמוצג (EN; יש גם עברית):

> **Before you allow**
> Usage access: Meira sees which app is on screen — only during a learning session.
> Display over other apps: that is how she puts the "You're learning" screen over the apps you chose to block.
> This stays on your phone. It is not sent to Meira's server or anyone else.
> You can turn both off any time in Android Settings.
> [Got it, open Settings ›] [Not now]

**נימוק ל-Usage access, אם Play שואלת** (להדבקה):

> Usage access is used only by the optional learning-session blocker, only while a session the user started is running, to know whether the app in front is one she chose to block. It is requested from a screen that first explains exactly this, and it is granted by the user in Android Settings. The result is never stored beyond an on-device count of how many times she got past a block, and it is never transmitted off the device.

אם Play דוחה את Usage access למרות זאת: אפשר לבקש את הגישה רק מתוך הפיצ׳ר, וזה כבר המצב. אין צורך להסיר אותה מה-build.

---

## 4. Data safety — מה משתנה בגלל focus-guard

**שום שורה לא נוספת.** לפי ההגדרה של Google, "collection" פירושו העברת מידע מהמכשיר החוצה. מידע שמעובד רק במכשיר לא מוצהר. ב-focus-guard:

| מה | איפה זה נשאר | מוצהר? |
|---|---|---|
| איזו אפליקציה פתוחה (בזמן סשן) | זיכרון השירות בטלפון | לא. לא יוצא מהטלפון |
| האם אפליקציות מרשימה קבועה של 10 מותקנות | נבדק בטלפון (`<queries>`, בלי `QUERY_ALL_PACKAGES`) | לא |
| מספר העקיפות בשבוע, האפליקציות שנבחרו | `EncryptedStorage` בטלפון | לא |

אומת בקוד: `FocusBypassService` ו-`FocusSessionService` לא קוראים לשרת או ל-Supabase. אף מנגנון סנכרון לא קורא את המפתחות `meira.focus.*`.

טבלת ה-Data safety ב-`docs/PLAY_STORE_RELEASE.md` נשארת כמו שהיא, בלי השורה **Messages ← Emails**. היא נמחקה ב-19.10, כי Gmail יצא מגרסת החנות (`GMAIL_ENABLED = false`).

מדיניות הפרטיות (`site/privacy.html`, עברית ואנגלית) מתארת את סשני הלימוד מ-19.10. **צריך `npm run site:publish`** לפני שליחה לבדיקה, כדי שהכתובת בטופס תציג את הגרסה החדשה.

---

## 5. מה עלייך ב-Play Console

1. `npm run site:publish`: מדיניות הפרטיות החדשה עולה לאוויר.
2. מקליטה את הסרטון לפי סעיף 2 ומעלה ליוטיוב כ-Unlisted.
3. App content ← **Foreground service permissions** ← Special use ← מדביקה את 3 הטקסטים מסעיף 1 ואת קישור הסרטון.
4. Data safety: בלי שורה ל-focus-guard (סעיף 4), ו**בלי Messages ← Emails** (Gmail יצא).
6. Google Cloud ← OAuth consent screen ← Data access: להסיר את `gmail.readonly` מרשימת ה-scopes, כדי שבקשת האימות תכלול רק Calendar.
5. אם מופיעה שאלה על exact alarm: האפליקציה כבר לא מבקשת `USE_EXACT_ALARM`, ו-`SCHEDULE_EXACT_ALARM` לא דורשת טופס.
