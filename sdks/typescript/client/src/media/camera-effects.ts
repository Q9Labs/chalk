import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import type { CameraBackground } from "./camera-background-settings";
import type { CameraEffectsAssets, CameraEffectsProvider } from "./camera-effects-track";
export type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack, CameraSegmenter } from "./camera-effects-track";

let assets: CameraEffectsAssets | undefined;
let provider: CameraEffectsProvider | undefined;
// Written by the lazily loaded operations; the call UI reads these before that code loads.
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

/** Call before creating a browser Space client. Native capture never uses this layer. */
export function configureCameraEffectProvider(next: CameraEffectsAssets, createSegmenter: CameraEffectsProvider): void {
  assets = next;
  provider = createSegmenter;
}

export function getCameraBackgroundFallback(deviceId: string): number | undefined {
  return fallbacks.get(deviceId);
}
export function subscribeCameraBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Preferences, support detection and presets load when a camera starts or the background picker opens. */
export function loadCameraBackgroundControls() {
  return import("./camera-effect-operations");
}
export function setCameraBackground(deviceId: string, background: CameraBackground): Promise<void> {
  return loadCameraBackgroundControls().then((controls) => controls.setCameraBackground(deviceId, background));
}

/** Capture boundary: only this processed track reaches preview or the SFU. */
export async function processCameraStream(stream: MediaStream, signal?: AbortSignal): Promise<MediaStream> {
  if (!signal?.aborted && !(assets && provider)) return stream;
  const controls = await loadCameraBackgroundControls();
  return controls.processCameraStream(stream, assets, provider, signal);
}
