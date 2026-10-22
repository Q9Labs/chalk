package com.cloudflare.realtimekit.WebRTCModule;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import java.util.function.Consumer;

/** Owns the projection foreground permission between capture consent and track disposal. */
public final class ScreenCaptureService extends Service {
    private static final String CHANNEL = "webrtc_screen_capture";
    private static Runnable ready;
    private static Consumer<RuntimeException> failed;

    // Called on the main thread, after the user accepts the projection intent.
    static void start(Context context, Runnable onReady, Consumer<RuntimeException> onFailure) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            onReady.run();
            return;
        }
        ready = onReady;
        failed = onFailure;
        try {
            context.startForegroundService(new Intent(context, ScreenCaptureService.class));
        } catch (RuntimeException error) {
            ready = null;
            failed = null;
            onFailure.accept(error);
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, ScreenCaptureService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Runnable onReady = ready;
        Consumer<RuntimeException> onFailure = failed;
        ready = null;
        failed = null;
        if (onReady == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
            Notification notification = new Notification.Builder(this, CHANNEL)
                    .setContentTitle("Sharing your screen")
                    .setSmallIcon(android.R.drawable.presence_video_online)
                    .setOngoing(true)
                    .build();
            startForeground(19488, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            onReady.run();
        } catch (RuntimeException error) {
            stopSelf(startId);
            onFailure.accept(error);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
