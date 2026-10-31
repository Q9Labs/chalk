import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import { CameraBackgroundPreferences, type CameraBackground } from "./camera-background-settings";
import type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack } from "./camera-effects-track";
export type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack, CameraSegmenter } from "./camera-effects-track";

let assets: CameraEffectsAssets | undefined;
let provider: CameraEffectsProvider | undefined;
let supported: boolean | undefined;
// Shared with the lazily loaded operations, which own every write to this state.
export const preferences = new CameraBackgroundPreferences();
export const sessions = new Map<string, Set<CameraEffectsTrack>>();
export const pending = new Map<string, Promise<void>>();
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

export function cameraEffectsSupported(): boolean {
  if (!assets || typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return false;
  if (supported !== undefined) return supported;
  const environment: { readonly MediaStreamTrackProcessor?: unknown; readonly MediaStreamTrackGenerator?: unknown; readonly VideoFrame?: unknown } = globalThis;
  if (typeof environment.MediaStreamTrackProcessor !== "function" || typeof environment.MediaStreamTrackGenerator !== "function" || typeof environment.VideoFrame !== "function") return (supported = false);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2");
  supported = context !== null;
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  return supported;
}

export function getCameraBackground(deviceId: string): CameraBackground {
  return preferences.get(deviceId);
}
export function getCameraBackgroundFallback(deviceId: string): number | undefined {
  return fallbacks.get(deviceId);
}
export function subscribeCameraBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCameraBackground(deviceId: string, background: CameraBackground): Promise<void> {
  return import("./camera-effect-operations").then((operations) => operations.setCameraBackground(deviceId, background));
}

export function cameraBackgroundAvailable(deviceId: string): boolean {
  return cameraEffectsSupported() && (sessions.get(deviceId)?.size ?? 0) > 0;
}

/** Capture boundary: only this processed track reaches preview or the SFU. */
export async function processCameraStream(stream: MediaStream, signal?: AbortSignal): Promise<MediaStream> {
  if (!signal?.aborted && !(assets && provider && cameraEffectsSupported())) return stream;
  const operations = await import("./camera-effect-operations");
  return operations.processCameraStream(stream, assets, provider, signal);
}

export async function createCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets, createSegmenter: CameraEffectsProvider, onSlow?: (fps: number) => void): Promise<CameraEffectsTrack> {
  const [{ createCameraEffectsTrack: createTrack }, { CAMERA_BACKGROUND_IMAGES }] = await Promise.all([import("./camera-effects-track"), import("./camera-background-images")]);
  return createTrack(source, files, createSegmenter, onSlow, markCameraEffectFailure, CAMERA_BACKGROUND_IMAGES);
}

/** Preset labels and image URLs load when the background picker opens. */
export async function loadCameraBackgroundOptions() {
  const { CAMERA_BACKGROUND_OPTIONS } = await import("./camera-background-images");
  return CAMERA_BACKGROUND_OPTIONS;
}
