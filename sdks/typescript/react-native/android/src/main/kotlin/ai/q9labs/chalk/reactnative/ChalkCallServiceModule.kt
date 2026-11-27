package ai.q9labs.chalk.reactnative

import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Starts and stops the foreground service that keeps a call's microphone and camera working in the background, and
 * reports which kind of Android device the call runs on.
 */
class ChalkCallServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "ChalkCallService"

  /** What the other participants see next to this person: a foldable has a hinge sensor, a tablet is at least 600dp wide, else a phone. */
  override fun getConstants(): Map<String, Any> = mapOf("deviceKind" to deviceKind())

  private fun deviceKind(): String =
    when {
      reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_HINGE_ANGLE) -> "android_foldable"
      reactContext.resources.configuration.smallestScreenWidthDp >= TABLET_MIN_WIDTH_DP -> "android_tablet"
      else -> "android_phone"
    }

  /** Resolves false when the person hasn't granted the microphone or camera, or when Android refuses the start. The call continues either way. */
  @ReactMethod
  fun start(promise: Promise) {
    // The service keeps its start and stop state on the main thread, where its own callbacks run.
    mainThread.post { promise.resolve(ChalkSpaceForegroundService.requestStart(reactContext)) }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    mainThread.post {
      ChalkSpaceForegroundService.requestStop()
      promise.resolve(null)
    }
  }

  private val mainThread = Handler(Looper.getMainLooper())

  private companion object {
    const val TABLET_MIN_WIDTH_DP = 600
  }
}
