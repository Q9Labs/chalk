package ai.q9labs.chalk.reactnative;

import android.app.Activity;
import android.app.AppOpsManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.cloudflare.realtimekit.WebRTCModule.WebRTCModule;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.lang.reflect.Method;
import java.security.SecureRandom;
import java.util.function.Consumer;

import realtimekit.org.webrtc.VideoFrame;
import realtimekit.org.webrtc.VideoProcessor;
import realtimekit.org.webrtc.VideoSink;

/** Owns one display overlay, and ties its lifetime to the exact native screen track. */
public final class ChalkAnnotationOverlayModule extends ReactContextBaseJavaModule {
  private static final String ASSET = "file:///android_asset/chalk-annotation/index.html";
  private static final int SETTINGS_REQUEST = 5921;
  private static final int PROBE_MS = 1800;
  private final ReactApplicationContext context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final SecureRandom random = new SecureRandom();
  private final AppOpsManager appOps;
  private WindowManager windows;
  private FrameLayout overlay;
  private WebView renderer;
  private Session session;
  private Promise permission;
  private String protectedTrack;
  private Window protectedWindow;
  private boolean previouslySecure;
  private boolean watching;
  private final AppOpsManager.OnOpChangedListener permissionWatcher = (op, name) ->
      main.post(() -> {
        if (session != null && !Settings.canDrawOverlays(getReactApplicationContext())) remove(session, true);
      });

  private final BaseActivityEventListener settingsResult = new BaseActivityEventListener() {
    @Override public void onActivityResult(Activity activity, int request, int result, Intent data) {
      if (request != SETTINGS_REQUEST || permission == null) return;
      Promise pending = permission;
      permission = null;
      pending.resolve(Settings.canDrawOverlays(context));
    }
  };

  public ChalkAnnotationOverlayModule(ReactApplicationContext context) {
    super(context);
    this.context = context;
    this.appOps = context.getSystemService(AppOpsManager.class);
    context.addActivityEventListener(settingsResult);
  }

  @Override public String getName() { return "ChalkAnnotationOverlay"; }

  @ReactMethod public void hasPermission(Promise promise) {
    promise.resolve(Settings.canDrawOverlays(context));
  }

