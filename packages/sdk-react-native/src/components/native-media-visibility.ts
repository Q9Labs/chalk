import type { Participant } from "@q9labs/chalk-core";
import type { MediaStreamTrack as NativeMediaStreamTrack } from "@cloudflare/react-native-webrtc";

export function shouldRenderNativeMediaTrack({ participant, track, mediaKind = "camera" }: { participant: Participant | null; track: MediaStreamTrack | NativeMediaStreamTrack | null | undefined; mediaKind?: "camera" | "screen-share" }): boolean {
  if (!track) {
    return false;
  }

  if (track.readyState === "ended") {
    return false;
  }

  if (mediaKind === "camera" && participant && !participant.videoEnabled) {
    return false;
  }

  return true;
}
