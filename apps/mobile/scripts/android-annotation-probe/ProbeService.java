package ai.chalk.probe;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

public final class ProbeService extends Service {
    private static final String TAG = "ChalkProjectionProbe";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private WindowManager windows;
    private View overlay;
    private String pendingSample;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (projection != null) return START_NOT_STICKY;
        var consent = intent == null ? null : intent.getParcelableExtra("consent", Intent.class);
        if (consent == null || !Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(TAG, "Capture probe", NotificationManager.IMPORTANCE_LOW)
        );
        startForeground(1, new Notification.Builder(this, TAG)
            .setSmallIcon(android.R.drawable.ic_menu_camera).setContentTitle("Chalk capture probe").build());

        windows = getSystemService(WindowManager.class);
        var bounds = windows.getMaximumWindowMetrics().getBounds();
        var density = getResources().getConfiguration().densityDpi;
        reader = ImageReader.newInstance(bounds.width(), bounds.height(), PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::sample, handler);
        projection = getSystemService(MediaProjectionManager.class).getMediaProjection(Activity.RESULT_OK, consent);
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { stopSelf(); }
            @Override public void onCapturedContentResize(int width, int height) {
                Log.i(TAG, "capture=" + width + "x" + height);
            }
            @Override public void onCapturedContentVisibilityChanged(boolean visible) {
                Log.i(TAG, "visible=" + visible);
            }
        }, handler);
        display = projection.createVirtualDisplay("Chalk probe", bounds.width(), bounds.height(), density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
        handler.post(this::checkPermission);

        // Switch to the separate Chalk Capture Target before the first sample.
        phase("baseline", 15_000, false, false);
        phase("ordinary", 20_000, true, false);
        phase("secure", 27_000, true, true);
        phase("restored", 34_000, false, false);
        phase("permission-check", 40_000, true, false);
        return START_NOT_STICKY;
    }

    private void checkPermission() {
        if (!Settings.canDrawOverlays(this)) {
            removeOverlay();
            Log.i(TAG, "permission revoked; overlay removed");
            stopSelf();
            return;
        }
        handler.postDelayed(this::checkPermission, 250);
    }

    private void phase(String name, int delay, boolean shown, boolean secure) {
        handler.postDelayed(() -> {
            removeOverlay();
            if (shown) {
                int size = Math.round(100 * getResources().getDisplayMetrics().density);
                var params = new WindowManager.LayoutParams(size, size,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | (secure ? WindowManager.LayoutParams.FLAG_SECURE : 0),
                    PixelFormat.TRANSLUCENT);
                params.gravity = Gravity.CENTER;
                params.alpha = .75f;
                params.setFitInsetsTypes(0);
                var mark = new View(this);
                mark.setBackgroundColor(Color.MAGENTA);
                try {
                    windows.addView(mark, params);
                    overlay = mark;
                } catch (WindowManager.BadTokenException | SecurityException unavailable) {
                    Log.w(TAG, "overlay was not shown", unavailable);
                    stopSelf();
                    return;
                }
            }
            Log.i(TAG, "phase=" + name);
            handler.postDelayed(() -> pendingSample = name, 1_000);
        }, delay);
    }

    private void sample(ImageReader source) {
        try (var image = source.acquireLatestImage()) {
            if (image == null || pendingSample == null) return;
            var name = pendingSample;
            pendingSample = null;
            var plane = image.getPlanes()[0];
            var bitmap = Bitmap.createBitmap(plane.getRowStride() / plane.getPixelStride(),
                image.getHeight(), Bitmap.Config.ARGB_8888);
            bitmap.copyPixelsFromBuffer(plane.getBuffer());

            try (var file = openFileOutput(name + ".png", MODE_PRIVATE)) {
                var cropped = Bitmap.createBitmap(bitmap, 0, 0, image.getWidth(), image.getHeight());
                cropped.compress(Bitmap.CompressFormat.PNG, 100, file);
                if (cropped != bitmap) cropped.recycle();
                Log.i(TAG, name + " center=" + Integer.toHexString(bitmap.getPixel(image.getWidth() / 2, image.getHeight() / 2)));
            } catch (java.io.IOException error) {
                Log.e(TAG, "capture sample failed", error);
            } finally {
                bitmap.recycle();
            }
        }
    }

    private void removeOverlay() {
        if (overlay != null) {
            windows.removeViewImmediate(overlay);
            overlay = null;
        }
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        removeOverlay();
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (projection != null) projection.stop();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
