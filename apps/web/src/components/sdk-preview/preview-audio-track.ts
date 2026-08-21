import { createPreviewSyntheticTrack } from "./preview-track";

export interface PreviewAudioTrack {
  readonly track: MediaStreamTrack;
  stop(): void;
}

/** A silent live audio track so unmuted preview participants publish a microphone like real ones do. */
export function createPreviewAudioTrack(id = "preview-audio-track"): PreviewAudioTrack {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    return createFallbackAudioTrack(id);
  }

  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return createFallbackAudioTrack(id);
  }

  let track: MediaStreamTrack | undefined = undefined;
  try {
    const destination = context.createMediaStreamDestination();
    [track] = destination.stream.getAudioTracks();
  } catch {
    void closeAudioContext(context);
    return createFallbackAudioTrack(id);
  }
  if (!track) {
    void closeAudioContext(context);
    return createFallbackAudioTrack(id);
  }

  let stopped = false;
  return {
    track,
    stop() {
      if (stopped) return;
      stopped = true;
      track.stop();
      void closeAudioContext(context);
    },
  };
}

function createFallbackAudioTrack(id: string): PreviewAudioTrack {
  const track = createPreviewSyntheticTrack("audio", id);
  let stopped = false;
  return {
    track,
    stop() {
      if (stopped) return;
      stopped = true;
      track.stop();
    },
  };
}

async function closeAudioContext(context: AudioContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // Closing an already closed context is harmless for a preview resource.
  }
}
