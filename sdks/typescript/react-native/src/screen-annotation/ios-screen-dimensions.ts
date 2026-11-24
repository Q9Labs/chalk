import type { ScreenAnnotationFrameSize } from "@q9labsai/chalk-client";
import { NativeEventEmitter, NativeModules } from "react-native";

type FrameObserver = {
  observe(key: string, streamUrl: string): void;
  stop(key: string): void;
  addListener(event: string): void;
  removeListeners(count: number): void;
};

// WebRTC's iOS getDisplayMedia returns no track settings. Use the first ReplayKit
// frame for geometry only; unlike the Android witness this never enables burn-in.
export function observeIOSScreenDimensions(track: MediaStreamTrack, streamUrl: string): () => void {
  const frames = NativeModules.ChalkAnnotationFrames as FrameObserver | undefined;
  if (!frames) return () => {};

  const key = track.id;
  const getSettings = track.getSettings.bind(track);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    subscription.remove();
    frames.stop(key);
  };
  const subscription = new NativeEventEmitter(frames).addListener("chalkAnnotationFrameSize", (event: ScreenAnnotationFrameSize & { readonly key: string }) => {
    if (event.key !== key || event.width <= 0 || event.height <= 0) return;
    const { width, height } = event;
    track.getSettings = () => ({ ...getSettings(), width, height });
    stop();
  });
  frames.observe(key, streamUrl);
  return stop;
}
