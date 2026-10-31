import { cameraEffectsSupported, createCameraEffectsTrack, fallbacks, notifyCameraBackground, pending, preferences, sessions } from "./camera-effects";
import type { CameraBackground } from "./camera-background-settings";
import type { CameraEffectsAssets, CameraEffectsProvider, CameraEffectsTrack } from "./camera-effects-track";

/** Serialize rapid choices; load everything before changing any live canvas. */
export function setCameraBackground(deviceId: string, background: CameraBackground): Promise<void> {
  return enqueue(deviceId, async () => {
    const commits = await Promise.all([...(sessions.get(deviceId) ?? [])].map((session) => session.prepare(background)));
    for (const commit of commits) commit();
    preferences.set(deviceId, background);
    fallbacks.delete(deviceId);
    notifyCameraBackground();
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
export async function processCameraStream(stream: MediaStream, assets: CameraEffectsAssets | undefined, provider: CameraEffectsProvider | undefined, signal?: AbortSignal): Promise<MediaStream> {
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
      notifyCameraBackground();
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
