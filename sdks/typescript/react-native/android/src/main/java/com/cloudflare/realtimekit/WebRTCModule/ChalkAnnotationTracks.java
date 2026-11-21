package com.cloudflare.realtimekit.WebRTCModule;

import org.webrtc.VideoTrack;

/** One adapter for the react-native-webrtc stream URL used by the stock RTCView. */
public final class ChalkAnnotationTracks {
  private ChalkAnnotationTracks() {}

  public static VideoTrack firstVideo(WebRTCModule module, String streamUrl) {
    var stream = module == null ? null : module.getStreamForReactTag(streamUrl);
    return stream == null || stream.videoTracks.isEmpty() ? null : stream.videoTracks.get(0);
  }
}
