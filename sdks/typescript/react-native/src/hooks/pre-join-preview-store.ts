import type { NativeMediaStream } from "../media/realtimekit/native-webrtc";
import type { ExternalStore } from "./external-store";

export interface PreviewSnapshot {
  readonly previewStream: NativeMediaStream | null;
  readonly previewError: string | null;
}

export type PreJoinPreviewStore = ExternalStore<PreviewSnapshot>;

interface PreJoinPreviewStoreOptions {
  readonly enabled: boolean;
  readonly simulatorVideoDisabled: boolean;
  readonly simulatorVideoMessage: string;
  readonly getUserMedia: (constraints: unknown) => Promise<NativeMediaStream>;
}

function stopPreviewTracks(stream: NativeMediaStream | null): void {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Best effort only.
    }
  });
}

export function createPreJoinPreviewStore(options: PreJoinPreviewStoreOptions): PreJoinPreviewStore {
  const initialSnapshot: PreviewSnapshot = {
    previewStream: null,
    previewError: options.enabled && options.simulatorVideoDisabled ? options.simulatorVideoMessage : null,
  };
  let snapshot = initialSnapshot;
  let activeStream: NativeMediaStream | null = null;
  let requestGeneration = 0;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };

  const reset = (): void => {
    requestGeneration += 1;
    stopPreviewTracks(activeStream);
    activeStream = null;
    snapshot = initialSnapshot;
  };

  const start = (): void => {
    if (!options.enabled || options.simulatorVideoDisabled) return;

    const generation = ++requestGeneration;
    void options
      .getUserMedia({ audio: false, video: { facingMode: "user" } })
      .then((stream) => {
        if (generation !== requestGeneration) {
          stopPreviewTracks(stream);
          return;
        }

        const videoTrack = stream.getVideoTracks?.()[0] ?? null;
        if (!videoTrack) {
          stopPreviewTracks(stream);
          snapshot = { previewStream: null, previewError: "No camera track available" };
          notify();
          return;
        }

        stopPreviewTracks(activeStream);
        activeStream = stream;
        snapshot = { previewStream: stream, previewError: null };
        notify();
      })
      .catch((cause: unknown) => {
        if (generation !== requestGeneration) return;
        snapshot = {
          previewStream: null,
          previewError: cause instanceof Error ? cause.message : "Unable to start camera preview",
        };
        notify();
      });
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) start();

    return () => {
      listeners.delete(listener);
      if (listeners.size !== 0) return;
      reset();
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe,
  };
}
