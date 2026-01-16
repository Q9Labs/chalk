package com.q9labs.chalk

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class CallService : Service() {

  companion object {
    const val CHANNEL_ID = "chalk_call_channel"
    const val NOTIFICATION_ID = 1001
    const val ACTION_STOP = "com.q9labs.chalk.STOP_CALL"
    const val ACTION_UPDATE_NOTIFICATION = "com.q9labs.chalk.UPDATE_NOTIFICATION"
  }

  private lateinit var notificationManager: NotificationManager

  override fun onCreate() {
    super.onCreate()
    notificationManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_UPDATE_NOTIFICATION -> {
        val title = intent.getStringExtra("title") ?: "In call"
        val body = intent.getStringExtra("body") ?: ""
        updateNotification(title, body)
        return START_STICKY
      }
    }

    val roomId = intent?.getStringExtra("roomId") ?: return START_STICKY
    val roomName = intent.getStringExtra("roomName") ?: "Unknown room"

    val notification = createNotification(roomName)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      )
    } else {
      @Suppress("DEPRECATION")
      startForeground(NOTIFICATION_ID, notification)
    }

    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Active Calls",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Shows when you're in a call"
        setShowBadge(false)
      }
      notificationManager.createNotificationChannel(channel)
    }
  }

  private fun createNotification(roomName: String): android.app.Notification {
    // PendingIntent to return to app
    val intent = Intent(this, this::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }

    val returnIntent = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    // PendingIntent for "End call" action
    val stopIntent = Intent(this, CallService::class.java).apply {
      action = ACTION_STOP
    }

    val stopPendingIntent = PendingIntent.getService(
      this,
      1,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("In call")
      .setContentText(roomName)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentIntent(returnIntent)
      .addAction(0, "End call", stopPendingIntent)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()
  }

  fun updateNotification(title: String, body: String) {
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()

    notificationManager.notify(NOTIFICATION_ID, notification)
  }
}
