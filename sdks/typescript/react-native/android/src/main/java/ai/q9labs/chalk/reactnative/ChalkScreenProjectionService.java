package ai.q9labs.chalk.reactnative;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ResultReceiver;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.function.IntConsumer;

public final class ChalkScreenProjectionService extends Service {
  private static final String CHANNEL = "chalk-screen-projection";
  private static final String RECEIVER = "foreground_ready";
  private static final int NOTIFICATION_ID = 14683;
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static ChalkScreenProjectionService active;
  private static int nextToken;

  private int token;
  private int latestStartId;

  static void start(Context context, IntConsumer ready) {
    ResultReceiver receiver = new ResultReceiver(MAIN) {
      @Override
      protected void onReceiveResult(int resultCode, Bundle ignored) {
        ready.accept(resultCode);
      }
    };
    try {
      ContextCompat.startForegroundService(
          context, new Intent(context, ChalkScreenProjectionService.class).putExtra(RECEIVER, receiver));
    } catch (RuntimeException failure) {
      Log.w("ChalkScreenProjection", "Unable to start service", failure);
      ready.accept(0);
    }
  }

  static void release(int token) {
    MAIN.post(() -> {
      ChalkScreenProjectionService owner = active;
      if (owner != null && owner.token == token) owner.stopSelfResult(owner.latestStartId);
    });
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    @SuppressWarnings("deprecation")
    ResultReceiver receiver = intent == null ? null : intent.getParcelableExtra(RECEIVER);
    if (receiver == null) {
      stopSelfResult(startId);
      return START_NOT_STICKY;
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
      }
      Notification notification = new NotificationCompat.Builder(this, CHANNEL)
          .setContentTitle(getApplicationInfo().loadLabel(getPackageManager()))
          .setContentText("Sharing your screen")
          .setSmallIcon(android.R.drawable.ic_menu_camera)
          .setOngoing(true)
          .build();
      ServiceCompat.startForeground(
          this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
      active = this;
      latestStartId = startId;
      token = ++nextToken;
      receiver.send(token, null);
    } catch (RuntimeException failure) {
      Log.w("ChalkScreenProjection", "Unable to enter foreground", failure);
      stopSelfResult(startId);
      receiver.send(0, null);
    }
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    if (active == this) active = null;
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
