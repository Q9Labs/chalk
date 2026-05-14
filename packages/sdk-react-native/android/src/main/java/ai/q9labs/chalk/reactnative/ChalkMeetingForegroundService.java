package ai.q9labs.chalk.reactnative;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class ChalkMeetingForegroundService extends Service {
    static final String ACTION_START = "ai.q9labs.chalk.reactnative.action.START_BACKGROUND_MEETING";
    static final String ACTION_STOP = "ai.q9labs.chalk.reactnative.action.STOP_BACKGROUND_MEETING";
    static final String EXTRA_ROOM_NAME = "roomName";
    static final String EXTRA_PARTICIPANT_NAME = "participantName";
    static final String EXTRA_CAMERA_OFF = "cameraOff";
    private static final String CHANNEL_ID = "chalk_meeting_background";
    private static final int NOTIFICATION_ID = 19487;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();

        String roomName = intent != null ? intent.getStringExtra(EXTRA_ROOM_NAME) : null;
        String participantName = intent != null ? intent.getStringExtra(EXTRA_PARTICIPANT_NAME) : null;
        boolean cameraOff = intent != null && intent.getBooleanExtra(EXTRA_CAMERA_OFF, false);
        Notification notification = buildNotification(roomName, participantName, cameraOff);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                int foregroundType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (!cameraOff) {
                    foregroundType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                }
                startForeground(NOTIFICATION_ID, notification, foregroundType);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException error) {
            stopSelf();
        }

        return START_STICKY;
    }

    private Notification buildNotification(String roomName, String participantName, boolean cameraOff) {
        String title = roomName != null && !roomName.trim().isEmpty() ? roomName.trim() : "Chalk meeting in progress";
        String subtitle = participantName != null && !participantName.trim().isEmpty() ? participantName.trim() : "Meeting keeps running in the background";
        String detail = cameraOff ? "Audio stays live while you multitask." : "Video and audio stay live while you multitask.";

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(detail))
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setSmallIcon(android.R.drawable.presence_video_online)
                .build();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Chalk background meeting", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps Chalk meetings active while the app is in the background");
        manager.createNotificationChannel(channel);
    }
}
