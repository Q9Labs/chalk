import { CameraBackgroundPreferences, type CameraBackground } from "./camera-background-settings";
import { CAMERA_BACKGROUND_IMAGES, CAMERA_BACKGROUND_OPTIONS } from "./camera-background-images";
import { createCameraEffectsTrack as createTrack } from "./camera-effects-track";
import type { CameraEffectStore, CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack } from "./camera-effects-track";

export { CAMERA_BACKGROUND_OPTIONS };

export function createEffectsTrack(store: CameraEffectStore, source: MediaStreamTrack, files: CameraEffectsAssets, createSegmenter: CameraEffectsProvider, onSlow?: (fps: number) => void): Promise<CameraEffectsTrack> {
  return createTrack(source, files, createSegmenter, onSlow, store.markFailure, CAMERA_BACKGROUND_IMAGES);
}

const preferences = new CameraBackgroundPreferences();
const sessions = new Map<string, Set<CameraEffectsTrack>>();
const pending = new Map<string, Promise<void>>();
let supported: boolean | undefined;

export function cameraEffectsSupported(): boolean {
  if (typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return false;
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
export function cameraBackgroundAvailable(deviceId: string): boolean {
  return cameraEffectsSupported() && (sessions.get(deviceId)?.size ?? 0) > 0;
}

/** Serialize rapid choices; load everything before changing any live canvas. */
export function setBackground(store: CameraEffectStore, deviceId: string, background: CameraBackground): Promise<void> {
  return enqueue(deviceId, async () => {
    const commits = await Promise.all([...(sessions.get(deviceId) ?? [])].map((session) => session.prepare(background)));
    for (const commit of commits) commit();
    preferences.set(deviceId, background);
    store.fallbacks.delete(deviceId);
    store.notify();
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

/** Capture boundary: only this processed track reaches preview or the SFU. */
export async function processStream(store: CameraEffectStore, stream: MediaStream, assets: CameraEffectsAssets | undefined, provider: CameraEffectsProvider | undefined, signal?: AbortSignal): Promise<MediaStream> {
  let session: CameraEffectsTrack | undefined;
  const cancel = () => {
    session?.track.stop();
    for (const track of stream.getTracks()) if (track.readyState !== "ended") track.stop();
  };
  if (signal?.aborted) {
    cancel();
    signal.throwIfAborted();
  }
  if (!assets || !provider || !cameraEffectsSupported()) return stream;
  const source = stream.getVideoTracks()[0];
  if (!source) return stream;
  const deviceId = source.getSettings().deviceId ?? "default";
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const captured = await createEffectsTrack(store, source, assets, provider, (fps) => {
      for (const active of sessions.get(deviceId) ?? []) active.usePlainCamera();
      preferences.set(deviceId, "none");
      store.fallbacks.set(deviceId, fps);
      store.notify();
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
