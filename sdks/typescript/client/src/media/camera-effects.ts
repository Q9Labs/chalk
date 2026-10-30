import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import { CameraBackgroundPreferences, type CameraBackground } from "./camera-background-settings";
import type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack } from "./camera-effects-track";
export type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack, CameraSegmenter } from "./camera-effects-track";

let assets: CameraEffectsAssets | undefined;
let provider: CameraEffectsProvider | undefined;
let supported: boolean | undefined;
const preferences = new CameraBackgroundPreferences();
const sessions = new Map<string, Set<CameraEffectsTrack>>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const fallbacks = new Map<string, number>();

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

/** Serialize rapid choices; load everything before changing any live canvas. */
export function setCameraBackground(deviceId: string, background: CameraBackground): Promise<void> {
  return enqueue(deviceId, async () => {
    const commits = await Promise.all([...(sessions.get(deviceId) ?? [])].map((session) => session.prepare(background)));
    for (const commit of commits) commit();
    preferences.set(deviceId, background);
    fallbacks.delete(deviceId);
    for (const listener of listeners) listener();
  });
}

function enqueue(deviceId: string, action: () => Promise<void>): Promise<void> {
  const change = (pending.get(deviceId) ?? Promise.resolve()).catch(() => {}).then(action);
  pending.set(deviceId, change);
  void change
    .finally(() => {
      if (pending.get(deviceId) === change) pending.delete(deviceId);
    })
    .catch(() => {});
  return change;
}

export function cameraBackgroundAvailable(deviceId: string): boolean {
  return cameraEffectsSupported() && (sessions.get(deviceId)?.size ?? 0) > 0;
}

/** Capture boundary: only this processed track reaches preview or the SFU. */
export async function processCameraStream(stream: MediaStream, signal?: AbortSignal): Promise<MediaStream> {
  let session: CameraEffectsTrack | undefined;
  const cancel = () => {
    session?.track.stop();
    for (const track of stream.getTracks()) if (track.readyState !== "ended") track.stop();
  };
  if (signal?.aborted) {
    cancel();
    signal.throwIfAborted();
  }
  if (!cameraEffectsSupported() || !assets || !provider) return stream;
  const source = stream.getVideoTracks()[0];
  if (!source) return stream;
  const deviceId = source.getSettings().deviceId ?? "default";
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const captured = await createCameraEffectsTrack(source, assets, provider, (fps) => {
      for (const active of sessions.get(deviceId) ?? []) active.usePlainCamera();
      preferences.set(deviceId, "none");
      fallbacks.set(deviceId, fps);
      for (const listener of listeners) listener();
    });
    session = captured;
    signal?.throwIfAborted();
    await enqueue(deviceId, async () => {
      const commit = await captured.prepare(preferences.get(deviceId));
      commit();
      const active = sessions.get(deviceId) ?? new Set<CameraEffectsTrack>();
      sessions.set(deviceId, active);
      active.add(captured);
      const remove = () => {
        active.delete(captured);
        if (active.size === 0) sessions.delete(deviceId);
      };
      captured.track.addEventListener("ended", remove, { once: true });
      const stop = captured.track.stop.bind(captured.track);
      captured.track.stop = () => {
        remove();
        stop();
      };
    });
    signal?.throwIfAborted();
    stream.removeTrack(source);
    stream.addTrack(captured.track);
    return stream;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function createCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets, createSegmenter: CameraEffectsProvider, onSlow?: (fps: number) => void): Promise<CameraEffectsTrack> {
  const { createCameraEffectsTrack: createTrack } = await import("./camera-effects-track");
  return createTrack(source, files, createSegmenter, onSlow);
}
