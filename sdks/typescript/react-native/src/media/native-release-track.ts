const released = new WeakSet<object>();

/**
 * `@cloudflare/react-native-webrtc` `stop()` only marks the track ended in JS. `release()` is what frees the native
 * capture, so a local track needs both. A track is released once, because the idle timer and Leave can both reach it.
 */
export function releaseNativeTrack(track: MediaStreamTrack): void {
  track.stop();
  if (released.has(track) || !("release" in track) || typeof track.release !== "function") return;
  released.add(track);
  track.release();
}
