package ai.q9labs.chalk.reactnative;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.view.OrientationEventListener;
import com.cloudflare.realtimekit.WebRTCModule.AbstractVideoCaptureController;
import com.cloudflare.realtimekit.WebRTCModule.ChalkWebRTCExecutor;
import realtimekit.org.webrtc.CapturerObserver;
import realtimekit.org.webrtc.ScreenCapturerAndroid;
import realtimekit.org.webrtc.SurfaceTextureHelper;
import realtimekit.org.webrtc.VideoFrame;
import realtimekit.org.webrtc.VideoProcessor;
import realtimekit.org.webrtc.VideoCapturer;

final class ChalkScreenCaptureController extends AbstractVideoCaptureController {
  private static final int FPS = 30;

  private final Intent permission;
  private final int serviceToken;
  private final OrientationEventListener legacyOrientation;
  private boolean attempted;
  private boolean closed;
  private RuntimeException startFailure;
  private volatile VideoProcessor processor;
  private CapturerObserver upstream;

  ChalkScreenCaptureController(Context context, int width, int height, Intent permission, int serviceToken) {
    super(width, height, FPS);
    this.permission = permission;
    this.serviceToken = serviceToken;
    legacyOrientation = Build.VERSION.SDK_INT <= Build.VERSION_CODES.TIRAMISU
        ? new OrientationEventListener(context) {
          private boolean landscape = width > height;

          @Override
          public void onOrientationChanged(int degrees) {
            if (degrees == ORIENTATION_UNKNOWN) return;
            int rotation = context.getResources().getConfiguration().orientation;
            boolean nextLandscape = rotation == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
            if (landscape == nextLandscape) return;
            landscape = nextLandscape;
            ChalkWebRTCExecutor.execute(() -> {
              if (closed || startFailure != null) return;
              int shortSide = Math.min(width, height);
              int longSide = Math.max(width, height);
              videoCapturer.changeCaptureFormat(
                  nextLandscape ? longSide : shortSide, nextLandscape ? shortSide : longSide, FPS);
            });
          }
        } : null;
  }

  @Override
  protected VideoCapturer createVideoCapturer() {
    return new ScreenCapturerAndroid(permission, new MediaProjection.Callback() {
      @Override
      public void onStop() {
        ChalkWebRTCExecutor.execute(() -> {
          if (closed) return;
          try {
            stopCapture();
          } finally {
            if (capturerEventsListener != null) capturerEventsListener.onCapturerEnded();
          }
        });
      }
    }) {
      @Override
      public void initialize(SurfaceTextureHelper helper, Context context, CapturerObserver observer) {
        upstream = observer;
        super.initialize(helper, context, new CapturerObserver() {
          @Override public void onCapturerStarted(boolean success) { observer.onCapturerStarted(success); }
          @Override public void onCapturerStopped() {
            observer.onCapturerStopped();
            VideoProcessor current = processor;
            if (current != null) current.onCapturerStopped();
          }
          @Override public void onFrameCaptured(VideoFrame frame) {
            VideoProcessor current = processor;
            if (current == null) observer.onFrameCaptured(frame);
            else current.onFrameCaptured(frame);
          }
        });
      }
    };
  }

  boolean installProcessor(VideoProcessor next) {
    if (closed || upstream == null) return false;
    next.setSink(upstream::onFrameCaptured);
    processor = next;
    return true;
  }

  @Override
  public void startCapture() {
    if (attempted || closed) return;
    attempted = true;
    try {
      videoCapturer.startCapture(getWidth(), getHeight(), FPS);
      if (legacyOrientation != null) legacyOrientation.enable();
    } catch (RuntimeException failure) {
      // The peer registers this track before calling startCapture. Return it so the caller
      // can release it through WebRTC's normal track-disposal path.
      startFailure = failure;
    }
  }

  RuntimeException getStartFailure() {
    return startFailure;
  }

  @Override
  public boolean stopCapture() {
    if (closed) return true;
    closed = true;
    if (legacyOrientation != null) legacyOrientation.disable();
    try {
      return !attempted || super.stopCapture();
    } finally {
      ChalkScreenProjectionService.release(serviceToken);
    }
  }

  @Override
  public void dispose() {
    try {
      stopCapture();
    } finally {
      super.dispose();
    }
  }
}
