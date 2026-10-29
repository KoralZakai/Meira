package expo.modules.focusguard

import android.content.Context
import android.content.pm.PackageManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/**
 * FocusGuard — the JS surface of the learning-session blocker.
 *
 * Every function returns a JSON string (or a primitive for the pure checks) and every failure
 * carries a typed `reason`: the JS wrapper (modules/focus-guard/index.ts) parses them into
 * {ok:false, reason} so a refused start is never a silent no-op (silent-state rule 3).
 *
 * Reasons: no_usage_access, no_overlay, bad_window, nothing_to_block, bad_entry, window_over,
 * service_start_refused:<Exception>, alarm_refused:<Exception>, settings_refused:<Exception>.
 */
class FocusGuardModule : Module() {
  private val context: Context
    get() = (appContext.reactContext ?: throw Exceptions.ReactContextLost()).applicationContext

  private fun fail(reason: String): String = JSONObject().put("ok", false).put("reason", reason).toString()

  private fun ok(): JSONObject = JSONObject().put("ok", true)

  /** Never block ourselves, the phone, emergency or system screens, whatever list arrives. */
  private fun sanitize(ctx: Context, blocked: List<String>): List<String> =
    blocked.map { it.trim() }
      .filter { it.isNotEmpty() && it != ctx.packageName && it !in FocusService.NEVER_BLOCK }
      .distinct()

