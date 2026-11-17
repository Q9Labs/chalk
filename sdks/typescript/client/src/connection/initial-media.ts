import { Effect } from "effect";
import { describeMediaCaptureError } from "../media/capture-error";
import type { ConnectionMediaDevices } from "./dependencies";
import { ConnectionLifecycleFailure, lifecycleFailure } from "./lifecycle-failure";
import { releaseTracks, streamFromTracks } from "./media-devices";
import { ConnectionError } from "./types";

export type InitialMedia = (
  intent: Readonly<{
    microphone: boolean;
    camera: boolean;
  }>,
) => Effect.Effect<MediaStream, unknown>;

/** A failing release is reported but does not replace the Leave or join failure that is already being handled. */
export function releaseLocalTracks(devices: ConnectionMediaDevices, tracks: readonly MediaStreamTrack[]): Effect.Effect<void> {
  return Effect.try({
    try: () => {
      for (const track of tracks) track.enabled = false;
      releaseTracks(devices, tracks);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => Effect.logWarning("Releasing local tracks failed", cause)));
}

export function captureFailure(cause: unknown): ConnectionLifecycleFailure {
  if (cause instanceof ConnectionError && cause.cause === undefined) return lifecycleFailure(cause.code, cause.recoverable, cause.message, cause);
  const failure = describeMediaCaptureError(cause instanceof ConnectionError ? cause.cause : cause);
  // Only the browser adapter can establish that capture itself is unavailable.
  if (failure.code === "unsupported_environment") return lifecycleFailure("media_capture_failed", true, "Media capture failed. Try again or enter with devices off.", cause);
  return lifecycleFailure(failure.code, failure.recoverable, failure.message, cause);
}
export function acquireInitialMedia(
  provider: InitialMedia,
  intent: Readonly<{
    microphone: boolean;
    camera: boolean;
  }>,
  mediaDevices: ConnectionMediaDevices,
  onDeviceFailure: (source: "microphone" | "camera", cause: unknown) => void,
): Effect.Effect<
  {
    stream: MediaStream;
    failure: ConnectionLifecycleFailure | null;
  },
  ConnectionLifecycleFailure
> {
  return provider(intent).pipe(
    Effect.map((stream) => ({ stream, failure: null })),
    Effect.catch((cause) => {
      const initialFailure = captureFailure(cause);
      if (!initialFailure.recoverable) {
        for (const source of ["microphone", "camera"] as const) if (intent[source]) onDeviceFailure(source, cause);
        return Effect.fail(initialFailure);
      }
      const tracks = new Set<MediaStreamTrack>();
      return Effect.gen(function* () {
        const failures: {
          source: "microphone" | "camera";
          failure: ConnectionLifecycleFailure;
        }[] = [];
        for (const source of ["microphone", "camera"] as const) {
          if (!intent[source]) continue;
          if (!intent.microphone || !intent.camera) {
            onDeviceFailure(source, cause);
            failures.push({ source, failure: initialFailure });
            continue;
          }
          yield* provider({ microphone: source === "microphone", camera: source === "camera" }).pipe(
            Effect.tap((stream) =>
              Effect.sync(() => {
                for (const track of stream.getTracks()) tracks.add(track);
              }),
            ),
            Effect.catch((cause) =>
              Effect.sync(() => {
                onDeviceFailure(source, cause);
                failures.push({ source, failure: captureFailure(cause) });
              }),
            ),
          );
        }
        if (tracks.size === 0) yield* provider({ microphone: false, camera: false }).pipe(Effect.mapError(captureFailure));
        return { stream: streamFromTracks([...tracks]), failure: initialCaptureWarning(failures) };
      }).pipe(Effect.onInterrupt(() => releaseLocalTracks(mediaDevices, [...tracks])));
    }),
  );
}
function initialCaptureWarning(
  failures: readonly {
    source: "microphone" | "camera";
    failure: ConnectionLifecycleFailure;
  }[],
): ConnectionLifecycleFailure | null {
  const first = failures[0];
  if (!first) return null;
  const names = failures.length === 2 ? "Microphone and camera" : first.source === "microphone" ? "Microphone" : "Camera";
  const message = failures.length === 2 && first.failure.code !== failures[1]?.failure.code ? failures.map(({ source, failure }) => `${source === "microphone" ? "Microphone" : "Camera"}: ${failure.message}`).join(" ") : `${names}: ${first.failure.message}`;
  return lifecycleFailure(first.failure.code, true, message, first.failure.cause);
}
