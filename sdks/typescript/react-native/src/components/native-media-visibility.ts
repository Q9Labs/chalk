import type { NativeMediaStreamTrack } from "../media/native-webrtc";

export function shouldRenderNativeMediaTrack({ participant, track, mediaKind = "camera" }: { participant: { readonly videoEnabled: boolean } | null; track: MediaStreamTrack | NativeMediaStreamTrack | null | undefined; mediaKind?: "camera" | "screen-share" }): boolean {
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
