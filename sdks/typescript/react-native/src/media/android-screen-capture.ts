import { MediaStreamTrack } from "@cloudflare/react-native-webrtc";
import { AppRegistry, NativeModules } from "react-native";

let projectionTaskRegistered = false;

type ScreenCaptureModule = {
  capture(): Promise<ConstructorParameters<typeof MediaStreamTrack>[0]>;
};

export async function captureAndroidScreen(): Promise<globalThis.MediaStream> {
  const native = NativeModules.ChalkScreenCapture as ScreenCaptureModule | undefined;
  if (!native) throw new Error("Rebuild the Android app with Chalk's native screen capture module");

  try {
    if (!projectionTaskRegistered) {
      // The native service ends this task with the capture. While the shared
      // app is in front, React Native must still run call and SFU timers.
      AppRegistry.registerHeadlessTask("ChalkScreenProjection", () => () => new Promise<void>(() => {}));
      projectionTaskRegistered = true;
    }
    const track = new MediaStreamTrack(await native.capture());
    // Only the track is published. Do not allocate an otherwise unused WebRTC stream in native memory.
    return {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    } as unknown as globalThis.MediaStream;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "NotAllowedError") cause.name = cause.code;
    throw cause;
  }
}
