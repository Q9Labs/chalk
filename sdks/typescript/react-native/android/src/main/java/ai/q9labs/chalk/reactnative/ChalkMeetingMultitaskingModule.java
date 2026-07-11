package ai.q9labs.chalk.reactnative;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Rational;
import android.view.View;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.module.annotations.ReactModule;

@ReactModule(name = ChalkMeetingMultitaskingModule.NAME)
public class ChalkMeetingMultitaskingModule extends ReactContextBaseJavaModule {
    public static final String NAME = "ChalkMeetingMultitasking";
    private static final Rational DEFAULT_ASPECT_RATIO = new Rational(16, 9);

    public ChalkMeetingMultitaskingModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    @ReactMethod
    public void isPictureInPictureSupported(Promise promise) {
        Activity activity = getCurrentActivity();
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && activity != null
                && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
        promise.resolve(supported);
    }

    @ReactMethod
    public void isPictureInPictureActive(Promise promise) {
        Activity activity = getCurrentActivity();
        boolean active = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity != null && activity.isInPictureInPictureMode();
        promise.resolve(active);
    }

    @ReactMethod
    public void setPictureInPictureEnabled(boolean enabled, Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            promise.resolve(null);
            return;
        }

        activity.runOnUiThread(() -> {
            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(DEFAULT_ASPECT_RATIO);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(enabled);
                View decorView = activity.getWindow() != null ? activity.getWindow().getDecorView() : null;
                if (decorView != null) {
                    builder.setSeamlessResizeEnabled(true);
                }
            }
            activity.setPictureInPictureParams(builder.build());
            promise.resolve(null);
        });
    }

    @ReactMethod
    public void updatePictureInPictureConfig(ReadableMap config, Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            promise.resolve(null);
            return;
        }

        activity.runOnUiThread(() -> {
            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(DEFAULT_ASPECT_RATIO);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(true);
                builder.setSeamlessResizeEnabled(true);
            }
            activity.setPictureInPictureParams(builder.build());
            promise.resolve(null);
        });
    }

    @ReactMethod
    public void startPictureInPicture(Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            promise.resolve(null);
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                activity.enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(DEFAULT_ASPECT_RATIO).build());
            } catch (IllegalStateException error) {
                // Ignore transient cases where Android has already started the transition.
            }
            promise.resolve(null);
        });
    }

    @ReactMethod
    public void stopPictureInPicture(Promise promise) {
        promise.resolve(null);
    }

    @ReactMethod
    public void startBackgroundMode(ReadableMap config, Promise promise) {
        Context context = getReactApplicationContext();
        Intent intent = new Intent(context, ChalkMeetingForegroundService.class);
        intent.setAction(ChalkMeetingForegroundService.ACTION_START);
        if (config.hasKey("roomName")) {
            intent.putExtra(ChalkMeetingForegroundService.EXTRA_ROOM_NAME, config.getString("roomName"));
        }
        if (config.hasKey("participantName")) {
            intent.putExtra(ChalkMeetingForegroundService.EXTRA_PARTICIPANT_NAME, config.getString("participantName"));
        }
        if (config.hasKey("cameraOff")) {
            intent.putExtra(ChalkMeetingForegroundService.EXTRA_CAMERA_OFF, config.getBoolean("cameraOff"));
        }

        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException error) {
            promise.resolve(null);
            return;
        }

        promise.resolve(null);
    }

    @ReactMethod
    public void stopBackgroundMode(Promise promise) {
        Context context = getReactApplicationContext();
        Intent intent = new Intent(context, ChalkMeetingForegroundService.class);
        intent.setAction(ChalkMeetingForegroundService.ACTION_STOP);
        context.stopService(intent);
        promise.resolve(null);
    }
}
