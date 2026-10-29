package expo.modules.focusguard

import android.content.Context
import android.content.pm.PackageManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bypasses the native side notices while JS may not be running, and the one place a session ends.
 *
 * Each incident is a small JSON object — {kind, atMs, session, ...} — that JS drains with
 * `drainIncidents()` and turns into the lecture. The kinds:
 *
 *   permission_revoked  usage access or display-over-apps was switched off mid-session
 *   block_failed        the block screen was launched and the app stayed in front anyway
 *   killed              the session was inside its window and nothing was running it
 *   ended_early         she ended it after the 10-second wait
 *   slipped             a blocked app had more than a minute of foreground time in the window
 */
internal object FocusIncidents {
  /** Foreground time in a blocked app beyond which the session counts as "slipped". */
  const val SLIP_MS = 60_000L

  /** Packages with less foreground time than this are not worth reporting to JS. */
  private const val REPORT_MIN_MS = 30_000L

  fun record(ctx: Context, kind: String, s: Session, now: Long = System.currentTimeMillis(), extra: (JSONObject) -> Unit = {}) {
    val o = JSONObject().put("kind", kind).put("atMs", now).put("session", s.toJson())
    extra(o)
    FocusStore.appendIncident(ctx, o)
  }

  fun minutesLeft(s: Session, now: Long): Long = maxOf(0L, (s.endsAtMs - now + 59_999L) / 60_000L)

  /** The label of an installed app, or its package name when it cannot be read. */
  fun appLabel(ctx: Context, pkg: String): String = try {
    val pm = ctx.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
  } catch (e: PackageManager.NameNotFoundException) {
    pkg
  } catch (e: Exception) {
    android.util.Log.w("FocusGuard", "label($pkg) failed: ${e.javaClass.simpleName}")
    pkg
  }

  class Outcome(val blockedMs: Long, val topPackage: String?)

  /**
   * Close a session: measure what happened to the blocked apps inside its window, write the
   * incidents and the "last session" record, and clear the running session.
   *
   * [reason]: completed | early | stopped | killed. Used by the service when it finishes, and by
   * `reconcile` when the window has passed with nothing running it.
   */
  fun complete(ctx: Context, s: Session, reason: String, now: Long): Outcome {
    val endedAt = maxOf(s.startedAtMs, minOf(now, s.endsAtMs))
    val measured = FocusPerms.hasUsageAccess(ctx)
    var blockedMs = 0L
    var topPkg: String? = null
    var topMs = 0L
    val usage = JSONArray()
    if (measured) {
      for ((pkg, ms) in FocusUsage.summary(ctx, s.startedAtMs, endedAt)) {
        if (ms >= REPORT_MIN_MS) usage.put(JSONObject().put("pkg", pkg).put("ms", ms))
        if (pkg in s.blocked) {
          blockedMs += ms
          if (ms > topMs) { topMs = ms; topPkg = pkg }
        }
      }
    } else {
      // Rule 1: "no slips" and "could not measure" must not look the same. JS reads this.
      android.util.Log.w("FocusGuard", "no usage access at the end of '${s.id}': slips not measured")
    }
    if (reason == "early") {
      record(ctx, "ended_early", s, now) { it.put("minutesLeft", minutesLeft(s, now)) }
    }
    if (blockedMs > SLIP_MS) {
      record(ctx, "slipped", s, now) { it.put("usage", usage).put("blockedMs", blockedMs) }
    }
    FocusStore.saveLast(ctx, s, reason, endedAt, blockedMs, measured)
    FocusStore.clearSession(ctx)
    return Outcome(blockedMs, topPkg)
  }
}
