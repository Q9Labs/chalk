package ai.q9labs.chalk.reactnative;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps a call's microphone and camera working in the background. Android 11 and later cut off a
 * background app's audio and video input unless a foreground service of that type runs. Android 14
 * throws when a type's permission is missing, so the service declares only the types granted.
 */
public class ChalkSpaceForegroundService extends Service {
    private static final String TAG = "ChalkCallService";
    private static final String CHANNEL_ID = "chalk_call_background";
    private static final int NOTIFICATION_ID = 19487;

    // Main thread only. Android crashes the app when a service started with startForegroundService() is
    // stopped before it calls startForeground(), so a stop that arrives while a start is pending waits
    // for that start to promote the service, and the newest request wins across a quick Leave and Rejoin.
    private static boolean wanted;
    private static int pendingStarts;

    /** Asks for the service on the main thread. Returns false when Android refuses the start. */
    static boolean requestStart(Context context) {
        wanted = true;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, ChalkSpaceForegroundService.class));
            pendingStarts++;
            return true;
        } catch (RuntimeException error) {
            Log.w(TAG, "Couldn't start the call's foreground service", error);
            return false;
        }
    }

    /** Stops the service on the main thread, or after the pending start has promoted it. */
    static void requestStop(Context context) {
        wanted = false;
        if (pendingStarts == 0) {
            context.stopService(new Intent(context, ChalkSpaceForegroundService.class));
        }
    }

    /** The foreground types the person has granted: microphone and camera, or 0 when neither is granted. */
    static int grantedForegroundTypes(Context context) {
        int types = 0;
        if (isGranted(context, Manifest.permission.RECORD_AUDIO)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        if (isGranted(context, Manifest.permission.CAMERA)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        }
        return types;
    }

    private static boolean isGranted(Context context, String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        pendingStarts = Math.max(0, pendingStarts - 1);
        int foregroundTypes = grantedForegroundTypes(this);
        if (foregroundTypes == 0) {
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        Notification notification = buildNotification();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIFICATION_ID, notification, foregroundTypes);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Couldn't start the call's foreground service", error);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!wanted && pendingStarts == 0) {
            stopSelf();
        }

        // Not sticky: a call can't resume after the process is killed, so a restart would leave a notification with no call behind it.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        // A destroyed service delivers no more starts, so none can still be pending.
        pendingStarts = 0;
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentTitle("Chalk call in progress")
                .setContentText("Tap to return to the call")
                .setContentIntent(openAppIntent())
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setSmallIcon(android.R.drawable.presence_video_online)
                .build();
    }

    private PendingIntent openAppIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) {
            return null;
        }
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Chalk call", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps the microphone and camera on while Chalk is in the background");
        manager.createNotificationChannel(channel);
    }
}
