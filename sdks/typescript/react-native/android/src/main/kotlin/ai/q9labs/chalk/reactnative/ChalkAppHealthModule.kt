package ai.q9labs.chalk.reactnative

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.Process
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import org.json.JSONObject
import java.io.File

/**
 * The native half of the app's health evidence: the launch marker file (written synchronously before React
 * Native loads, so a death before JS ran still leaves it), the OS's exit reason for the last process, the
 * low-memory flag and the thermal status. The marker body never holds pt_, ep_ or ten_ ids.
 */
class ChalkAppHealthModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "ChalkAppHealth"

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun markReady(cs: String) {
    write(mapOf("js_ready" to true, "phase" to "boot", "cs" to cs))
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun markFatal(errorName: String) {
    write(mapOf("js_ready" to true, "fatal" to errorName))
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun markCallEnded() {
    write(mapOf("clean_exit" to "call_ended", "phase" to "live"))
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun setAppState(state: String) {
    write(mapOf("app_state" to state))
  }

  @ReactMethod
  fun readMarker(promise: Promise) {
    val file = markerFile(reactContext)
    if (!file.exists()) {
      promise.resolve(null)
      return
    }
    try {
      val body = JSONObject(file.readText())
      val out = WritableNativeMap()
      for (key in body.keys()) {
        when (val value = body.get(key)) {
          is Boolean -> out.putBoolean(key, value)
          is Int -> out.putInt(key, value)
          is Long -> out.putDouble(key, value.toDouble())
          is Double -> out.putDouble(key, value)
          else -> out.putString(key, value.toString())
        }
      }
      promise.resolve(out)
    } catch (error: Exception) {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun readExitInfo(pid: Double, promise: Promise) {
    if (Build.VERSION.SDK_INT < 30) {
      promise.resolve(exitMap("unsupported"))
      return
    }
    val manager = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val exits = manager.getHistoricalProcessExitReasons(null, pid.toInt(), 1)
    if (exits.isEmpty()) {
      promise.resolve(exitMap("no_record"))
      return
    }
    val info = exits[0]
    val out = exitMap(reasonName(info.reason))
    out.putDouble("launched_at_ms", info.timestamp.toDouble())
    promise.resolve(out)
  }

  @ReactMethod
  fun lowMemory(promise: Promise) {
    val manager = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val info = ActivityManager.MemoryInfo()
    manager.getMemoryInfo(info)
    promise.resolve(info.lowMemory)
  }

  @ReactMethod
  fun thermalState(promise: Promise) {
    if (Build.VERSION.SDK_INT < 29) {
      promise.resolve("unsupported")
      return
    }
    val manager = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    promise.resolve(
      when (manager.currentThermalStatus) {
        PowerManager.THERMAL_STATUS_NONE -> "nominal"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        else -> "shutdown"
      },
    )
  }

  private fun write(fields: Map<String, Any>) {
    val file = markerFile(reactContext)
    val body = try {
      if (file.exists()) JSONObject(file.readText()) else JSONObject()
    } catch (error: Exception) {
      JSONObject()
    }
    for ((key, value) in fields) body.put(key, value)
    body.put("last_elapsed_ms", Process.getElapsedCpuTime())
    try {
      file.writeText(body.toString())
    } catch (error: Exception) {
      // A file that cannot be written leaves no marker: an honest gap, not an error.
    }
  }

  private fun exitMap(reason: String): WritableNativeMap {
    val out = WritableNativeMap()
    out.putString("reason", reason)
    return out
  }

  companion object {
    private fun markerFile(context: Context) = File(context.filesDir, "chalk.run_marker.json")

    private fun reasonName(reason: Int): String = when (reason) {
      0 -> "REASON_UNKNOWN"
      1 -> "REASON_EXIT_SELF"
      2 -> "REASON_SIGNALED"
      3 -> "REASON_LOW_MEMORY"
      4 -> "REASON_CRASH"
      5 -> "REASON_CRASH_NATIVE"
      6 -> "REASON_ANR"
      7 -> "REASON_INITIALIZATION_FAILURE"
      8 -> "REASON_PERMISSION_CHANGE"
      9 -> "REASON_EXCESSIVE_RESOURCE_USAGE"
      10 -> "REASON_USER_REQUESTED"
      11 -> "REASON_USER_STOPPED"
      12 -> "REASON_DEPENDENCY_DIED"
      13 -> "REASON_OTHER"
      14 -> "REASON_FREEZER"
      15 -> "REASON_STATE_CHANGE"
      16 -> "REASON_SYSTEM_STATE_CHANGE"
      else -> "REASON_UNKNOWN"
    }

    /** The launch marker, written by MainApplication.onCreate before React Native loads: phase launch, js_ready false. */
    @JvmStatic
    fun markLaunch(context: Application) {
      try {
        markerFile(context).writeText(
          JSONObject()
            .put("phase", "launch")
            .put("js_ready", false)
            .put("pid", Process.myPid())
            .put("launch_id", java.util.UUID.randomUUID().toString())
            .put("launched_at_ms", System.currentTimeMillis())
            .toString(),
        )
      } catch (error: Exception) {
        // No marker file means the launch is unwitnessed: a gap, never an error on the app's start path.
      }
    }
  }
}
