import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { CHALK_BACKGROUND_ASSETS } from "@q9labsai/chalk-assets";
import { CameraBackgroundPreferences, type CameraBackground } from "./camera-background-settings";

export type CameraEffectsAssets = {
  /** Self-host the WASM files from the pinned tasks-vision package at this URL. */
  readonly wasmRoot: string;
  /** Self-host the MediaPipe selfie_segmenter_landscape model at this URL. */
  readonly modelUrl: string;
};
export type CameraEffectsTrack = {
  readonly track: MediaStreamTrack;
  readonly prepare: (background: CameraBackground) => Promise<() => void>;
  readonly stop: () => void;
};

let assets: CameraEffectsAssets | undefined;
let supported: boolean | undefined;
const preferences = new CameraBackgroundPreferences();
const sessions = new Map<string, Set<CameraEffectsTrack>>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Call before creating a browser Space client. Native capture never uses this layer. */
export function configureCameraEffects(next: CameraEffectsAssets): void {
  assets = next;
}

export function cameraEffectsSupported(): boolean {
  if (!assets || typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return false;
  if (supported !== undefined) return supported;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function" || typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== "function") return (supported = false);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2");
  supported = context !== null;
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  return supported;
}

export function getCameraBackground(deviceId: string): CameraBackground {
  return preferences.get(deviceId);
}
export function subscribeCameraBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Serialize rapid choices; load everything before changing any live canvas. */
export function setCameraBackground(deviceId: string, background: CameraBackground): Promise<void> {
  const change = (pending.get(deviceId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const commits = await Promise.all([...sessions.get(deviceId) ?? []].map((session) => session.prepare(background)));
    for (const commit of commits) commit();
    preferences.set(deviceId, background);
    for (const listener of listeners) listener();
  });
  pending.set(deviceId, change);
  void change.finally(() => {
    if (pending.get(deviceId) === change) pending.delete(deviceId);
  }).catch(() => {});
  return change;
}

/** Capture boundary: only this processed track reaches preview or the SFU. */
export async function processCameraStream(stream: MediaStream): Promise<MediaStream> {
  if (!cameraEffectsSupported() || !assets) return stream;
  const source = stream.getVideoTracks()[0];
  if (!source) return stream;
  const deviceId = source.getSettings().deviceId ?? "default";
  try {
    const session = await createCameraEffectsTrack(source, assets);
    const active = sessions.get(deviceId) ?? new Set<CameraEffectsTrack>();
    sessions.set(deviceId, active);
    active.add(session);
    const remove = () => {
      active.delete(session);
      if (active.size === 0) sessions.delete(deviceId);
    };
    session.track.addEventListener("ended", remove, { once: true });
    const stop = session.track.stop.bind(session.track);
    session.track.stop = () => { remove(); stop(); };
    const commit = await session.prepare(preferences.get(deviceId));
    commit();
    stream.removeTrack(source);
    stream.addTrack(session.track);
    return stream;
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}

/** Provider-neutral browser processor. It owns source until the output is stopped. */
export async function createCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets): Promise<CameraEffectsTrack> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  const canvas = document.createElement("canvas");
  const foreground = document.createElement("canvas");
  const mask = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const person = foreground.getContext("2d");
  const alpha = mask.getContext("2d");
  if (!context || !person || !alpha) throw new Error("Camera effects are unavailable");
  let segmenter: ImageSegmenter | undefined;
  let loading: Promise<ImageSegmenter> | undefined;
  let background: CameraBackground = "none";
  let ready = false;
  let image: HTMLImageElement | undefined;
  let frame = 0;
  let stopped = false;
  let lastFrame = -Infinity;
  let generation = 0;
  const loadSegmenter = () => loading ??= import("@mediapipe/tasks-vision").then(async ({ FilesetResolver, ImageSegmenter }) => {
    const vision = await FilesetResolver.forVisionTasks(files.wasmRoot);
    const loaded = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: files.modelUrl, delegate: "GPU" },
      runningMode: "VIDEO", outputConfidenceMasks: true, outputCategoryMask: false,
    });
    if (stopped) { loaded.close(); throw new Error("Camera effects stopped"); }
    segmenter = loaded;
    return loaded;
  }).catch((error: unknown) => { loading = undefined; throw error; });
  try {
    await video.play();
  } catch (error) {
    video.srcObject = null;
    source.stop();
    throw error;
  }
  const scale = Math.min(1, 960 / (video.videoWidth || 640));
  canvas.width = foreground.width = Math.round((video.videoWidth || 640) * scale);
  canvas.height = foreground.height = Math.round((video.videoHeight || 360) * scale);
  const output = canvas.captureStream(24).getVideoTracks()[0];
  if (!output) { source.stop(); video.srcObject = null; throw new Error("Camera effects could not create a video track"); }
  const nativeStop = output.stop.bind(output);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    video.cancelVideoFrameCallback(frame);
    video.pause();
    video.srcObject = null;
    source.removeEventListener("ended", ended);
    segmenter?.close();
    nativeStop();
    source.stop();
  };
  const ended = () => { stop(); output.dispatchEvent(new Event("ended")); };
  source.addEventListener("ended", ended, { once: true });
  output.stop = stop;
  const settings = output.getSettings.bind(output);
  output.getSettings = () => ({ ...source.getSettings(), ...settings(), deviceId: source.getSettings().deviceId });
  const draw = (time: number) => {
    if (stopped) return;
    frame = video.requestVideoFrameCallback(draw);
    if (time < lastFrame) return;
    lastFrame = Math.max(lastFrame + 1000 / 24, time);
    if (!ready) return;
    try {
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (background === "none" || !segmenter) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return;
      }
      segmenter.segmentForVideo(video, time, (result) => {
        const confidence = result.confidenceMasks?.[0];
        if (!confidence) throw new Error("Camera segmentation did not return a mask");
        if (mask.width !== confidence.width || mask.height !== confidence.height) {
          mask.width = confidence.width;
          mask.height = confidence.height;
        }
        const pixels = alpha.createImageData(mask.width, mask.height);
        const values = confidence.getAsFloat32Array();
        for (let i = 0; i < values.length; i++) pixels.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (values[i] - 0.25) / 0.5)) * 255);
        alpha.putImageData(pixels, 0, 0);
        person.globalCompositeOperation = "copy";
        person.drawImage(video, 0, 0, canvas.width, canvas.height);
        person.globalCompositeOperation = "destination-in";
        person.drawImage(mask, 0, 0, canvas.width, canvas.height);
        if (background === "blur") {
          context.filter = "blur(16px)";
          context.drawImage(video, -32, -32, canvas.width + 64, canvas.height + 64);
          context.filter = "none";
        } else if (image) {
          drawCover(context, image, canvas.width, canvas.height);
        }
        context.drawImage(foreground, 0, 0);
      });
    } catch {
      // Stop rather than expose unprocessed frames after an active effect fails.
      ended();
    }
  };
  frame = video.requestVideoFrameCallback(draw);
  return {
    track: output, stop,
    async prepare(next) {
      const revision = generation;
      if (next !== "none") await loadSegmenter();
      let nextImage: HTMLImageElement | undefined;
      if (next !== "none" && next !== "blur") {
        nextImage = new Image();
        nextImage.crossOrigin = "anonymous";
        nextImage.src = CHALK_BACKGROUND_ASSETS[next].webp.url;
        await nextImage.decode();
      }
      if (stopped || generation !== revision) throw new Error("Camera effects stopped");
      return () => { if (!stopped) { background = next; image = nextImage; ready = true; } };
    },
  };
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number): void {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}
