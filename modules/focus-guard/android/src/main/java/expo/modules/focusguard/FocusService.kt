package expo.modules.focusguard

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * The learning session. A foreground service (type specialUse) that, until the session's end:
 *
 *   1. polls UsageStatsManager every ~700 ms for the app in front;
 *   2. when that app is in the blocked list, puts [FocusBlockActivity] on top of it;
 *   3. every tick checks the two permissions blocking depends on and reports a withdrawal as a
 *      bypass ("You said you were studying!!") instead of failing quietly;
 *   4. beats (writes a timestamp) so that, if the process is killed, the next run can tell the
 *      session was still inside its window with nothing running it.
 *
 * The session lives in SharedPreferences, so START_STICKY restarts resume it until endsAt.
 * Meira's own package and the phone dialer / emergency screens are never blocked — they are not
 * in the list JS sends, and [NEVER_BLOCK] drops them even if they were.
 */
class FocusService : Service() {
  companion object {
    @Volatile
    var running = false
      private set

    const val ACTION_START = "expo.modules.focusguard.action.START"
    const val ACTION_STOP = "expo.modules.focusguard.action.STOP"
    const val ACTION_END_EARLY = "expo.modules.focusguard.action.END_EARLY"

    private const val POLL_MS = 700L
    private const val RELAUNCH_MS = 2_500L
    private const val BEAT_EVERY_MS = 5_000L

    /** Longer than this since the last beat, and "the session was running" is no longer true. */
    internal const val DEAD_AFTER_MS = 20_000L

    /** Launches that left the blocked app in front before we call the block broken. */
    private const val MAX_FUTILE_LAUNCHES = 3

    /** Never blocked, whatever list arrives: the phone, emergency, system UI, settings, ourselves. */
    internal val NEVER_BLOCK = setOf(
      "com.android.dialer", "com.google.android.dialer", "com.samsung.android.dialer",
      "com.android.phone", "com.android.server.telecom", "com.android.emergency",
      "com.android.systemui", "com.android.settings", "com.google.android.apps.safetyhub",
      "com.android.incallui", "com.samsung.android.incallui",
    )

    /**
     * Start (or replace) the foreground service for [session]. Returns null on success, else a
     * typed reason — the caller records it; a start that fails must be visible (rule 3).
     */
    internal fun begin(ctx: Context, session: Session, resume: Boolean = false): String? {
      val app = ctx.applicationContext
      val cur = FocusStore.loadSession(app)
      if (!resume && running && cur != null && cur.endsAtMs >= session.endsAtMs) {
        // Something that covers this window is already running; do not shorten it.
        return null
      }
      FocusStore.saveSession(app, session)
      FocusNotify.ensureChannels(app)
      return try {
        ContextCompat.startForegroundService(app, Intent(app, FocusService::class.java).setAction(ACTION_START))
        null
      } catch (e: Exception) {
        // Android 12+: ForegroundServiceStartNotAllowedException when the app is not allowed to
        // start a foreground service right now. Typed, so JS can say why.
        android.util.Log.w("FocusGuard", "startForegroundService refused: ${e.javaClass.simpleName}: ${e.message}")
        "service_start_refused:${e.javaClass.simpleName}"
      }
    }

    /** Ask the running (or sticky-restarted) service to stop or to end early. */
    internal fun sendAction(ctx: Context, action: String): String? = try {
      ctx.applicationContext.startService(Intent(ctx.applicationContext, FocusService::class.java).setAction(action))
      null
    } catch (e: Exception) {
      android.util.Log.w("FocusGuard", "service action $action refused: ${e.javaClass.simpleName}")
      e.javaClass.simpleName
    }
  }

  private lateinit var thread: HandlerThread
  private lateinit var handler: Handler
  private val tracker = FocusUsage.Tracker()

