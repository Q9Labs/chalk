import type { ScreenShareOptions, ScreenShareCapture } from "../media/plane";
import type { ConnectionMediaDevices } from "./dependencies";
import { ConnectionError } from "./types";

export function createBrowserMediaDevices(mediaDevices: MediaDevices | undefined = globalThis.navigator?.mediaDevices): ConnectionMediaDevices {
  return {
    async getUserMedia(constraints) {
      if (!mediaDevices?.getUserMedia || globalThis.isSecureContext === false) throw new ConnectionError({ code: "unsupported_environment", action: null, recoverable: false, message: "Browser media capture is unavailable. Use a supported browser over HTTPS." });
      return mediaDevices.getUserMedia(constraints);
    },
    async getDisplayMedia(constraints) {
      if (!mediaDevices?.getDisplayMedia) throw new DOMException("Browser display capture is unavailable", "NotSupportedError");
      return mediaDevices.getDisplayMedia(constraints);
    },
    async enumerateDevices() {
      if (!mediaDevices?.enumerateDevices) return [];
      return mediaDevices.enumerateDevices();
    },
  };
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function streamFromTracks(tracks: readonly MediaStreamTrack[]): MediaStream {
  return { getTracks: () => [...tracks] } as MediaStream;
}

export function requireDisplayVideoTrack(stream: MediaStream): MediaStreamTrack {
  const video = stream.getVideoTracks()[0];
  if (!video) {
    stopStream(stream);
    throw new TypeError("Display capture did not return a video track");
  }
  for (const track of stream.getTracks()) {
    if (track !== video && track.kind !== "audio") track.stop();
  }
  return video;
}

/** Browser picker hints, not guarantees about the selected source. */
export function displayMediaConstraints(options: ScreenShareOptions = {}): DisplayMediaStreamOptions & { selfBrowserSurface: "exclude"; surfaceSwitching: "include"; systemAudio: "exclude"; audio: boolean | (MediaTrackConstraints & { suppressLocalAudioPlayback: boolean }) } {
  return {
    video: options.surface ? { displaySurface: options.surface } : true,
    audio: options.audio ? { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  };
}

export function screenShareCapture(track: MediaStreamTrack): ScreenShareCapture {
  const surface = track.getSettings().displaySurface;
  return { surface: surface === "monitor" || surface === "window" || surface === "browser" ? surface : null, label: track.label || null };
}
