package com.q9labs.chalk

import android.content.Context
import android.media.AudioManager
import android.media.AudioFocusRequest
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class AudioSessionModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  private val audioManager: AudioManager by lazy {
    reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  }

  private var audioFocusRequest: AudioFocusRequest? = null

  override fun getName() = "AudioSessionModule"

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    releaseAudioFocus()
  }

  // MARK: - Exported Methods

  @ReactMethod
  fun configureForCall(promise: Promise) {
    try {
      // Request audio focus with AUDIOFOCUS_GAIN
      val focusResult = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(
            android.media.AudioAttributes.Builder()
              .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
          .setOnAudioFocusChangeListener { focusChange ->
            handleAudioFocusChange(focusChange)
          }
          .build()
        audioFocusRequest = request
        audioManager.requestAudioFocus(request)
      } else {
        @Suppress("DEPRECATION")
        audioManager.requestAudioFocus(
          { focusChange -> handleAudioFocusChange(focusChange) },
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN
        )
      }

      if (focusResult == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        // Set mode to MODE_IN_COMMUNICATION for VoIP quality
        @Suppress("DEPRECATION")
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        promise.resolve(true)
      } else {
        promise.reject("AUDIO_FOCUS_FAILED", "Failed to request audio focus")
      }
    } catch (e: Exception) {
      promise.reject("CONFIGURE_CALL_ERROR", e.message)
    }
  }

  @ReactMethod
  fun setOutputRoute(route: String, promise: Promise) {
    try {
      when (route) {
        "speaker" -> {
          audioManager.isSpeakerphoneOn = true
          sendEvent("audioRouteChanged", mapOf("route" to "speaker").toWritableMap())
          promise.resolve(true)
        }
        "earpiece" -> {
          audioManager.isSpeakerphoneOn = false
          sendEvent("audioRouteChanged", mapOf("route" to "earpiece").toWritableMap())
          promise.resolve(true)
        }
        "bluetooth" -> {
          if (audioManager.isBluetoothScoOn || canStartBluetoothSco()) {
            startBluetoothSco()
            sendEvent("audioRouteChanged", mapOf("route" to "bluetooth").toWritableMap())
            promise.resolve(true)
          } else {
            promise.reject("BLUETOOTH_NOT_AVAILABLE", "Bluetooth device not available")
          }
        }
        else -> {
          promise.reject("INVALID_ROUTE", "Invalid audio route: $route")
        }
      }
    } catch (e: Exception) {
      promise.reject("SET_ROUTE_ERROR", e.message)
    }
  }

  @ReactMethod
  fun getAvailableRoutes(promise: Promise) {
    try {
      val routes = WritableNativeArray()

      // Speaker is always available
      routes.pushString("speaker")

      // Earpiece is always available
      routes.pushString("earpiece")

      // Check for Bluetooth
      if (audioManager.isBluetoothScoOn || canStartBluetoothSco()) {
        routes.pushString("bluetooth")
      }

      // Check for wired headset
      @Suppress("DEPRECATION")
      if (audioManager.isWiredHeadsetOn) {
        routes.pushString("wired")
      }

      promise.resolve(routes)
    } catch (e: Exception) {
      promise.reject("GET_ROUTES_ERROR", e.message)
    }
  }

  @ReactMethod
  fun getCurrentRoute(promise: Promise) {
    try {
      val currentRoute = when {
        audioManager.isSpeakerphoneOn -> "speaker"
        audioManager.isBluetoothScoOn -> "bluetooth"
        @Suppress("DEPRECATION")
        audioManager.isWiredHeadsetOn -> "wired"
        else -> "earpiece"
      }

      promise.resolve(currentRoute)
    } catch (e: Exception) {
      promise.reject("GET_ROUTE_ERROR", e.message)
    }
  }

  @ReactMethod
  fun setSpeakerphone(enabled: Boolean, promise: Promise) {
    try {
      audioManager.isSpeakerphoneOn = enabled
      promise.resolve(enabled)
    } catch (e: Exception) {
      promise.reject("SET_SPEAKERPHONE_ERROR", e.message)
    }
  }

  @ReactMethod
  fun startBluetoothSco(promise: Promise) {
    try {
      if (canStartBluetoothSco()) {
        audioManager.startBluetoothSco()
        promise.resolve(true)
      } else {
        promise.reject("BLUETOOTH_NOT_AVAILABLE", "No Bluetooth device paired")
      }
    } catch (e: Exception) {
      promise.reject("START_BT_SCO_ERROR", e.message)
    }
  }

  @ReactMethod
  fun stopBluetoothSco(promise: Promise) {
    try {
      audioManager.stopBluetoothSco()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("STOP_BT_SCO_ERROR", e.message)
    }
  }

  // MARK: - Private Helpers

  private fun canStartBluetoothSco(): Boolean {
    return audioManager.isBluetoothScoAvailableOffCall ||
           audioManager.isBluetoothA2dpOn ||
           audioManager.isBluetoothScoOn
  }

  private fun startBluetoothSco() {
    try {
      audioManager.startBluetoothSco()
    } catch (e: Exception) {
      // Log error but don't throw - Bluetooth SCO may not be available
    }
  }

  private fun releaseAudioFocus() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        audioFocusRequest?.let {
          audioManager.abandonAudioFocusRequest(it)
        }
      } else {
        @Suppress("DEPRECATION")
        audioManager.abandonAudioFocus(null)
      }
      @Suppress("DEPRECATION")
      audioManager.mode = AudioManager.MODE_NORMAL
    } catch (e: Exception) {
      // Silent failure - cleanup best effort
    }
  }

  private fun handleAudioFocusChange(focusChange: Int) {
    val focusState = when (focusChange) {
      AudioManager.AUDIOFOCUS_GAIN -> "gained"
      AudioManager.AUDIOFOCUS_LOSS -> "lost"
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "lostTransient"
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "lostTransientCanDuck"
      else -> "unknown"
    }

    sendEvent("audioFocusChanged", mapOf("focusState" to focusState).toWritableMap())
  }

  private fun sendEvent(eventName: String, params: WritableMap?) {
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    } catch (e: Exception) {
      // Silent failure - event emission best effort
    }
  }

  private fun Map<String, Any?>.toWritableMap(): WritableMap {
    val map = WritableNativeMap()
    for ((key, value) in this) {
      when (value) {
        is String -> map.putString(key, value)
        is Boolean -> map.putBoolean(key, value)
        is Int -> map.putInt(key, value)
        is Double -> map.putDouble(key, value)
        null -> map.putNull(key)
        else -> map.putString(key, value.toString())
      }
    }
    return map
  }
}
