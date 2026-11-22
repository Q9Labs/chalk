package ai.q9labs.chalk.reactnative;

import android.graphics.Bitmap;
import android.util.Base64;
import com.cloudflare.realtimekit.WebRTCModule.ChalkWebRTCExecutor;
import com.cloudflare.realtimekit.WebRTCModule.EglUtils;
import com.cloudflare.realtimekit.WebRTCModule.WebRTCModule;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.UIManagerHelper;
import com.facebook.react.uimanager.events.Event;
import java.util.Objects;
import realtimekit.org.webrtc.EglRenderer;
import realtimekit.org.webrtc.RendererCommon;
import realtimekit.org.webrtc.SurfaceViewRenderer;
import realtimekit.org.webrtc.VideoTrack;

/** Displays the screen track itself, so a separate decoder sink cannot retire local ink early. */
final class ChalkAnnotationVideoView extends SurfaceViewRenderer implements RendererCommon.RendererEvents {
  private static final int SAMPLE_SIZE = 256;
  private final ThemedReactContext context;
  private boolean displaying;
  private boolean sampling;
  private int frameSide;
  private EglRenderer.FrameListener reader;
  private volatile long binding;
  private String requestedTrack;
  private int requestedPeer = -1;
  private VideoTrack boundTrack; // WebRTC executor only.
  String trackId;
  int peerConnectionId = -1;

  ChalkAnnotationVideoView(ThemedReactContext context) {
    super(context);
    this.context = context;
    setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
  }

  void setSampling(boolean enabled) {
    sampling = enabled;
    if (enabled) armReader();
    else cancelReader();
  }

  void bindTrack() {
    String id = displaying ? trackId : null;
    int pc = displaying ? peerConnectionId : -1;
    if (Objects.equals(requestedTrack, id) && requestedPeer == pc) return;
    requestedTrack = id;
    requestedPeer = pc;
    long next = ++binding;
    cancelReader();
    frameSide = 0;
    ChalkWebRTCExecutor.execute(() -> {
      if (next != binding) return;
      try {
        if (boundTrack != null) boundTrack.removeSink(this);
      } catch (IllegalStateException ignored) {
        // The peer may already have disposed a replaced remote track.
      }
      boundTrack = null;
      if (id == null || pc < 0) return;
      WebRTCModule webrtc = context.getNativeModule(WebRTCModule.class);
      if (webrtc != null && webrtc.getTrack(pc, id) instanceof VideoTrack video) {
        video.addSink(this);
        boundTrack = video;
      }
    });
  }

  @Override
  protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    init(EglUtils.getRootEglBaseContext(), this);
    displaying = true;
    bindTrack();
  }

  @Override
  protected void onDetachedFromWindow() {
    displaying = false;
    bindTrack();
    cancelReader();
    frameSide = 0;
    release();
    super.onDetachedFromWindow();
  }

  @Override public void onFirstFrameRendered() {}

  @Override
  public void onFrameResolutionChanged(int width, int height, int rotation) {
    post(() -> {
      if (!displaying) return;
      frameSide = Math.max(width, height);
      armReader();
    });
  }

  private void armReader() {
    if (!displaying || !sampling || frameSide <= 0 || reader != null) return;
    long currentBinding = binding;
    reader = new EglRenderer.FrameListener() {
      @Override public void onFrame(Bitmap bitmap) {
        WritableMap pixels = bitmap == null ? null : readSample(bitmap);
        post(() -> {
          if (reader != this) return;
          reader = null;
          if (pixels != null && currentBinding == binding) {
            var dispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, getId());
            if (dispatcher != null) {
              dispatcher.dispatchEvent(new AnnotationFrameEvent(
                  UIManagerHelper.getSurfaceId(ChalkAnnotationVideoView.this), getId(), pixels));
            }
          }
          armReader();
        });
      }
    };
    // One readback at a time, from the on-screen surface's EGL render callback.
    addFrameListener(reader, Math.min(1f, (float) SAMPLE_SIZE / frameSide));
  }

  private void cancelReader() {
    if (reader == null) return;
    removeFrameListener(reader);
    reader = null;
  }

  private static WritableMap readSample(Bitmap bitmap) {
    try {
      int width = bitmap.getWidth();
      int height = bitmap.getHeight();
      if (Math.max(width, height) > SAMPLE_SIZE + 16) return null;
      int[] argb = new int[width * height];
      bitmap.getPixels(argb, 0, width, 0, 0, width, height);
      byte[] rgb = new byte[argb.length * 3];
      for (int i = 0; i < argb.length; i++) {
        rgb[3 * i] = (byte) (argb[i] >> 16);
        rgb[3 * i + 1] = (byte) (argb[i] >> 8);
        rgb[3 * i + 2] = (byte) argb[i];
      }
      WritableMap data = Arguments.createMap();
      data.putInt("width", width);
      data.putInt("height", height);
      data.putString("rgb", Base64.encodeToString(rgb, Base64.NO_WRAP));
      return data;
    } finally {
      bitmap.recycle();
    }
  }

  private static final class AnnotationFrameEvent extends Event<AnnotationFrameEvent> {
    private final WritableMap data;

    AnnotationFrameEvent(int surfaceId, int viewId, WritableMap data) {
      super(surfaceId, viewId);
      this.data = data;
    }

    @Override public String getEventName() { return "topAnnotationFrame"; }
    @Override protected WritableMap getEventData() { return data; }
  }
}
