package com.q9labs.chalk

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CallServiceModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "CallServiceModule"

  @ReactMethod
  fun startCallService(roomId: String, roomName: String, promise: Promise) {
    try {
      val intent = Intent(reactApplicationContext, CallService::class.java).apply {
        putExtra("roomId", roomId)
        putExtra("roomName", roomName)
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactApplicationContext.startForegroundService(intent)
      } else {
        @Suppress("DEPRECATION")
        reactApplicationContext.startService(intent)
      }

      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("START_SERVICE_ERROR", e.message)
    }
  }

  @ReactMethod
  fun stopCallService(promise: Promise) {
    try {
      val intent = Intent(reactApplicationContext, CallService::class.java)
      reactApplicationContext.stopService(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("STOP_SERVICE_ERROR", e.message)
    }
  }

  @ReactMethod
  fun updateNotification(title: String, body: String, promise: Promise) {
    try {
      val intent = Intent(reactApplicationContext, CallService::class.java).apply {
        action = CallService.ACTION_UPDATE_NOTIFICATION
        putExtra("title", title)
        putExtra("body", body)
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactApplicationContext.startForegroundService(intent)
      } else {
        @Suppress("DEPRECATION")
        reactApplicationContext.startService(intent)
      }

      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("UPDATE_NOTIFICATION_ERROR", e.message)
    }
  }

  @ReactMethod
  fun isServiceRunning(promise: Promise) {
    try {
      val manager = reactApplicationContext.getSystemService(Context.ACTIVITY_SERVICE)
      promise.resolve(false)
    } catch (e: Exception) {
      promise.reject("IS_SERVICE_RUNNING_ERROR", e.message)
    }
  }
}
