package expo.modules.focusguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * One learning session. Saved to SharedPreferences the moment it starts, so a service that the
 * OS restarts (START_STICKY), a reboot, or a process that died all resume the SAME session until
 * [endsAtMs] — and so the JS side can tell "a session is still inside its window but nothing is
 * running it", which is the force-stop bypass.
 */
internal data class Session(
  val id: String,
  val title: String,
  val lang: String,
  val blocked: List<String>,
  val startedAtMs: Long,
  val endsAtMs: Long,
  val taskId: String?,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("title", title)
    .put("lang", lang)
    .put("blocked", JSONArray(blocked))
    .put("startedAtMs", startedAtMs)
    .put("endsAtMs", endsAtMs)
    .put("taskId", taskId ?: JSONObject.NULL)

  companion object {
    fun fromJson(o: JSONObject): Session = Session(
      id = o.optString("id"),
      title = o.optString("title"),
      lang = o.optString("lang", "en"),
      blocked = strings(o.optJSONArray("blocked")),
      startedAtMs = o.optLong("startedAtMs"),
      endsAtMs = o.optLong("endsAtMs"),
      taskId = if (o.isNull("taskId")) null else o.optString("taskId"),
    )

    fun strings(a: JSONArray?): List<String> {
      if (a == null) return emptyList()
      val out = ArrayList<String>(a.length())
      for (i in 0 until a.length()) out.add(a.optString(i))
      return out
    }
  }
}

/**
 * Everything the native side remembers, in one SharedPreferences file:
 *
 *   session    the running session (absent when none)
 *   beat       when the service last proved it was alive (ms)
 *   warn       what is wrong with the running session right now: usage | overlay | block_failed
 *   last       the session that ended most recently, and how
 *   incidents  bypasses noticed while JS was not running — drained by JS, which turns them into
 *              the lecture ("You said you were studying!!")
 *   scheduled  study sessions waiting for their alarm, by id
 */
internal object FocusStore {
  private const val PREFS = "meira_focus_guard"
  private const val K_SESSION = "session"
  private const val K_BEAT = "beat"
  private const val K_WARN = "warn"
  private const val K_LAST = "last"
  private const val K_INCIDENTS = "incidents"
  private const val K_SCHEDULED = "scheduled"
  private const val MAX_INCIDENTS = 40

  private fun prefs(ctx: Context) =
    ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ── The running session ───────────────────────────────────────────────────
  @Synchronized
  fun loadSession(ctx: Context): Session? {
    val raw = prefs(ctx).getString(K_SESSION, null) ?: return null
    return try {
      Session.fromJson(JSONObject(raw))
    } catch (e: Exception) {
      android.util.Log.w("FocusGuard", "stored session unreadable: ${e.message}")
      null
    }
  }

  @Synchronized
  fun saveSession(ctx: Context, s: Session) {
    prefs(ctx).edit().putString(K_SESSION, s.toJson().toString()).putLong(K_BEAT, System.currentTimeMillis())
      .remove(K_WARN).apply()
  }

  @Synchronized
  fun clearSession(ctx: Context) {
    prefs(ctx).edit().remove(K_SESSION).remove(K_WARN).apply()
  }

  fun beat(ctx: Context, at: Long = System.currentTimeMillis()) {
    prefs(ctx).edit().putLong(K_BEAT, at).apply()
  }

  fun lastBeat(ctx: Context): Long = prefs(ctx).getLong(K_BEAT, 0L)

  fun setWarn(ctx: Context, warn: String?) {
    val e = prefs(ctx).edit()
    if (warn == null) e.remove(K_WARN) else e.putString(K_WARN, warn)
    e.apply()
  }

  fun warn(ctx: Context): String? = prefs(ctx).getString(K_WARN, null)

  // ── The session that just ended ───────────────────────────────────────────
  fun saveLast(ctx: Context, s: Session, reason: String, endedAtMs: Long, blockedMs: Long, measured: Boolean) {
    val o = s.toJson().put("reason", reason).put("endedAtMs", endedAtMs).put("blockedMs", blockedMs).put("measured", measured)
    prefs(ctx).edit().putString(K_LAST, o.toString()).apply()
  }

  fun lastJson(ctx: Context): String = prefs(ctx).getString(K_LAST, null) ?: "null"

  // ── Bypasses noticed natively ─────────────────────────────────────────────
  @Synchronized
  fun appendIncident(ctx: Context, incident: JSONObject) {
    val arr = try {
      JSONArray(prefs(ctx).getString(K_INCIDENTS, "[]"))
    } catch (e: Exception) {
      JSONArray()
    }
    arr.put(incident)
    val trimmed = JSONArray()
    val from = maxOf(0, arr.length() - MAX_INCIDENTS)
    for (i in from until arr.length()) trimmed.put(arr.get(i))
    prefs(ctx).edit().putString(K_INCIDENTS, trimmed.toString()).apply()
  }

  /** Returns the pending incidents as a JSON array string and empties the list. */
  @Synchronized
  fun drainIncidents(ctx: Context): String {
    val raw = prefs(ctx).getString(K_INCIDENTS, "[]") ?: "[]"
    prefs(ctx).edit().remove(K_INCIDENTS).apply()
    return raw
  }

  // ── Scheduled sessions ────────────────────────────────────────────────────
  @Synchronized
  fun scheduled(ctx: Context): JSONObject = try {
    JSONObject(prefs(ctx).getString(K_SCHEDULED, "{}") ?: "{}")
  } catch (e: Exception) {
    JSONObject()
  }

  @Synchronized
  fun getScheduled(ctx: Context, id: String): JSONObject? = scheduled(ctx).optJSONObject(id)

  @Synchronized
  fun putScheduled(ctx: Context, entry: JSONObject) {
    val all = scheduled(ctx)
    all.put(entry.getString("id"), entry)
    prefs(ctx).edit().putString(K_SCHEDULED, all.toString()).apply()
  }

  @Synchronized
  fun removeScheduled(ctx: Context, id: String) {
    val all = scheduled(ctx)
    all.remove(id)
    prefs(ctx).edit().putString(K_SCHEDULED, all.toString()).apply()
  }

  /** Marks an entry as fired (or as having failed to start, with the typed reason). */
  @Synchronized
  fun markFired(ctx: Context, id: String, error: String?) {
    val all = scheduled(ctx)
    val e = all.optJSONObject(id) ?: return
    e.put("fired", true)
    if (error == null) e.remove("error") else e.put("error", error)
    all.put(id, e)
    prefs(ctx).edit().putString(K_SCHEDULED, all.toString()).apply()
  }

  /** Forgets entries whose window ended more than a day ago. */
  @Synchronized
  fun pruneScheduled(ctx: Context, now: Long) {
    val all = scheduled(ctx)
    val dead = ArrayList<String>()
    val it = all.keys()
    while (it.hasNext()) {
      val k = it.next()
      val e = all.optJSONObject(k) ?: continue
      if (now - e.optLong("endsAtMs") > 24L * 60 * 60 * 1000) dead.add(k)
    }
    if (dead.isEmpty()) return
    for (k in dead) all.remove(k)
    prefs(ctx).edit().putString(K_SCHEDULED, all.toString()).apply()
  }
}
