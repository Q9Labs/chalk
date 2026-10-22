import { mediaDevices } from "@cloudflare/react-native-webrtc";
import { NativeModules, Platform } from "react-native";

type ScreenCaptureModule = { readonly start: (trackId: string) => Promise<void> };

export async function getNativeDisplayMedia(): Promise<globalThis.MediaStream> {
  const stream = await mediaDevices.getDisplayMedia();
  try {
    if (Platform.OS === "ios") {
      const screenCapture: ScreenCaptureModule | undefined = NativeModules.ChalkScreenCapture;
      const track = stream.getVideoTracks()[0];
      if (!screenCapture || !track) throw new Error("Screen recording is unavailable in this app.");
      // ReplayKit consent can be cancelled. Do not publish until the extension sends a frame.
      await screenCapture.start(track.id);
    }
    return stream as unknown as globalThis.MediaStream;
  } catch (cause) {
    for (const track of stream.getTracks()) track.stop();
    stream.release();
    throw cause;
  }
}
