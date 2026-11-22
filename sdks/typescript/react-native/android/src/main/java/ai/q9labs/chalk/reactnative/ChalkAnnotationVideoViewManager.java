package ai.q9labs.chalk.reactnative;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;
import java.util.Collections;
import java.util.Map;

public final class ChalkAnnotationVideoViewManager extends SimpleViewManager<ChalkAnnotationVideoView> {
  @Override public String getName() { return "ChalkAnnotationVideoView"; }

  @Override
  protected ChalkAnnotationVideoView createViewInstance(ThemedReactContext context) {
    return new ChalkAnnotationVideoView(context);
  }

  @ReactProp(name = "trackId")
  public void setTrackId(ChalkAnnotationVideoView view, String trackId) {
    view.trackId = trackId;
  }

  @ReactProp(name = "peerConnectionId", defaultInt = -1)
  public void setPeerConnectionId(ChalkAnnotationVideoView view, int id) {
    view.peerConnectionId = id;
  }

  @ReactProp(name = "sampleFrames")
  public void setSampleFrames(ChalkAnnotationVideoView view, boolean enabled) {
    view.setSampling(enabled);
  }

  @Override
  protected void onAfterUpdateTransaction(ChalkAnnotationVideoView view) {
    super.onAfterUpdateTransaction(view);
    view.bindTrack();
  }

  @Override
  public Map<String, Object> getExportedCustomDirectEventTypeConstants() {
    return Collections.singletonMap("topAnnotationFrame", Collections.singletonMap("registrationName", "onAnnotationFrame"));
  }
}
