package expo.modules.focusguard

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The screen that stands between her and a blocked app: "📚 You're learning".
 *
 * Shown by [FocusService] over the blocked app, and opened from the "End early" notification
 * action (then with no app named). It is the only place a session can be ended early, and only
 * after a VISIBLE countdown:
 *
 *   tap "End early"  ->  the button counts down 10, 9, 8 … (disabled)
 *                    ->  at 0 it says "End now" and is enabled
 *                    ->  tap it, and the service ends the session (recorded as ended_early).
 *
 * "Back to learning" cancels a running countdown and goes Home — never into the blocked app.
 * Meira's brand colours: cream ground, warm ink, gold button. No XML layouts: built in code, so
 * the module needs no resources beyond the notification icon.
 */
class FocusBlockActivity : Activity() {
  companion object {
    const val EXTRA_BLOCKED_PACKAGE = "blocked_package"
    const val EXTRA_FROM_NOTIFICATION = "from_notification"

    /** The wait before a session can be ended early. The product rule: ten seconds, visible. */
    const val END_EARLY_COUNTDOWN_SECONDS = 10

    private const val CREAM = 0xFFFCF7EC.toInt()
    private const val WARM_INK = 0xFF574326.toInt()
    private const val INK_SOFT = 0xFF645843.toInt()
    private const val SUN_GOLD = 0xFFF1C24E.toInt()
    private const val ON_GOLD = 0xFF4A3512.toInt()
    private const val CARD = 0xFFFFFDF7.toInt()
    private const val LINE = 0xFFF1E8D6.toInt()
  }

  private val ui = Handler(Looper.getMainLooper())
  private var session: Session? = null
  private var blockedPackage: String? = null
  /** When the visible countdown reaches zero; 0 while idle. Time-based, so it is never short. */
  private var countdownEndsAt = 0L

  private lateinit var statusLine: TextView
  private lateinit var titleLine: TextView
  private lateinit var endButton: Button

  private val ticker = object : Runnable {
    override fun run() {
      val s = FocusStore.loadSession(this@FocusBlockActivity)
      if (s == null || System.currentTimeMillis() >= s.endsAtMs) {
        finish()
        return
      }
      session = s
      render()
      ui.postDelayed(this, 250L)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val s = FocusStore.loadSession(this)
    if (s == null || System.currentTimeMillis() >= s.endsAtMs) {
      finish()
      return
    }
    session = s
    blockedPackage = intent?.getStringExtra(EXTRA_BLOCKED_PACKAGE)
    setContentView(buildUi(s))
    registerBackHandler()
    render()
    ui.postDelayed(ticker, 250L)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    blockedPackage = intent.getStringExtra(EXTRA_BLOCKED_PACKAGE)
    // A new block of a different app, or the notification: start the wait over.
    countdownEndsAt = 0L
    if (session != null) render()
  }

  override fun onDestroy() {
    ui.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    goHome() // Back never reveals the blocked app underneath.
  }

  private fun registerBackHandler() {
    if (Build.VERSION.SDK_INT >= 33) {
      onBackInvokedDispatcher.registerOnBackInvokedCallback(
        android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
      ) { goHome() }
    }
  }

  private fun goHome() {
    try {
      startActivity(
        Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    } catch (e: Exception) {
      android.util.Log.w("FocusGuard", "could not go home: ${e.javaClass.simpleName}")
    }
    finish()
  }

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

  private fun round(color: Int, radiusDp: Int, stroke: Int? = null) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
    if (stroke != null) setStroke(dp(1), stroke)
  }

  private fun buildUi(s: Session): View {
    val he = s.lang == "he"
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(24), dp(48), dp(24), dp(40))
      layoutDirection = if (he) View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
    }

    fun text(size: Float, color: Int, bold: Boolean) = TextView(this).apply {
      textSize = size
      setTextColor(color)
      gravity = Gravity.CENTER
      textAlignment = View.TEXT_ALIGNMENT_CENTER
      if (bold) setTypeface(typeface, Typeface.BOLD)
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    val headline = text(30f, WARM_INK, true).apply { this.text = FocusText.blockHeadline(s.lang) }
    statusLine = text(18f, INK_SOFT, true).apply {
      setPadding(0, dp(14), 0, 0)
    }
    titleLine = text(15f, INK_SOFT, false).apply {
      setPadding(dp(8), dp(10), dp(8), 0)
      this.text = s.title
      visibility = if (s.title.isBlank()) View.GONE else View.VISIBLE
    }

    val back = Button(this).apply {
      text = FocusText.backToLearning(s.lang)
      textSize = 18f
      isAllCaps = false
      setTextColor(ON_GOLD)
      setTypeface(typeface, Typeface.BOLD)
      background = round(SUN_GOLD, 20)
      minimumHeight = dp(60)
      setOnClickListener { goHome() }
    }
    val backParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)).apply {
      topMargin = dp(36)
    }

    endButton = Button(this).apply {
      isAllCaps = false
      textSize = 15f
      setTextColor(INK_SOFT)
      background = round(CARD, 20, LINE)
      minimumHeight = dp(48)
      setOnClickListener { onEndTapped() }
    }
    val endParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)).apply {
      topMargin = dp(16)
    }

    root.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))
    root.addView(headline)
    root.addView(statusLine)
    root.addView(titleLine)
    root.addView(back, backParams)
    root.addView(endButton, endParams)
    root.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))

    val scroll = ScrollView(this).apply {
      setBackgroundColor(CREAM)
      isFillViewport = true
      addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }
    // Edge-to-edge on Android 15+: keep the buttons clear of the status and navigation bars.
    scroll.setOnApplyWindowInsetsListener { v, insets ->
      if (Build.VERSION.SDK_INT >= 30) {
        val bars = insets.getInsets(WindowInsets.Type.systemBars())
        v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      } else {
        @Suppress("DEPRECATION")
        v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
      }
      insets
    }
    return scroll
  }

  private fun secondsLeft(now: Long): Int =
    if (countdownEndsAt == 0L) -1 else maxOf(0L, (countdownEndsAt - now + 999L) / 1000L).toInt()

  private fun onEndTapped() {
    val left = secondsLeft(System.currentTimeMillis())
    when {
      left == -1 -> {
        countdownEndsAt = System.currentTimeMillis() + END_EARLY_COUNTDOWN_SECONDS * 1000L
        render()
      }
      left == 0 -> {
        FocusService.sendAction(this, FocusService.ACTION_END_EARLY)
        finish()
      }
      // While counting, the button is disabled; nothing to do.
    }
  }

  private fun render() {
    val s = session ?: return
    val now = System.currentTimeMillis()
    val left = secondsLeft(now)
    val minLeft = FocusIncidents.minutesLeft(s, now)
    val pkg = blockedPackage
    statusLine.text = if (pkg != null) {
      FocusText.blockedLine(s.lang, FocusIncidents.appLabel(this, pkg), minLeft)
    } else {
      FocusText.learningLine(s.lang, minLeft)
    }
    when {
      left > 0 -> {
        endButton.isEnabled = false
        endButton.text = FocusText.countingDown(s.lang, left)
        endButton.alpha = 0.6f
      }
      left == 0 -> {
        endButton.isEnabled = true
        endButton.text = FocusText.endNow(s.lang)
        endButton.alpha = 1f
      }
      else -> {
        endButton.isEnabled = true
        endButton.text = FocusText.endEarly(s.lang)
        endButton.alpha = 1f
      }
    }
  }
}
