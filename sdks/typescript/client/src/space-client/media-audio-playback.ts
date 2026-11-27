import { Effect } from "effect";
import { AudioPlayback, type AudioContextObservation, type AudioElementObservation } from "./audio-playback";
import { foreign, normalizeMediaError, type ClientEffect } from "./errors";

export type MediaAudioPlaybackEffects = {
  readonly observeAudioElement: (track: MediaStreamTrack, element: HTMLAudioElement) => AudioElementObservation;
  readonly observeAudioContext: (context: AudioContext) => AudioContextObservation;
  readonly resumeAudioPlayback: () => ClientEffect<void>;
};

type AudioPlaybackPorts = {
  readonly observeAudioElement?: (track: MediaStreamTrack, element: HTMLAudioElement) => AudioElementObservation;
};

export function createMediaAudioPlayback(ports: () => AudioPlaybackPorts | null | undefined, changed: () => void) {
  const playback = new AudioPlayback({
    observeElement: (track, element) => ports()?.observeAudioElement?.(track, element) ?? { played: () => {}, detach: () => {} },
    changed,
  });
  return {
    observeAudioElement: (track: MediaStreamTrack, element: HTMLAudioElement): AudioElementObservation => playback.observeElement(track, element),
    observeAudioContext: (context: AudioContext): AudioContextObservation => playback.observeAudioContext(context),
    resumeAudioPlayback: (): ClientEffect<void> => foreign(() => playback.resume()).pipe(Effect.mapError(normalizeMediaError)),
    dispose: () => playback.dispose(),
    get snapshot() {
      return playback.snapshot;
    },
  };
}
