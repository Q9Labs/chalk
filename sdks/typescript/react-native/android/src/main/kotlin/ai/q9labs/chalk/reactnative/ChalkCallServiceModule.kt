package ai.q9labs.chalk.reactnative

import android.os.Handler
import android.os.Looper
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
    // The service keeps its start and stop state on the main thread, where its own callbacks run.
    mainThread.post { promise.resolve(ChalkSpaceForegroundService.requestStart(reactContext)) }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    mainThread.post {
      ChalkSpaceForegroundService.requestStop(reactContext)
      promise.resolve(null)
    }
  }

  private val mainThread = Handler(Looper.getMainLooper())
}
