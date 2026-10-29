package expo.modules.focusguard

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Study sessions that start on their own at the task's hour.
 *
 * An entry is {id, startAtMs, endsAtMs, blocked[], title, lang, startTitle, startBody, sig,
 * fired, error?}. [sig] is a fingerprint JS computes from everything that makes the session what
 * it is (window, list, title): the same id with the same sig is a no-op, so calendar sync can
 * call schedule on every run; a different sig replaces the entry and re-arms the alarm.
 *
 * The alarm is exact when Android allows it (SCHEDULE_EXACT_ALARM, which on Android 14+ she must
 * grant under "Alarms & reminders"; USE_EXACT_ALARM was removed for Play on 19.10), else
 * setAndAllowWhileIdle — inexact, so on a dozing phone it can be minutes late.
 * [FocusAlarmReceiver] starts the session late rather than never, as long as the window is open.
 */
internal object FocusScheduler {
  private const val ACTION = "expo.modules.focusguard.action.START_SCHEDULED"

  private fun pendingIntent(ctx: Context, id: String): PendingIntent {
    val intent = Intent(ctx, FocusAlarmReceiver::class.java)
      .setAction(ACTION)
      .setData(Uri.parse("meira-focus://session/${Uri.encode(id)}")) // distinct per id
      .putExtra("id", id)
    return PendingIntent.getBroadcast(ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** Arms the alarm for [startAtMs]. Returns null on success, else a typed reason. */
  fun arm(ctx: Context, id: String, startAtMs: Long): String? {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return "no_alarm_manager"
    val pi = pendingIntent(ctx, id)
    return try {
      val exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
      if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, startAtMs, pi)
      else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, startAtMs, pi)
      null
    } catch (e: SecurityException) {
      try {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, startAtMs, pi)
        null
      } catch (e2: Exception) {
        "alarm_refused:${e2.javaClass.simpleName}"
      }
    } catch (e: Exception) {
      "alarm_refused:${e.javaClass.simpleName}"
    }
  }

  fun cancel(ctx: Context, id: String) {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
    try {
      am?.cancel(pendingIntent(ctx, id))
    } catch (e: Exception) {
      android.util.Log.w("FocusGuard", "cancel alarm '$id' failed: ${e.javaClass.simpleName}")
    }
    FocusStore.removeScheduled(ctx, id)
  }

  /**
   * Store and arm one session. Returns a JSON result: {ok, already?, reason?}.
   * Same id + same sig is left alone — including one that already fired, so a session she ended
   * early is not started a second time by the next sync.
   */
  fun schedule(ctx: Context, entry: JSONObject): JSONObject {
    val id = entry.getString("id")
    val old = FocusStore.getScheduled(ctx, id)
    if (old != null && old.optString("sig") == entry.optString("sig") && entry.optString("sig").isNotEmpty()) {
      return JSONObject().put("ok", true).put("already", true).put("fired", old.optBoolean("fired"))
    }
    val now = System.currentTimeMillis()
    if (entry.getLong("endsAtMs") <= now) {
      return JSONObject().put("ok", false).put("reason", "window_over")
    }
    entry.put("fired", false)
    FocusStore.putScheduled(ctx, entry)
    val startAt = entry.getLong("startAtMs")
    if (startAt <= now) {
      // Due now (the caller decided it is inside the grace window): start without waiting.
      FocusAlarmReceiver.fire(ctx, id)
      return JSONObject().put("ok", true).put("startedNow", true)
    }
    val err = arm(ctx, id, startAt)
    if (err != null) {
      FocusStore.markFired(ctx, id, err)
      return JSONObject().put("ok", false).put("reason", err)
    }
    return JSONObject().put("ok", true)
  }

  fun listJson(ctx: Context): String {
    FocusStore.pruneScheduled(ctx, System.currentTimeMillis())
    val all = FocusStore.scheduled(ctx)
    val out = JSONArray()
    val it = all.keys()
    while (it.hasNext()) out.put(all.getJSONObject(it.next()))
    return out.toString()
  }

  /** After a reboot / app update: arm what is still ahead, start what is due, drop what is over. */
  fun rearmAll(ctx: Context) {
    val now = System.currentTimeMillis()
    FocusStore.pruneScheduled(ctx, now)
    val all = FocusStore.scheduled(ctx)
    val ids = ArrayList<String>()
    val it = all.keys()
    while (it.hasNext()) ids.add(it.next())
    for (id in ids) {
      val e = all.optJSONObject(id) ?: continue
      if (e.optBoolean("fired")) continue
      if (e.optLong("endsAtMs") <= now) continue
      if (e.optLong("startAtMs") <= now) FocusAlarmReceiver.fire(ctx, id)
      else {
        val err = arm(ctx, id, e.optLong("startAtMs"))
        if (err != null) FocusStore.markFired(ctx, id, err)
      }
    }
  }
}

/** Receives the study-session alarm and starts the session. */
class FocusAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    fire(context.applicationContext, id)
  }

  companion object {
    /** Starts the scheduled session [id] now, if its window is still open. */
    internal fun fire(ctx: Context, id: String) {
      val e = FocusStore.getScheduled(ctx, id) ?: return
      if (e.optBoolean("fired")) return
      val now = System.currentTimeMillis()
      val endsAt = e.optLong("endsAtMs")
      if (now >= endsAt - 60_000L) {
        FocusStore.markFired(ctx, id, "missed_window")
        return
      }
      val lang = e.optString("lang", "en")
      val session = Session(
        id = id,
        title = e.optString("title"),
        lang = lang,
        blocked = Session.strings(e.optJSONArray("blocked")),
        startedAtMs = now,
        endsAtMs = endsAt,
        taskId = if (e.isNull("taskId") || !e.has("taskId")) null else e.optString("taskId"),
      )
      val err = FocusService.begin(ctx, session)
      FocusStore.markFired(ctx, id, err)
      if (err == null) {
        val title = e.optString("startTitle").ifBlank { FocusText.startedTitle(lang) }
        FocusNotify.started(ctx, title, e.optString("startBody"))
      } else {
        FocusNotify.startFailed(ctx, lang)
      }
    }
  }
}

/** Re-arms scheduled sessions (and resumes a running one) after a reboot or an app update. */
class FocusBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    try {
      FocusScheduler.rearmAll(app)
      val s = FocusStore.loadSession(app)
      if (s != null && System.currentTimeMillis() < s.endsAtMs) {
        // A reboot is not a bypass: reset the heartbeat so the resumed service does not report it.
        FocusStore.beat(app)
        FocusService.begin(app, s, resume = true)?.let {
          android.util.Log.w("FocusGuard", "could not resume the session after boot: $it")
        }
      }
    } catch (e: Exception) {
      android.util.Log.w("FocusGuard", "boot re-arm failed: ${e.javaClass.simpleName}: ${e.message}")
    }
  }
}
