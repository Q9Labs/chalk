import type { ChalkSessionMediaDevices } from "./dependencies";

export function createBrowserMediaDevices(mediaDevices: MediaDevices | undefined = globalThis.navigator?.mediaDevices): ChalkSessionMediaDevices {
  return {
    async getUserMedia(constraints) {
      if (!mediaDevices?.getUserMedia) throw new TypeError("Browser media capture is unavailable");
      return mediaDevices.getUserMedia(constraints);
    },
    async getDisplayMedia(constraints) {
      if (!mediaDevices?.getDisplayMedia) throw new TypeError("Browser display capture is unavailable");
      return mediaDevices.getDisplayMedia(constraints);
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
    if (track !== video) track.stop();
  }
  return video;
}
