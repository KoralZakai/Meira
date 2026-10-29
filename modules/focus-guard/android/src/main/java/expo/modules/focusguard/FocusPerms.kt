package expo.modules.focusguard

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/**
 * The two special-app-access permissions blocking depends on, and whether notifications are on.
 *
 * Neither special access has a runtime dialog: the user must flip a switch on a Settings page,
 * so the only honest API is "check" and "open the page" — and the JS side re-checks when the
 * app comes back to the front.
 */
internal object FocusPerms {
  /** Usage access (PACKAGE_USAGE_STATS): lets us see which app is in front. */
  @Suppress("DEPRECATION")
  fun hasUsageAccess(ctx: Context): Boolean {
    val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
    val mode = if (Build.VERSION.SDK_INT >= 29) {
      ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
    } else {
      ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
    }
    return if (mode == AppOpsManager.MODE_DEFAULT) {
      ctx.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) ==
        PackageManager.PERMISSION_GRANTED
    } else {
      mode == AppOpsManager.MODE_ALLOWED
    }
  }

  /** Display over other apps (SYSTEM_ALERT_WINDOW): lets us put the block screen in front. */
  fun canDrawOverlays(ctx: Context): Boolean =
    Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(ctx)

  fun notificationsEnabled(ctx: Context): Boolean =
    NotificationManagerCompat.from(ctx).areNotificationsEnabled()

  /** The Settings page for one permission; [which] is "usage" or "overlay". */
  fun settingsIntent(ctx: Context, which: String, withPackage: Boolean = true): Intent {
    val intent = if (which == "usage") {
      Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
    } else {
      Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
    }
    // Overlay requires the package URI to land on Meira's own row; usage access accepts it from
    // Android 10 and ignores it before that.
    if (withPackage) intent.data = Uri.parse("package:${ctx.packageName}")
    return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  /** Opens the page; falls back to the page without the package URI if the first one is refused. */
  fun open(ctx: Context, which: String): String? {
    return try {
      ctx.startActivity(settingsIntent(ctx, which, true)); null
    } catch (first: Exception) {
      try {
        ctx.startActivity(settingsIntent(ctx, which, false)); null
      } catch (second: Exception) {
        second.javaClass.simpleName
      }
    }
  }
}
