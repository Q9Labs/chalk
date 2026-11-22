package ai.q9labs.chalk.reactnative;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Point;
import android.graphics.Rect;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.Log;
import com.cloudflare.realtimekit.WebRTCModule.ChalkWebRTCExecutor;
import com.cloudflare.realtimekit.WebRTCModule.WebRTCModule;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;
import java.util.concurrent.atomic.AtomicBoolean;
import realtimekit.org.webrtc.VideoTrack;

public final class ChalkScreenCaptureModule extends ReactContextBaseJavaModule {
  private static final int PERMISSION_REQUEST = 14683;

  private final ReactApplicationContext context;
  private final AtomicBoolean invalidated = new AtomicBoolean();
  // The prompt and its promise are owned by the UI thread; WebRTC owns the capture thread.
  private Promise pending;
  private String activeTrackId;
  private final BaseActivityEventListener listener = new BaseActivityEventListener() {
    @Override
    public void onActivityResult(Activity activity, int request, int result, Intent permission) {
      if (request != PERMISSION_REQUEST || pending == null) return;
      if (result != Activity.RESULT_OK || permission == null) {
        finish(pending, null, "NotAllowedError", "Screen sharing permission was denied");
        return;
      }

      Promise capture = pending;
      Point dimensions = captureDimensions(activity);
      // Android 14+ requires consent first, then a foreground service, then getMediaProjection.
      ChalkScreenProjectionService.start(context, token -> {
        if (token == 0) {
          finish(capture, null, "CaptureFailed", "Unable to start Android screen sharing");
        } else if (invalidated.get()) {
          ChalkScreenProjectionService.release(token);
        } else {
          ChalkWebRTCExecutor.execute(() -> startTrack(capture, dimensions, permission, token));
        }
      });
    }
  };

  ChalkScreenCaptureModule(ReactApplicationContext context) {
    super(context);
    this.context = context;
    context.addActivityEventListener(listener);
  }

  @Override
  public String getName() {
    return "ChalkScreenCapture";
  }

  @ReactMethod
  public void capture(Promise result) {
    UiThreadUtil.runOnUiThread(() -> {
      Activity activity = context.getCurrentActivity();
      if (activity == null || invalidated.get() || pending != null) {
        result.reject("CaptureUnavailable", "Screen sharing needs an active app and one permission prompt");
        return;
      }
      pending = result;
      try {
        MediaProjectionManager manager = activity.getSystemService(MediaProjectionManager.class);
        activity.startActivityForResult(manager.createScreenCaptureIntent(), PERMISSION_REQUEST);
      } catch (RuntimeException failure) {
        finish(result, null, "CaptureFailed", "Unable to request Android screen sharing");
      }
    });
  }

  @Override
  public void invalidate() {
    invalidated.set(true);
    context.removeActivityEventListener(listener);
    UiThreadUtil.runOnUiThread(() -> {
      if (pending != null) finish(pending, null, "CaptureUnavailable", "The app closed during screen sharing");
    });
    ChalkWebRTCExecutor.execute(() -> {
      WebRTCModule rtc = context.getNativeModule(WebRTCModule.class);
      if (rtc != null && activeTrackId != null) rtc.mediaStreamTrackRelease(activeTrackId);
      activeTrackId = null;
    });
    super.invalidate();
  }

  private void startTrack(Promise result, Point size, Intent permission, int token) {
    WebRTCModule rtc = context.getNativeModule(WebRTCModule.class);
    ChalkScreenCaptureController controller =
        new ChalkScreenCaptureController(context, size.x, size.y, permission, token);
    VideoTrack track = null;
    try {
      if (rtc != null && !invalidated.get()) track = rtc.createVideoTrack(controller);
      if (track == null || controller.getStartFailure() != null || invalidated.get()) {
        if (controller.getStartFailure() != null) throw controller.getStartFailure();
        throw new IllegalStateException("Screen track unavailable");
      }

      activeTrackId = track.id();
      WritableMap info = Arguments.createMap();
      info.putString("id", activeTrackId);
      info.putString("kind", "video");
      info.putString("readyState", "live");
      info.putBoolean("remote", false);
      info.putBoolean("enabled", true);
      info.putInt("peerConnectionId", -1);
      info.putMap("constraints", Arguments.createMap());
      WritableMap settings = Arguments.createMap();
      settings.putInt("width", size.x);
      settings.putInt("height", size.y);
      settings.putInt("frameRate", controller.getFrameRate());
      info.putMap("settings", settings);
      UiThreadUtil.runOnUiThread(() -> finish(result, info, null, null));
    } catch (RuntimeException failure) {
      if (track != null) rtc.mediaStreamTrackRelease(track.id());
      else controller.dispose();
      Log.w("ChalkScreenProjection", "Unable to start screen capture", failure);
      UiThreadUtil.runOnUiThread(() -> finish(result, null, "CaptureFailed", "Unable to capture the Android screen"));
    }
  }

  private void finish(Promise result, WritableMap info, String code, String message) {
    if (pending != result) return;
    pending = null;
    if (code == null) result.resolve(info);
    else result.reject(code, message);
  }

  private static Point captureDimensions(Activity activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Rect bounds = activity.getWindowManager().getMaximumWindowMetrics().getBounds();
      return new Point(bounds.width(), bounds.height());
    }
    Point point = new Point();
    activity.getWindowManager().getDefaultDisplay().getRealSize(point);
    return point;
  }
}
