package expo.modules.focusguard

/**
 * Every string the NATIVE side shows — the block screen and the notifications that must
 * work while the app's JS is not running. Hebrew and English, always both (the app's
 * language is passed in with the session; Meira speaks in 1-2 short sentences).
 *
 * The app's own sheets (permission steps, chooser, the lecture sheet) are drawn by JS
 * and live in src/utils/focusSession.ts + src/utils/focusBypass.ts. Keep the wording of
 * the lecture in step with src/utils/focusBypass.ts.
 */
internal object FocusText {
  private fun he(lang: String) = lang == "he"

  // ── The running session ───────────────────────────────────────────────────
  fun ongoingTitle(lang: String, minLeft: Long) =
    if (he(lang)) "📚 לומדים · עוד $minLeft דק׳" else "📚 Studying · $minLeft min left"

  fun endEarly(lang: String) = if (he(lang)) "סיום מוקדם" else "End early"

  fun defaultSessionTitle(lang: String) = if (he(lang)) "זמן למידה" else "Learning time"

  // ── The block screen ──────────────────────────────────────────────────────
  fun blockHeadline(lang: String) = if (he(lang)) "📚 את לומדת" else "📚 You're learning"

  fun blockedLine(lang: String, app: String, minLeft: Long) =
    if (he(lang)) "$app חסומה · עוד $minLeft דק׳" else "$app is blocked · $minLeft min left"

  fun learningLine(lang: String, minLeft: Long) =
    if (he(lang)) "מצב למידה · עוד $minLeft דק׳" else "Learning mode · $minLeft min left"

  fun backToLearning(lang: String) = if (he(lang)) "חזרה ללמידה" else "Back to learning"

  fun countingDown(lang: String, seconds: Int) =
    if (he(lang)) "אפשר לסיים בעוד $seconds…" else "You can end in $seconds…"

  fun endNow(lang: String) = if (he(lang)) "סיום מוקדם — לאשר" else "End now"

  // ── Notifications ─────────────────────────────────────────────────────────
  fun startedTitle(lang: String) = if (he(lang)) "📚 מתחילים ללמוד" else "📚 Study time"

  fun tapToStart(lang: String) =
    if (he(lang)) "לא הצלחתי להתחיל לבד. הקישי כדי להתחיל את החסימה." else "Couldn't start on my own. Tap to start blocking."

  fun lectureTitle(lang: String) =
    if (he(lang)) "📚 אמרת שאת לומדת!!" else "📚 You said you were studying!!"

  fun permissionLost(lang: String) =
    if (he(lang)) "כיבית את החסימה" else "You turned the block off"

  fun fixAction(lang: String) = if (he(lang)) "חזרה ללמידה" else "Back to studying"

  fun blockFailedTitle(lang: String) =
    if (he(lang)) "📚 החסימה לא עובדת" else "📚 The block isn't working"

  fun blockFailedBody(lang: String) =
    if (he(lang)) "לא מצליחה לחסום — לאפשר ׳הצגה מעל אפליקציות אחרות׳." else "Can't block — allow 'display over other apps'."

  fun doneTitle(lang: String) = if (he(lang)) "✓ סיימת ללמוד" else "✓ Study session done"

  fun doneBody(lang: String) = if (he(lang)) "האפליקציות פתוחות שוב." else "Your apps are open again."

  fun slipBody(lang: String, minutes: Long, app: String) =
    if (he(lang)) "$minutes דק׳ ב-$app" else "$minutes min on $app"
}