  @ReactMethod public void requestPermission(Promise promise) {
    main.post(() -> {
      Activity activity = getCurrentActivity();
      if (activity == null || permission != null) {
        promise.resolve(false);
        return;
      }
      permission = promise;
      try {
        activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + context.getPackageName())), SETTINGS_REQUEST);
      } catch (RuntimeException error) {
        permission = null;
        promise.resolve(false);
      }
    });
  }

  @ReactMethod public void protectControls(String trackId, Promise promise) {
    main.post(() -> {
      Activity activity = getCurrentActivity();
      if (activity == null) {
        promise.resolve(false);
        return;
      }
      clearProtection();
      protectedTrack = trackId;
      protectedWindow = activity.getWindow();
      previouslySecure = (protectedWindow.getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0;
      protectedWindow.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
      promise.resolve(true);
    });
  }

  private void clearProtection() {
    if (protectedWindow != null && !previouslySecure) protectedWindow.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    protectedWindow = null;
    protectedTrack = null;
  }

  @ReactMethod public void probe(String trackId, Promise promise) {
    main.post(() -> {
      if (session != null) remove(session, true);
      if (!Settings.canDrawOverlays(context) || getCurrentActivity() == null) {
        promise.resolve(null);
        return;
      }
      Session next = new Session(trackId, promise);
      session = next;
      try {
        createOverlay(next);
        installProcessor(next, (installed) -> main.post(() -> {
          if (!installed && session == next) remove(next, false);
        }));
        main.postDelayed(() -> {
          if (session == next && !next.verified) remove(next, false);
        }, PROBE_MS);
      } catch (RuntimeException error) {
        remove(next, false);
      }
    });
  }

  @ReactMethod public void render(String trackId, String sceneJson, String presenceJson, double nowMs, boolean active) {
    main.post(() -> {
      Session current = session;
      if (current == null || !current.trackId.equals(trackId) || !current.verified || renderer == null) return;
      if (!Settings.canDrawOverlays(context)) {
        remove(current, true);
        return;
      }
      if (!active) {
        current.hold = current.activated;
        current.resumeId++;
      }
      renderer.evaluateJavascript("window.chalkAnnotationSystemOverlay?.(" + sceneJson + "," + presenceJson + "," + nowMs + ");", null);
      if (active && (current.hold || !current.activated)) {
        current.activated = true;
        current.hold = true;
        long resumeId = ++current.resumeId;
        renderer.postVisualStateCallback(resumeId, new WebView.VisualStateCallback() {
          @Override public void onComplete(long id) {
            if (session == current && current.resumeId == id) current.hold = false;
          }
        });
      }
    });
  }

  @ReactMethod public void stop(String trackId) {
    main.post(() -> {
      if (session != null && session.trackId.equals(trackId)) remove(session, false);
      if (trackId.equals(protectedTrack)) clearProtection();
    });
  }

  @ReactMethod public void addListener(String event) {}
  @ReactMethod public void removeListeners(int count) {}

  @Override public void invalidate() {
    context.removeActivityEventListener(settingsResult);
    main.post(() -> {
      if (permission != null) {
        permission.resolve(false);
        permission = null;
      }
      if (session != null) remove(session, false);
      clearProtection();
    });
    super.invalidate();
  }

  private void createOverlay(Session next) {
    Activity activity = getCurrentActivity();
    if (activity == null) throw new IllegalStateException("No Chalk activity");
    windows = activity.getSystemService(WindowManager.class);
    overlay = new FrameLayout(activity);
    overlay.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    WindowManager.LayoutParams params = new WindowManager.LayoutParams(
        WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT);
    params.gravity = Gravity.TOP | Gravity.LEFT;
    if (Build.VERSION.SDK_INT >= 30) {
      params.setFitInsetsTypes(0);
      params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
    }
    // Android rejects input through an untrusted application overlay above this opacity.
    params.alpha = 0.8f;
    renderer = new WebView(activity);
    renderer.setBackgroundColor(Color.TRANSPARENT);
    renderer.getSettings().setJavaScriptEnabled(true);
    renderer.getSettings().setAllowContentAccess(false);
    renderer.setWebViewClient(new WebViewClient() {
      @Override public void onPageFinished(WebView view, String url) {
        if (!ASSET.equals(url)) return;
        view.evaluateJavascript("typeof window.chalkAnnotationSystemOverlay === 'function'",
            (ready) -> next.rendererReady = "true".equals(ready));
      }

      @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        if (session == next) remove(next, true);
        return true;
      }

      @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
        return !ASSET.equals(request.getUrl().toString());
      }
    });
    overlay.addView(renderer, new FrameLayout.LayoutParams(-1, -1));
    renderer.loadUrl(ASSET);

    View marker = new View(activity) {
      private final Paint paint = new Paint();
      @Override protected void onSizeChanged(int w, int h, int oldWidth, int oldHeight) {
        if (next.verified) {
          main.post(() -> { if (session == next) remove(next, true); });
        } else if (w > 0 && h > 0) {
          next.witness = new ChalkProjectionWitness(random.nextInt(), w, h, Math.max(8, w / 100));
        }
      }
      @Override protected void onDraw(Canvas canvas) {
        ChalkProjectionWitness witness = next.witness;
        if (witness == null) return;
        for (int anchor = 0; anchor < 2; anchor++) {
          for (int column = 0; column < ChalkProjectionWitness.CELLS; column++) {
            paint.setColor(witness.white(anchor, column) ? Color.WHITE : Color.BLACK);
            int x = witness.x(anchor) + column * Math.max(8, getWidth() / 100);
            int y = witness.y(anchor);
            canvas.drawRect(x, y, x + Math.max(8, getWidth() / 100), y + Math.max(8, getWidth() / 100), paint);
          }
        }
      }
    };
    next.marker = marker;
    overlay.addView(marker, new FrameLayout.LayoutParams(-1, -1));
    windows.addView(overlay, params);
    appOps.startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, context.getPackageName(), permissionWatcher);
    watching = true;
  }

  // An unpatched SDK host can still use the normal data layer.
  private void installProcessor(Session target, Consumer<Boolean> completion) {
    WebRTCModule rtc = context.getNativeModule(WebRTCModule.class);
    if (rtc == null) { completion.accept(false); return; }
    try {
      Method install = rtc.getClass().getMethod("setChalkScreenVideoProcessor", String.class, VideoProcessor.class, Consumer.class);
      install.invoke(rtc, target.trackId, target, completion);
    } catch (ReflectiveOperationException error) {
      completion.accept(false);
    }
  }

  private void remove(Session target, boolean lost) {
    session = null;
    target.finished = true;
    if (watching) {
      appOps.stopWatchingMode(permissionWatcher);
      watching = false;
    }
    if (overlay != null) {
      if (overlay.isAttachedToWindow()) windows.removeViewImmediate(overlay);
      overlay.removeAllViews();
      overlay = null;
    }
    if (renderer != null) {
      renderer.destroy();
      renderer = null;
    }
    if (!target.verified) target.result.resolve(null);
    if (lost && target.verified && context.hasActiveReactInstance()) {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("chalkAnnotationOverlayLost", target.trackId);
    }
  }

  private final class Session implements VideoProcessor {
    final String trackId;
    final Promise result;
    volatile ChalkProjectionWitness witness;
    volatile VideoSink sink;
    volatile boolean rendererReady;
    volatile boolean verified;
    volatile boolean finished;
    volatile boolean hold;
    volatile int width;
    volatile int height;
    boolean activated;
    long resumeId;
    View marker;
    private ChalkProjectionWitness firstMatch;
    private boolean revealed;

    Session(String trackId, Promise result) { this.trackId = trackId; this.result = result; }
    @Override public void setSink(VideoSink sink) { this.sink = sink; }
    @Override public void onCapturerStarted(boolean success) {}
    @Override public void onCapturerStopped() {
      main.post(() -> { if (session == this) remove(this, true); });
    }
    @Override public void onFrameCaptured(VideoFrame frame) {
      VideoSink target = sink;
      if (finished || verified) {
        // A verified capture is immutable. Losing its overlay stops this
        // publication rather than sending clean frames under a baked binding.
        if (verified && (frame.getRotatedWidth() != width || frame.getRotatedHeight() != height)) {
          main.post(() -> { if (session == this) remove(this, true); });
          return;
        }
        if (target != null && !hold && !(finished && verified)) target.onFrame(frame);
        return;
      }
      ChalkProjectionWitness expected = witness;
      if (expected == null) return;
      VideoFrame.I420Buffer buffer = frame.getBuffer().toI420();
      if (buffer == null) return;
      boolean containsMarker;
      try {
        containsMarker = expected.matches(buffer.getDataY(), buffer.getStrideY(), buffer.getWidth(), buffer.getHeight(), frame.getRotation());
      } finally {
        buffer.release();
      }
      if (containsMarker && firstMatch == null) {
        firstMatch = expected;
        main.post(() -> {
          if (session != this) return;
          witness = new ChalkProjectionWitness(random.nextInt(), overlay.getWidth(), overlay.getHeight(), Math.max(8, overlay.getWidth() / 100));
          marker.invalidate();
        });
        return;
      }
      if (firstMatch != null && firstMatch != expected && containsMarker && !revealed) {
        revealed = true;
        main.post(() -> { if (session == this) marker.setVisibility(View.INVISIBLE); });
        return;
      }
      if (revealed && !containsMarker && rendererReady) {
        int frameWidth = frame.getRotatedWidth();
        int frameHeight = frame.getRotatedHeight();
        main.post(() -> {
          if (session != this || verified) return;
          width = frameWidth;
          height = frameHeight;
          verified = true;
          var size = Arguments.createMap();
          size.putInt("width", width);
          size.putInt("height", height);
          result.resolve(size);
        });
      }
    }
  }
}
