package ai.q9labs.chalk.reactnative

import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telecom.VideoProfile
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class ChalkAndroidConnectionServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "ChalkAndroidConnectionService"

  override fun initialize() {
    super.initialize()
    ChalkConnectionRegistry.attachBridge(reactContext)
  }

  override fun invalidate() {
    ChalkConnectionRegistry.detachBridge(reactContext)
    super.invalidate()
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by React Native's NativeEventEmitter contract.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by React Native's NativeEventEmitter contract.
  }

  @ReactMethod
  fun isSupported(promise: Promise) {
    promise.resolve(ChalkConnectionRegistry.isSupported(reactContext))
  }

  @ReactMethod
  fun registerPhoneAccount(promise: Promise) {
    promise.resolve(registerPhoneAccount())
  }

  @ReactMethod
  fun startCall(options: ReadableMap, promise: Promise) {
    if (!registerPhoneAccount()) {
      promise.resolve(false)
      return
    }

    val callId = options.getNullableString("callId")
    val roomId = options.getNullableString("roomId")
    val roomName = options.getNullableString("roomName")
    val displayName = options.getNullableString("displayName")
    val hasVideo = options.getNullableBoolean("hasVideo") ?: true

    if (callId.isNullOrBlank() || roomId.isNullOrBlank() || roomName.isNullOrBlank() || displayName.isNullOrBlank()) {
      promise.reject("E_CONNECTION_SERVICE_INVALID_CALL", "Android ConnectionService requires callId, roomId, roomName, and displayName.")
      return
    }

    val telecomManager = reactContext.getSystemService(TelecomManager::class.java)
    val phoneAccountHandle = ChalkConnectionRegistry.phoneAccountHandle(reactContext)

    if (telecomManager == null) {
      promise.resolve(false)
      return
    }

    ChalkConnectionRegistry.rememberPendingCall(
      ChalkConnectionRegistry.ChalkCallSpec(
        callId = callId,
        roomId = roomId,
        roomName = roomName,
        displayName = displayName,
        hasVideo = hasVideo,
      ),
    )

    val extras =
      Bundle().apply {
        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, phoneAccountHandle)
        putInt(
          TelecomManager.EXTRA_START_CALL_WITH_VIDEO_STATE,
          if (hasVideo) VideoProfile.STATE_BIDIRECTIONAL else VideoProfile.STATE_AUDIO_ONLY,
        )
        putString(ChalkConnectionRegistry.extraCallId, callId)
        putString(ChalkConnectionRegistry.extraRoomId, roomId)
        putString(ChalkConnectionRegistry.extraRoomName, roomName)
        putString(ChalkConnectionRegistry.extraDisplayName, displayName)
        putBoolean(ChalkConnectionRegistry.extraHasVideo, hasVideo)
      }

    val uriToken = roomId.lowercase().replace("[^a-z0-9._-]".toRegex(), "-")

    try {
      telecomManager.placeCall(Uri.fromParts(PhoneAccount.SCHEME_SIP, "$uriToken@chalkmeet.local", null), extras)
      promise.resolve(true)
    } catch (error: Throwable) {
      ChalkConnectionRegistry.unregisterConnection(callId)
      promise.reject("E_CONNECTION_SERVICE_START_CALL_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun setActive(callId: String, promise: Promise) {
    promise.resolve(ChalkConnectionRegistry.setActive(callId))
  }

  @ReactMethod
  fun endCall(callId: String, reason: String?, label: String?, promise: Promise) {
    promise.resolve(ChalkConnectionRegistry.disconnect(callId, reason, label))
  }

  private fun registerPhoneAccount(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return false
    }

    val telecomManager = reactContext.getSystemService(TelecomManager::class.java) ?: return false
    val phoneAccountHandle: PhoneAccountHandle = ChalkConnectionRegistry.phoneAccountHandle(reactContext)
    val label = reactContext.applicationInfo.loadLabel(reactContext.packageManager)?.toString() ?: "Chalk"

    return try {
      telecomManager.registerPhoneAccount(
        PhoneAccount
          .builder(phoneAccountHandle, label)
          .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
          .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_SIP))
          .build(),
      )

      true
    } catch (error: Throwable) {
      false
    }
  }

  private fun ReadableMap.getNullableBoolean(key: String): Boolean? {
    if (!hasKey(key) || isNull(key)) {
      return null
    }

    return getBoolean(key)
  }

  private fun ReadableMap.getNullableString(key: String): String? {
    if (!hasKey(key) || isNull(key)) {
      return null
    }

    return getString(key)
  }
}
