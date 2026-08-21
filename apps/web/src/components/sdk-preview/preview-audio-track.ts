export interface PreviewAudioTrack {
  readonly track: MediaStreamTrack;
  stop(): void;
}

/** A silent live audio track so unmuted preview participants publish a microphone like real ones do. */
export function createPreviewAudioTrack(): PreviewAudioTrack | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const [track] = destination.stream.getAudioTracks();
  if (!track) {
    void context.close();
    return null;
  }
  return {
    track,
    stop() {
      track.stop();
      void context.close();
    },
  };
}
