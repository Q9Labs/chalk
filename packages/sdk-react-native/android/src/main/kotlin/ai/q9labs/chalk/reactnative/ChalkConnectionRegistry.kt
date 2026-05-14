package ai.q9labs.chalk.reactnative

import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentHashMap

internal object ChalkConnectionRegistry {
  const val phoneAccountId = "chalk-self-managed-calls"
  const val eventName = "ChalkAndroidConnectionServiceEvent"
  const val extraCallId = "chalk.call_id"
  const val extraRoomId = "chalk.room_id"
  const val extraRoomName = "chalk.room_name"
  const val extraDisplayName = "chalk.display_name"
  const val extraHasVideo = "chalk.has_video"

  private val pendingCalls = ConcurrentHashMap<String, ChalkCallSpec>()
  private val activeConnections = ConcurrentHashMap<String, ChalkSelfManagedConnection>()

  @Volatile
  private var bridgeContext: ReactApplicationContext? = null

  data class ChalkCallSpec(
    val callId: String,
    val roomId: String,
    val roomName: String,
    val displayName: String,
    val hasVideo: Boolean,
  )

  fun isSupported(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return false
    }

    return context.getSystemService(TelecomManager::class.java) != null
  }

  fun phoneAccountHandle(context: Context): PhoneAccountHandle {
    return PhoneAccountHandle(ComponentName(context, ChalkSelfManagedConnectionService::class.java), phoneAccountId)
  }

  fun rememberPendingCall(spec: ChalkCallSpec) {
    pendingCalls[spec.callId] = spec
  }

  fun findPendingCall(callId: String): ChalkCallSpec? {
    return pendingCalls[callId]
  }

  fun registerConnection(callId: String, connection: ChalkSelfManagedConnection) {
    activeConnections[callId] = connection
    pendingCalls.remove(callId)
  }

  fun unregisterConnection(callId: String) {
    activeConnections.remove(callId)
    pendingCalls.remove(callId)
  }

  fun setActive(callId: String): Boolean {
    val connection = activeConnections[callId] ?: return false
    connection.markActive()
    return true
  }

  fun disconnect(callId: String, reason: String?, label: String?): Boolean {
    val removedPendingCall = pendingCalls.remove(callId) != null
    val connection = activeConnections.remove(callId) ?: return removedPendingCall
    connection.markDisconnected(buildDisconnectCause(reason, label))
    return true
  }

  fun attachBridge(context: ReactApplicationContext) {
    bridgeContext = context
  }

  fun detachBridge(context: ReactApplicationContext) {
    if (bridgeContext == context) {
      bridgeContext = null
    }
  }

  fun emitDisconnectRequested(callId: String, reason: String) {
    val context = bridgeContext ?: return
    if (!context.hasActiveCatalystInstance()) {
      return
    }

    val payload = Arguments.createMap().apply {
      putString("type", "disconnect")
      putString("callId", callId)
      putString("reason", reason)
    }

    context
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(eventName, payload)
  }

  private fun buildDisconnectCause(reason: String?, label: String?): DisconnectCause {
    val code =
      when (reason) {
        "canceled" -> DisconnectCause.CANCELED
        "rejected" -> DisconnectCause.REJECTED
        "missed" -> DisconnectCause.MISSED
        "remote" -> DisconnectCause.REMOTE
        "error" -> DisconnectCause.ERROR
        else -> DisconnectCause.LOCAL
      }

    return DisconnectCause(code, label)
  }
}
