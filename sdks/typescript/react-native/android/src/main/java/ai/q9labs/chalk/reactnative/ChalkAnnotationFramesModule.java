package ai.q9labs.chalk.reactnative;

import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.os.Handler;
import android.os.Looper;

import com.cloudflare.realtimekit.WebRTCModule.ChalkAnnotationTracks;
import com.cloudflare.realtimekit.WebRTCModule.WebRTCModule;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;
import org.webrtc.VideoTrack;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ChalkAnnotationFramesModule extends ReactContextBaseJavaModule {
  private static final int MAX_PIXELS = 4096 * 4096;
  private final ReactApplicationContext context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final HashMap<String, Observation> observers = new HashMap<>();
  private final java.util.concurrent.ExecutorService encoder = Executors.newSingleThreadExecutor();
  private final AtomicBoolean encoding = new AtomicBoolean();
  private boolean closed;

  public ChalkAnnotationFramesModule(ReactApplicationContext context) {
    super(context);
    this.context = context;
  }

  @Override public String getName() { return "ChalkAnnotationFrames"; }

  @ReactMethod
  public void observe(String key, String streamUrl) {
    main.post(() -> {
      if (closed) return;
      remove(key);
      var track = ChalkAnnotationTracks.firstVideo(context.getNativeModule(WebRTCModule.class), streamUrl);
      if (track == null) return;
      var observation = new Observation(key, track);
      observers.put(key, observation);
      track.addSink(observation);
    });
  }

  @ReactMethod
  public void stop(String key) {
    main.post(() -> remove(key));
  }

  @ReactMethod
  public void capture(String key, int width, int height, Promise promise) {
    main.post(() -> {
      var observation = observers.get(key);
      var frame = observation == null ? null : observation.retainFrame(width, height);
      if (frame == null) {
        promise.resolve(null);
        return;
      }
      if (!encoding.compareAndSet(false, true)) {
        frame.release();
        promise.resolve(null);
        return;
      }
      try {
        encoder.execute(() -> {
          try {
            promise.resolve(encode(frame));
          } catch (RuntimeException | IOException error) {
            promise.reject("annotation_frame_capture", error);
          } finally {
            frame.release();
            encoding.set(false);
          }
        });
      } catch (RejectedExecutionException error) {
        frame.release();
        encoding.set(false);
        promise.resolve(null);
      }
    });
  }

  private String encode(VideoFrame frame) throws IOException {
    var yuv = frame.getBuffer().toI420();
    if (yuv == null) throw new IOException("Unable to read video frame");
    Bitmap bitmap = null;
    Bitmap rotated = null;
    File output = null;
    try {
      int width = yuv.getWidth();
      int height = yuv.getHeight();
      if (width <= 0 || height <= 0 || (long) width * height > MAX_PIXELS) throw new IOException("Frame is too large");
      var y = yuv.getDataY();
      var u = yuv.getDataU();
      var v = yuv.getDataV();
      var pixels = new int[width * height];
      for (int row = 0; row < height; row++) {
        int yIndex = row * yuv.getStrideY();
        int uIndex = row / 2 * yuv.getStrideU();
        int vIndex = row / 2 * yuv.getStrideV();
        for (int column = 0; column < width; column++) {
          int luma = Math.max(0, (y.get(yIndex + column) & 0xff) - 16);
          int cb = (u.get(uIndex + column / 2) & 0xff) - 128;
          int cr = (v.get(vIndex + column / 2) & 0xff) - 128;
          int red = channel(298 * luma + 409 * cr);
          int green = channel(298 * luma - 100 * cb - 208 * cr);
          int blue = channel(298 * luma + 516 * cb);
          pixels[row * width + column] = 0xff000000 | (red << 16) | (green << 8) | blue;
        }
      }
      bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888);
      var matrix = new Matrix();
      matrix.postRotate(frame.getRotation());
      rotated = Bitmap.createBitmap(bitmap, 0, 0, width, height, matrix, false);
      output = File.createTempFile("chalk-annotation-", ".png", context.getCacheDir());
      try (var stream = new FileOutputStream(output)) {
        if (!rotated.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IOException("PNG encoding failed");
      }
      var uri = android.net.Uri.fromFile(output).toString();
      output = null;
      return uri;
    } finally {
      if (output != null) output.delete();
      if (rotated != null && rotated != bitmap) rotated.recycle();
      if (bitmap != null) bitmap.recycle();
      yuv.release();
    }
  }

  private static int channel(int scaled) {
    return Math.max(0, Math.min(255, (scaled + 128) >> 8));
  }

  private void remove(String key) {
    var observation = observers.remove(key);
    if (observation != null) observation.close();
  }

  @Override public void invalidate() {
    main.post(() -> {
      closed = true;
      for (var observer : observers.values()) observer.close();
      observers.clear();
      encoder.shutdown();
    });
    super.invalidate();
  }

  private final class Observation implements VideoSink {
    private final String key;
    private final VideoTrack track;
    private VideoFrame frame;
    private boolean stopped;
    private int width;
    private int height;

    Observation(String key, VideoTrack track) {
      this.key = key;
      this.track = track;
    }

    @Override public synchronized void onFrame(VideoFrame next) {
      if (stopped) return;
      next.retain();
      if (frame != null) frame.release();
      frame = next;
      int w = next.getRotatedWidth();
      int h = next.getRotatedHeight();
      if (width == w && height == h) return;
      width = w;
      height = h;
      main.post(() -> {
        if (observers.get(key) != this || !context.hasActiveReactInstance()) return;
        var data = Arguments.createMap();
        data.putString("key", key);
        data.putInt("width", w);
        data.putInt("height", h);
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("chalkAnnotationFrameSize", data);
      });
    }

    synchronized VideoFrame retainFrame(int expectedWidth, int expectedHeight) {
      if (frame == null || width != expectedWidth || height != expectedHeight) return null;
      frame.retain();
      return frame;
    }

    void close() {
      track.removeSink(this);
      synchronized (this) {
        stopped = true;
        if (frame != null) frame.release();
        frame = null;
      }
    }
  }
}
