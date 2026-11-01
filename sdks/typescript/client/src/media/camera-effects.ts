import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import type { CameraBackground } from "./camera-background-settings";
import type { CameraEffectStore, CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack } from "./camera-effects-track";
export type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack, CameraSegmenter } from "./camera-effects-track";

let assets: CameraEffectsAssets | undefined;
let provider: CameraEffectsProvider | undefined;
// The lazily loaded operations write these; the call UI reads them before that code loads.
export const fallbacks = new Map<string, number>();
const listeners = new Set<() => void>();
export function notifyCameraBackground(): void {
  for (const listener of listeners) listener();
}

const failures = new WeakSet<MediaStreamTrack>();
export function markCameraEffectFailure(track: MediaStreamTrack): void {
  failures.add(track);
}
export function cameraEffectFailure(track: MediaStreamTrack): ConnectionReportTransportEvent | undefined {
  if (!failures.has(track)) return;
  return { event: "media_state", source: "camera", phase: "failed", outcome: "failed", code: "media_capture_failed", media_error_kind: "OperationError", media_error_step: "local_capture" };
}

export function getCameraBackgroundFallback(deviceId: string): number | undefined {
  return fallbacks.get(deviceId);
}
export function subscribeCameraBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const store: CameraEffectStore = { fallbacks, notify: notifyCameraBackground, markFailure: markCameraEffectFailure };

/** Call before creating a browser Space client. Native capture never uses this layer. */
export function configureCameraEffectProvider(next: CameraEffectsAssets, createSegmenter: CameraEffectsProvider): void {
  assets = next;
  provider = createSegmenter;
}

/** Preferences, support detection and presets load when a camera starts or the background picker opens. */
export function loadCameraBackgroundControls() {
  return import("./camera-effect-operations");
}
function loadControlsOwning(tracks: readonly MediaStreamTrack[]) {
  return loadCameraBackgroundControls().catch((error: unknown) => {
    for (const track of tracks) track.stop();
    throw error;
  });
}
export function setCameraBackground(deviceId: string, background: CameraBackground): Promise<void> {
  return loadCameraBackgroundControls().then((controls) => controls.setBackground(store, deviceId, background));
}

/** Capture boundary: only this processed track reaches preview or the SFU. */
export async function processCameraStream(stream: MediaStream, signal?: AbortSignal): Promise<MediaStream> {
  if (signal?.aborted) {
    for (const track of stream.getTracks()) track.stop();
    signal.throwIfAborted();
  }
  if (!(assets && provider) || stream.getVideoTracks().length === 0) return stream;
  const controls = await loadControlsOwning(stream.getTracks());
  return controls.processStream(store, stream, assets, provider, signal);
}

export function openCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets, createSegmenter: CameraEffectsProvider, onSlow?: (fps: number) => void): Promise<CameraEffectsTrack> {
  return loadControlsOwning([source]).then((controls) => controls.createEffectsTrack(store, source, files, createSegmenter, onSlow));
}
