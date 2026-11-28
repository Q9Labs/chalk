import type { ScreenShareOptions, ScreenShareCapture } from "../media/plane";
import type { ConnectionMediaDevices } from "./dependencies";
import { ConnectionError } from "./types";
import { markMediaFailure } from "../media/failure-diagnostics";
import { processCameraStream } from "../media/camera-effects";
import { repeatedRefusal } from "../media/capture-error";

type CaptureKind = "audio" | "video";
const PERMISSION_NAMES = { audio: "microphone", video: "camera" } as const;
type PermissionQuery = { query(descriptor: { readonly name: "microphone" | "camera" }): Promise<EventTarget & { readonly state: string }> };

/**
 * A microphone or camera the browser refused stays refused until the person acts or the browser's permission changes,
 * so a loop that asks again costs no browser call and no telemetry. Only a request for that one device marks it,
 * because a refused request for both does not say which one was refused.
 */
export function createBrowserMediaDevices(mediaDevices: MediaDevices | undefined = globalThis.navigator?.mediaDevices, permissions: PermissionQuery | undefined = globalThis.navigator?.permissions as PermissionQuery | undefined): ConnectionMediaDevices {
  const refused = new Map<CaptureKind, { readonly error: unknown; stopWatching: () => void }>();
  const allow = (kind: CaptureKind) => {
    refused.get(kind)?.stopWatching();
    refused.delete(kind);
  };
  const refuse = (kind: CaptureKind, error: unknown) => {
    allow(kind);
    let stopped = false;
    let release = () => {};
    // Firefox cannot be asked about the camera or microphone, so there only an act of the person lifts the refusal.
    void permissions?.query({ name: PERMISSION_NAMES[kind] }).then(
      (status) => {
        if (stopped) return;
        const changed = () => allow(kind);
        status.addEventListener("change", changed);
        release = () => status.removeEventListener("change", changed);
      },
      () => undefined,
    );
    refused.set(kind, {
      error,
      stopWatching: () => {
        stopped = true;
        release();
      },
    });
  };
  return {
    allowRetry() {
      for (const kind of [...refused.keys()]) allow(kind);
    },
    async getUserMedia(constraints, signal) {
      const wanted = (["audio", "video"] as const).filter((kind) => constraints[kind]);
      for (const kind of wanted) {
        const earlier = refused.get(kind);
        if (earlier) throw repeatedRefusal(earlier.error);
      }
      if (!mediaDevices?.getUserMedia || globalThis.isSecureContext === false) throw new ConnectionError({ code: "unsupported_environment", action: null, recoverable: false, message: "Browser media capture is unavailable. Use a supported browser over HTTPS." });
      try {
        return await processCameraStream(await mediaDevices.getUserMedia(constraints), signal);
      } catch (error) {
        markMediaFailure(error, "local_capture");
        const [only] = wanted;
        if (wanted.length === 1 && only && isPermissionRefusal(error)) refuse(only, error);
        throw error;
      }
    },
    async getDisplayMedia(constraints) {
      if (!mediaDevices?.getDisplayMedia) throw new DOMException("Browser display capture is unavailable", "NotSupportedError");
      return mediaDevices.getDisplayMedia(constraints);
    },
    async enumerateDevices() {
      if (!mediaDevices?.enumerateDevices) return [];
      return mediaDevices.enumerateDevices();
    },
    releaseTrack: (track) => track.stop(),
  };
}

function isPermissionRefusal(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
}

/** Releases every track through the adapter object, so an adapter that keeps state in `this` works. One failing release cannot keep the others open; the first error is thrown after all were tried. */
export function releaseTracks(devices: Pick<ConnectionMediaDevices, "releaseTrack">, tracks: Iterable<MediaStreamTrack>): void {
  const failures: unknown[] = [];
  for (const track of tracks) {
    try {
      devices.releaseTrack(track);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) throw failures[0];
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    if (track.readyState !== "ended") track.stop();
  }
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
export function displayMediaConstraints(options: ScreenShareOptions = {}): DisplayMediaStreamOptions & { selfBrowserSurface: "exclude"; surfaceSwitching: "exclude"; systemAudio: "exclude"; audio: boolean | (MediaTrackConstraints & { suppressLocalAudioPlayback: boolean }) } {
  return {
    video: options.surface ? { displaySurface: options.surface } : true,
    audio: options.audio ? { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
  };
}

export function screenShareCapture(track: MediaStreamTrack): ScreenShareCapture {
  const surface = track.getSettings().displaySurface;
  return { surface: surface === "monitor" || surface === "window" || surface === "browser" ? surface : null, label: track.label || null };
}
