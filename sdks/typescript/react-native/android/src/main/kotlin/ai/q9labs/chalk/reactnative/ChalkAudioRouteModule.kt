package ai.q9labs.chalk.reactnative

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Lists the call's audio outputs and switches between them. Android 12 and later pick any
 * communication device (earpiece, speaker, wired or Bluetooth headset); older versions switch
 * only between the earpiece and the speaker.
 */
class ChalkAudioRouteModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val handler = Handler(Looper.getMainLooper())
  private var listening = false

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = emit()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = emit()
  }
  // Created only on Android 12 and later, where the listener type exists.
  private val communicationListener by lazy { AudioManager.OnCommunicationDeviceChangedListener { emit() } }

  override fun getName(): String = "ChalkAudioRouteModule"

  override fun getConstants(): Map<String, Any> = mapOf("eventName" to EVENT_NAME)

  @ReactMethod
  fun addListener(eventName: String) {
    if (listening) return
    listening = true
    audioManager.registerAudioDeviceCallback(deviceCallback, handler)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.addOnCommunicationDeviceChangedListener(reactContext.mainExecutor, communicationListener)
    }
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // The listeners stay until the module goes away; NativeEventEmitter needs this method.
  }

  override fun invalidate() {
    if (listening) {
      audioManager.unregisterAudioDeviceCallback(deviceCallback)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        audioManager.removeOnCommunicationDeviceChangedListener(communicationListener)
      }
    }
    super.invalidate()
  }

  @ReactMethod
  fun getRoutes(promise: Promise) {
    promise.resolve(snapshot())
  }

  @ReactMethod
  fun selectRoute(id: String, promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val device = audioManager.availableCommunicationDevices.firstOrNull { routeId(it) == id }
      if (device == null || !audioManager.setCommunicationDevice(device)) {
        promise.reject("audio_route_failed", "Couldn't switch the audio output to $id.")
        return
      }
    } else {
      @Suppress("DEPRECATION")
      audioManager.isSpeakerphoneOn = id == SPEAKER
    }
    promise.resolve(snapshot())
  }

  private fun emit() {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT_NAME, snapshot())
  }

  private fun snapshot(): WritableMap {
    val routes = Arguments.createArray()
    val result = Arguments.createMap()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      for (device in audioManager.availableCommunicationDevices) {
        val kind = kindOf(device.type) ?: continue
        routes.pushMap(route(routeId(device), kind, if (kind == "bluetooth" || kind == "wired") device.productName.toString() else ""))
      }
      result.putString("selected", audioManager.communicationDevice?.let { routeId(it) } ?: EARPIECE)
    } else {
      routes.pushMap(route(EARPIECE, EARPIECE, ""))
      routes.pushMap(route(SPEAKER, SPEAKER, ""))
      @Suppress("DEPRECATION")
      result.putString("selected", if (audioManager.isSpeakerphoneOn) SPEAKER else EARPIECE)
    }
    result.putArray("routes", routes)
    return result
  }

  private fun route(id: String, kind: String, name: String): WritableMap =
    Arguments.createMap().apply {
      putString("id", id)
      putString("kind", kind)
      putString("name", name)
    }

  private fun routeId(device: AudioDeviceInfo): String =
    when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> EARPIECE
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> SPEAKER
      else -> device.id.toString()
    }

  private fun kindOf(type: Int): String? =
    when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> EARPIECE
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> SPEAKER
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
      else -> null
    }

  private companion object {
    const val EVENT_NAME = "ChalkAudioRouteChanged"
    const val EARPIECE = "earpiece"
    const val SPEAKER = "speaker"
  }
}