  private var session: Session? = null
  private var lastMinLeft = -1L
  private var lastBeatWrite = 0L
  private var lastLaunch = 0L
  private var launchesForThisFront = 0
  private var lastBlockedPkg: String? = null
  private var usageReported = false
  private var overlayReported = false
  private var failureReported = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    thread = HandlerThread("meira-focus-guard").also { it.start() }
    handler = Handler(thread.looper)
  }

  override fun onDestroy() {
    running = false
    handler.removeCallbacksAndMessages(null)
    thread.quitSafely()
    super.onDestroy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val now = System.currentTimeMillis()
    val stored = FocusStore.loadSession(this)
    when (intent?.action) {
      ACTION_STOP -> {
        session = stored
        finish("stopped", now)
        return START_NOT_STICKY
      }
      ACTION_END_EARLY -> {
        session = stored
        finish("early", now)
        return START_NOT_STICKY
      }
    }

    // ACTION_START, or a sticky restart with a null intent. Either way startForeground must be
    // called at once (5 s rule), so do it before any decision that could end the service.
    val s = stored
    startForegroundCompat(s, now)
    if (s == null) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action != ACTION_START && now - FocusStore.lastBeat(this) > DEAD_AFTER_MS) {
      // The OS (or a force-stop) took the service away and has now brought it back: the block was
      // down in between. Report it; the session itself carries on.
      FocusIncidents.record(this, "killed", s, now) { it.put("minutesLeft", FocusIncidents.minutesLeft(s, now)) }
    }
    if (now >= s.endsAtMs) {
      session = s
      finish("completed", now)
      return START_NOT_STICKY
    }
    session = s
    FocusStore.beat(this, now)
    handler.removeCallbacksAndMessages(null)
    handler.post(tick)
    return START_STICKY
  }

  private fun startForegroundCompat(s: Session?, now: Long) {
    val minLeft = if (s == null) 0 else FocusIncidents.minutesLeft(s, now)
    val notification = FocusNotify.ongoing(this, s ?: placeholder(), minLeft, FocusStore.warn(this))
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(FocusNotify.ID_ONGOING, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(FocusNotify.ID_ONGOING, notification)
    }
  }

  private fun placeholder() = Session("none", "", "en", emptyList(), 0L, 0L, null)

  private val tick = object : Runnable {
    override fun run() {
      val s = session ?: return
      val now = System.currentTimeMillis()
      if (now >= s.endsAtMs) {
        finish("completed", now)
        return
      }
      try {
        val usageOk = FocusPerms.hasUsageAccess(this@FocusService)
        val overlayOk = FocusPerms.canDrawOverlays(this@FocusService)
        checkPermissions(s, now, usageOk, overlayOk)

        val interactive = (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
        if (usageOk && interactive) {
          val front = tracker.update(this@FocusService, now)
          maybeBlock(s, front, now)
        }
        refreshNotification(s, now)
        if (now - lastBeatWrite >= BEAT_EVERY_MS) {
          FocusStore.beat(this@FocusService, now)
          lastBeatWrite = now
        }
      } catch (e: Exception) {
        // One bad tick must not end the block: an uncaught throw here would take the app down.
        android.util.Log.w("FocusGuard", "tick failed: ${e.javaClass.simpleName}: ${e.message}")
      }
      handler.postDelayed(this, POLL_MS)
    }
  }

  /** A permission switched off mid-session is a bypass: say so, once per withdrawal. */
  private fun checkPermissions(s: Session, now: Long, usageOk: Boolean, overlayOk: Boolean) {
    if (!usageOk && !usageReported) {
      usageReported = true
      report(s, now, "usage")
    }
    if (!overlayOk && !overlayReported) {
      overlayReported = true
      report(s, now, "overlay")
    }
    if (usageOk && overlayOk && (usageReported || overlayReported)) {
      // Back on: the block resumes by itself on this very tick.
      usageReported = false
      overlayReported = false
      val w = FocusStore.warn(this)
      if (w == "usage" || w == "overlay") FocusStore.setWarn(this, null)
      FocusNotify.cancel(this, FocusNotify.ID_ALERT)
      lastMinLeft = -1
    }
  }

  private fun report(s: Session, now: Long, permission: String) {
    FocusIncidents.record(this, "permission_revoked", s, now) { it.put("permission", permission) }
    FocusStore.setWarn(this, permission)
    FocusNotify.alert(
      this, FocusNotify.ID_ALERT, FocusText.lectureTitle(s.lang), FocusText.permissionLost(s.lang),
      FocusText.fixAction(s.lang), FocusNotify.settingsPage(this, permission),
    )
    lastMinLeft = -1 // redraw the ongoing notification with the warning text
  }

  private fun maybeBlock(s: Session, front: String?, now: Long) {
    if (front == null || front !in s.blocked || front in NEVER_BLOCK || front == packageName) {
      lastBlockedPkg = null
      launchesForThisFront = 0
      return
    }
    if (front != lastBlockedPkg) {
      lastBlockedPkg = front
      launchesForThisFront = 0
    }
    if (now - lastLaunch < RELAUNCH_MS) return
    lastLaunch = now
    launchesForThisFront += 1
    launchBlockScreen(front)
    // When a launch takes, our own screen becomes the front app and the counter resets above.
    // Still the blocked app after MAX_FUTILE_LAUNCHES tries means the block cannot be shown.
    if (launchesForThisFront >= MAX_FUTILE_LAUNCHES && !failureReported) {
      failureReported = true
      FocusIncidents.record(this, "block_failed", s, now) { it.put("package", front) }
      FocusStore.setWarn(this, "block_failed")
      FocusNotify.alert(this, FocusNotify.ID_ALERT, FocusText.blockFailedTitle(s.lang), FocusText.blockFailedBody(s.lang))
      lastMinLeft = -1
    }
  }

  private fun launchBlockScreen(blockedPkg: String): Boolean = try {
    startActivity(
      Intent(this, FocusBlockActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NO_ANIMATION)
        .putExtra(FocusBlockActivity.EXTRA_BLOCKED_PACKAGE, blockedPkg),
    )
    true
  } catch (e: Exception) {
    // Background activity start refused (display-over-apps missing) — counted as futile above.
    android.util.Log.w("FocusGuard", "block screen not launched: ${e.javaClass.simpleName}: ${e.message}")
    false
  }

  private fun refreshNotification(s: Session, now: Long) {
    val minLeft = FocusIncidents.minutesLeft(s, now)
    if (minLeft == lastMinLeft) return
    lastMinLeft = minLeft
    FocusNotify.notify(this, FocusNotify.ID_ONGOING, FocusNotify.ongoing(this, s, minLeft, FocusStore.warn(this)))
  }

  private fun finish(reason: String, now: Long) {
    val s = session ?: FocusStore.loadSession(this)
    if (::handler.isInitialized) handler.removeCallbacksAndMessages(null)
    session = null
    if (s != null) {
      val out = FocusIncidents.complete(this, s, reason, now)
      FocusNotify.cancel(this, FocusNotify.ID_ALERT)
      // An early end or a stop is her own doing: no "done" banner. A finished session says so, and
      // when a blocked app was used anyway the banner is the lecture.
      if (reason == "completed") {
        val minutes = (out.blockedMs + 30_000L) / 60_000L
        val label = out.topPackage?.let { FocusIncidents.appLabel(this, it) }
        FocusNotify.ended(this, s, if (out.blockedMs > FocusIncidents.SLIP_MS) minutes else 0L, label)
      }
    }
    stopForeground(STOP_FOREGROUND_REMOVE)
    FocusNotify.cancel(this, FocusNotify.ID_ONGOING)
    stopSelf()
  }
}
