package expo.modules.focusguard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Notifications of a learning session. Two channels:
 *
 *   focus_session  low importance, silent — the ongoing "📚 Studying · 23 min left" the foreground
 *                  service must show.
 *   focus_alert    high importance — "📚 Study time" at the start, and the lecture ("You said you
 *                  were studying!!") when something bypasses the block.
 *
 * All strings come from [FocusText], in the app's language (carried by the session).
 */
internal object FocusNotify {
  const val CH_SESSION = "focus_session"
  const val CH_ALERT = "focus_alert"
  const val ID_ONGOING = 4201
  const val ID_ALERT = 4202
  const val ID_END = 4203

  private const val GOLD = 0xFFF1C24E.toInt()

  fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CH_SESSION) == null) {
      val ch = NotificationChannel(CH_SESSION, "Learning session", NotificationManager.IMPORTANCE_LOW)
      ch.description = "Shown while a learning session is blocking apps"
      ch.setShowBadge(false)
      nm.createNotificationChannel(ch)
    }
    if (nm.getNotificationChannel(CH_ALERT) == null) {
      val ch = NotificationChannel(CH_ALERT, "Learning reminders", NotificationManager.IMPORTANCE_HIGH)
      ch.description = "A study session started, or the block was bypassed"
      nm.createNotificationChannel(ch)
    }
  }

  private fun flags() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /** Opens Meira's main screen. */
  fun openApp(ctx: Context): PendingIntent? {
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    return PendingIntent.getActivity(ctx, 10, launch, flags())
  }

  /** The block screen, opened from a notification action — where "End early" lives. */
  fun blockScreen(ctx: Context): PendingIntent {
    val i = Intent(ctx, FocusBlockActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      .putExtra(FocusBlockActivity.EXTRA_FROM_NOTIFICATION, true)
    return PendingIntent.getActivity(ctx, 11, i, flags())
  }

  /** A Settings page for one permission, as a notification action. */
  fun settingsPage(ctx: Context, which: String): PendingIntent =
    PendingIntent.getActivity(ctx, if (which == "usage") 12 else 13, FocusPerms.settingsIntent(ctx, which), flags())

  private fun base(ctx: Context, channel: String): NotificationCompat.Builder =
    NotificationCompat.Builder(ctx, channel)
      .setSmallIcon(R.drawable.ic_focus_notification)
      .setColor(GOLD)
      .setContentIntent(openApp(ctx))

  /** The foreground service's ongoing notification. [warn] swaps the text for the lecture line. */
  fun ongoing(ctx: Context, s: Session, minLeft: Long, warn: String?): Notification {
    ensureChannels(ctx)
    val b = base(ctx, CH_SESSION)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    if (warn == null) {
      b.setContentTitle(FocusText.ongoingTitle(s.lang, minLeft))
        .setContentText(s.title.ifBlank { FocusText.defaultSessionTitle(s.lang) })
    } else {
      b.setContentTitle(FocusText.lectureTitle(s.lang))
        .setContentText(
          if (warn == "block_failed") FocusText.blockFailedBody(s.lang) else FocusText.permissionLost(s.lang),
        )
      if (warn == "usage" || warn == "overlay") {
        b.addAction(0, FocusText.fixAction(s.lang), settingsPage(ctx, warn))
      }
    }
    b.addAction(0, FocusText.endEarly(s.lang), blockScreen(ctx))
    return b.build()
  }

  fun notify(ctx: Context, id: Int, n: Notification) {
    try {
      (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(id, n)
    } catch (e: Exception) {
      // POST_NOTIFICATIONS revoked or the manager is gone; the session itself is unaffected.
      android.util.Log.w("FocusGuard", "notify($id) failed: ${e.javaClass.simpleName}")
    }
  }

  fun cancel(ctx: Context, id: Int) {
    try {
      (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id)
    } catch (e: Exception) {
      android.util.Log.w("FocusGuard", "cancel($id) failed: ${e.javaClass.simpleName}")
    }
  }

  /** A heads-up with one title and one line, optionally one action button. */
  fun alert(
    ctx: Context, id: Int, title: String, text: String,
    actionLabel: String? = null, action: PendingIntent? = null,
    tap: PendingIntent? = null,
  ) {
    ensureChannels(ctx)
    val b = base(ctx, CH_ALERT)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
    if (tap != null) b.setContentIntent(tap)
    if (actionLabel != null && action != null) b.addAction(0, actionLabel, action)
    notify(ctx, id, b.build())
  }

  /** "📚 Study time — I blocked Instagram, WhatsApp…" at the start of an auto-started session. */
  fun started(ctx: Context, title: String, body: String) = alert(ctx, ID_ALERT, title, body)

  /** The service could not be started from the alarm: say so, and offer the tap that starts it. */
  fun startFailed(ctx: Context, lang: String) =
    alert(ctx, ID_ALERT, FocusText.startedTitle(lang), FocusText.tapToStart(lang), tap = openApp(ctx))

  /** The end of a session: done, or — when a blocked app was used anyway — the lecture. */
  fun ended(ctx: Context, s: Session, slipMinutes: Long, slipApp: String?) {
    if (slipMinutes >= 1 && slipApp != null) {
      alert(ctx, ID_END, FocusText.lectureTitle(s.lang), FocusText.slipBody(s.lang, slipMinutes, slipApp))
    } else {
      alert(ctx, ID_END, FocusText.doneTitle(s.lang), FocusText.doneBody(s.lang))
    }
  }
}