  override fun definition() = ModuleDefinition {
    Name("FocusGuard")

    // ── Permissions ─────────────────────────────────────────────────────────
    Function("hasUsageAccess") { FocusPerms.hasUsageAccess(context) }
    Function("canDrawOverlays") { FocusPerms.canDrawOverlays(context) }
    Function("areNotificationsEnabled") { FocusPerms.notificationsEnabled(context) }

    Function("openUsageAccessSettings") {
      val err = FocusPerms.open(context, "usage")
      if (err == null) ok().toString() else fail("settings_refused:$err")
    }
    Function("openOverlaySettings") {
      val err = FocusPerms.open(context, "overlay")
      if (err == null) ok().toString() else fail("settings_refused:$err")
    }

    /** Which of these packages are installed (needs the manifest <queries> to see them). */
    Function("installedPackages") { packages: List<String> ->
      val pm = context.packageManager
      val found = JSONArray()
      for (p in packages) {
        try {
          pm.getPackageInfo(p, 0)
          found.put(p)
        } catch (e: PackageManager.NameNotFoundException) {
          // not installed: simply absent from the answer
        }
      }
      found.toString()
    }

    // ── A session right now ────────────────────────────────────────────────
    Function("startSession") { endsAtMs: Double, blocked: List<String>, title: String, lang: String, taskId: String?, sessionId: String? ->
      val ctx = context
      val now = System.currentTimeMillis()
      val endsAt = endsAtMs.toLong()
      val list = sanitize(ctx, blocked)
      when {
        endsAt <= now + 30_000L -> fail("bad_window")
        list.isEmpty() -> fail("nothing_to_block")
        // A block that cannot be shown is not a block (rule 3): refuse, and say which switch.
        !FocusPerms.hasUsageAccess(ctx) -> fail("no_usage_access")
        !FocusPerms.canDrawOverlays(ctx) -> fail("no_overlay")
        else -> {
          val id = sessionId?.takeIf { it.isNotBlank() } ?: "manual-$now"
          val session = Session(id, title, if (lang == "he") "he" else "en", list, now, endsAt, taskId)
          val err = FocusService.begin(ctx, session)
          if (err == null) ok().put("id", id).put("endsAtMs", endsAt).toString() else fail(err)
        }
      }
    }

    /** Stop without it counting as a bypass (the app is replacing or cancelling the session). */
    Function("stopSession") {
      FocusService.sendAction(context, FocusService.ACTION_STOP)?.let { fail("service_start_refused:$it") }
        ?: ok().toString()
    }

    /** End it early — after the 10-second wait, which the caller has shown. Counts as ended_early. */
    Function("endSessionEarly") {
      FocusService.sendAction(context, FocusService.ACTION_END_EARLY)?.let { fail("service_start_refused:$it") }
        ?: ok().toString()
    }

    Function("getSession") {
      val ctx = context
      val s = FocusStore.loadSession(ctx)
      val o = JSONObject()
      if (s == null || System.currentTimeMillis() >= s.endsAtMs) {
        o.put("active", false)
      } else {
        o.put("active", true)
          .put("session", s.toJson())
          .put("serviceRunning", FocusService.running)
          .put("lastBeatMs", FocusStore.lastBeat(ctx))
          .put("warn", FocusStore.warn(ctx) ?: JSONObject.NULL)
      }
      o.toString()
    }

    Function("lastSession") { FocusStore.lastJson(context) }

    // ── Sessions that start by themselves ──────────────────────────────────
    /** One JSON entry: {id, startAtMs, endsAtMs, blocked[], title, lang, startTitle, startBody, sig, taskId?}. */
    Function("scheduleSession") { entryJson: String ->
      val ctx = context
      try {
        val e = JSONObject(entryJson)
        val list = sanitize(ctx, Session.strings(e.optJSONArray("blocked")))
        if (e.optString("id").isBlank() || e.optLong("startAtMs") <= 0L || e.optLong("endsAtMs") <= 0L) {
          fail("bad_entry")
        } else if (list.isEmpty()) {
          fail("nothing_to_block")
        } else {
          e.put("blocked", JSONArray(list))
          FocusScheduler.schedule(ctx, e).toString()
        }
      } catch (ex: org.json.JSONException) {
        fail("bad_entry")
      }
    }

    Function("cancelScheduled") { id: String ->
      FocusScheduler.cancel(context, id)
      ok().toString()
    }

    Function("listScheduled") { FocusScheduler.listJson(context) }

    // ── Bypasses ───────────────────────────────────────────────────────────
    /** Incidents noticed natively since the last call (and removed from the native list). */
    Function("drainIncidents") { FocusStore.drainIncidents(context) }

    /**
     * Is a session that should be running actually running? If its window closed with nothing
     * running it, finish it (measuring slips); if it is still open, record the gap and resume it.
     */
    Function("reconcile") { reconcile(context).toString() }

    /** Foreground milliseconds per package inside [fromMs, toMs]. */
    AsyncFunction("usageSummary") { fromMs: Double, toMs: Double ->
      val ctx = context
      if (!FocusPerms.hasUsageAccess(ctx)) {
        fail("no_usage_access")
      } else {
        val arr = JSONArray()
        for ((pkg, ms) in FocusUsage.summary(ctx, fromMs.toLong(), toMs.toLong())) {
          arr.put(JSONObject().put("pkg", pkg).put("ms", ms))
        }
        ok().put("apps", arr).toString()
      }
    }
  }

  private fun reconcile(ctx: Context): JSONObject {
    val s = FocusStore.loadSession(ctx) ?: return JSONObject().put("state", "none")
    val now = System.currentTimeMillis()
    if (FocusService.running) return JSONObject().put("state", "running")
    val beat = FocusStore.lastBeat(ctx)
    val silent = now - beat > FocusService.DEAD_AFTER_MS

    if (now >= s.endsAtMs) {
      // The window closed with nothing running it. If the service died well before the end, that
      // is a bypass; either way the session must be closed and its slips measured.
      if (beat + 60_000L < s.endsAtMs) {
        FocusIncidents.record(ctx, "killed", s, now) { it.put("minutesLeft", FocusIncidents.minutesLeft(s, beat)) }
      }
      val out = FocusIncidents.complete(ctx, s, "completed", now)
      return JSONObject().put("state", "finalized").put("blockedMs", out.blockedMs)
    }

    if (silent) {
      FocusIncidents.record(ctx, "killed", s, now) { it.put("minutesLeft", FocusIncidents.minutesLeft(s, now)) }
    }
    val err = FocusService.begin(ctx, s, resume = true)
    val o = JSONObject().put("state", if (silent) "killed_resumed" else "resumed")
    if (err != null) o.put("error", err)
    return o
  }
}
