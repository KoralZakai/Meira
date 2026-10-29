package expo.modules.focusguard

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context

/**
 * Which app is in front, and how long each one was — both read from UsageStatsManager events.
 *
 * Event types are the platform's numeric values (ACTIVITY_RESUMED has been 1 since the
 * deprecated MOVE_TO_FOREGROUND), written out so this compiles the same on every API level.
 */
internal object FocusUsage {
  private const val EV_RESUMED = 1
  private const val EV_PAUSED = 2
  private const val EV_SCREEN_OFF = 16
  private const val EV_KEYGUARD_SHOWN = 17
  private const val EV_STOPPED = 23

  /** How far back the FIRST query looks, so an app already in front when we start is seen. */
  private const val LOOKBACK_MS = 3L * 60 * 60 * 1000

  /** Re-read this much of the last window each poll; replaying events is idempotent. */
  private const val OVERLAP_MS = 2_000L

  private fun manager(ctx: Context): UsageStatsManager? =
    ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager

  private fun queryOrNull(usm: UsageStatsManager, from: Long, to: Long): UsageEvents? =
    try {
      usm.queryEvents(from, to)
    } catch (e: SecurityException) {
      null
    }

  /** Follows the foreground package across polls. One instance per running service. */
  class Tracker {
    var current: String? = null
      private set
    private var cursor = 0L

    /** Reads the events since the last call and returns the package in front now (null: none/screen off). */
    fun update(ctx: Context, now: Long): String? {
      val usm = manager(ctx) ?: return current
      val from = if (cursor == 0L) now - LOOKBACK_MS else cursor - OVERLAP_MS
      // Null when usage access was withdrawn between the permission check and now; the
      // service reports that on its own tick, so here the last known answer stands.
      val events = queryOrNull(usm, from, now) ?: return current
      val e = UsageEvents.Event()
      while (events.hasNextEvent()) {
        events.getNextEvent(e)
        when (e.eventType) {
          EV_RESUMED -> current = e.packageName
          EV_PAUSED, EV_STOPPED -> if (current == e.packageName) current = null
          EV_SCREEN_OFF, EV_KEYGUARD_SHOWN -> current = null
        }
      }
      cursor = now
      return current
    }
  }

  /**
   * Foreground milliseconds per package inside [from, to].
   *
   * Seeded by reading LOOKBACK before [from], so an app that was already open when the window
   * began is counted from [from]. Only time inside the window is counted.
   */
  fun summary(ctx: Context, from: Long, to: Long): Map<String, Long> {
    val usm = manager(ctx) ?: return emptyMap()
    if (to <= from) return emptyMap()
    val events = queryOrNull(usm, from - LOOKBACK_MS, to) ?: return emptyMap()

    val acc = HashMap<String, Long>()
    var cur: String? = null
    var curStart = 0L

    fun close(at: Long) {
      val pkg = cur ?: return
      val s = maxOf(curStart, from)
      val e2 = minOf(at, to)
      if (e2 > s) acc[pkg] = (acc[pkg] ?: 0L) + (e2 - s)
      cur = null
    }

    val e = UsageEvents.Event()
    while (events.hasNextEvent()) {
      events.getNextEvent(e)
      when (e.eventType) {
        EV_RESUMED -> if (cur != e.packageName) {
          close(e.timeStamp)
          cur = e.packageName
          curStart = e.timeStamp
        }
        EV_PAUSED, EV_STOPPED -> if (cur == e.packageName) close(e.timeStamp)
        EV_SCREEN_OFF, EV_KEYGUARD_SHOWN -> close(e.timeStamp)
      }
    }
    close(to)
    return acc
  }
}
