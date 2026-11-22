package com.cloudflare.realtimekit.WebRTCModule;

/** Serialize local track creation with WebRTC's other accesses to its track registry. */
public final class ChalkWebRTCExecutor {
  private ChalkWebRTCExecutor() {}

  public static void execute(Runnable work) {
    // createVideoTrack is public, but 125.x does not expose its executor outside this package.
    ThreadUtils.runOnExecutor(work);
  }
}
