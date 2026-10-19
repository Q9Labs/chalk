package ai.q9labs.chalk.reactnative

import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** Starts and stops the foreground service that keeps a call's microphone and camera working in the background. */
class ChalkCallServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "ChalkCallService"

  /** Resolves false when the person hasn't granted the microphone or camera, or when Android refuses the start. The call continues either way. */
  @ReactMethod
  fun start(promise: Promise) {
    if (ChalkSpaceForegroundService.grantedForegroundTypes(reactContext) == 0) {
      promise.resolve(false)
      return
    }

    try {
      ContextCompat.startForegroundService(reactContext, Intent(reactContext, ChalkSpaceForegroundService::class.java))
      promise.resolve(true)
    } catch (error: RuntimeException) {
      Log.w(TAG, "Couldn't start the call's foreground service", error)
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    reactContext.stopService(Intent(reactContext, ChalkSpaceForegroundService::class.java))
    promise.resolve(null)
  }

  private companion object {
    const val TAG = "ChalkCallService"
  }
}
