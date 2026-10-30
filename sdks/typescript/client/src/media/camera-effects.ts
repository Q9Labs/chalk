import { CAMERA_BACKGROUND_IMAGES } from "./camera-background-images";
import { CameraBackgroundPreferences, type CameraBackground } from "./camera-background-settings";
import { bindCameraEffectLifecycle } from "./camera-effect-lifecycle";
import { cameraFrameProcessingSupported, createCameraFrameSource } from "./camera-frame-source";
import { markCameraEffectFailure } from "./camera-effect-failure";
import { CameraEffectPerformance } from "./camera-effect-performance";

export type CameraEffectsAssets = {
  /** Self-host the WASM files from the pinned tasks-vision package at this URL. */
  readonly wasmRoot: string;
  /** Self-host the MediaPipe selfie_segmenter_landscape model at this URL. */
  readonly modelUrl: string;
};
export type CameraSegmenter = {
  readonly close: () => void;
  readonly segmentForVideo: (frame: HTMLCanvasElement, timestamp: number, result: (value: { readonly confidenceMasks?: readonly { readonly width: number; readonly height: number; readonly getAsFloat32Array: () => Float32Array }[] }) => void) => void;
};
export type CameraEffectsProvider = (files: CameraEffectsAssets) => Promise<CameraSegmenter>;
export type CameraEffectsTrack = {
  readonly track: MediaStreamTrack;
  readonly prepare: (background: CameraBackground) => Promise<() => void>;
  readonly stop: () => void;
  readonly usePlainCamera: () => void;
};

let assets: CameraEffectsAssets | undefined;
let provider: CameraEffectsProvider | undefined;
let supported: boolean | undefined;
const preferences = new CameraBackgroundPreferences();
const sessions = new Map<string, Set<CameraEffectsTrack>>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const fallbacks = new Set<string>();

/** Call before creating a browser Space client. Native capture never uses this layer. */
export function configureCameraEffectProvider(next: CameraEffectsAssets, createSegmenter: CameraEffectsProvider): void {
  assets = next;
  provider = createSegmenter;
}

export function cameraEffectsSupported(): boolean {
  if (!assets || typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return false;
  if (supported !== undefined) return supported;
  if (!cameraFrameProcessingSupported()) return (supported = false);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2");
  supported = context !== null;
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  return supported;
}

export function getCameraBackground(deviceId: string): CameraBackground {
  return preferences.get(deviceId);
}
export function getCameraBackgroundFallback(deviceId: string): boolean {
  return fallbacks.has(deviceId);
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
    const captured = await createCameraEffectsTrack(source, assets, provider, () => {
      for (const active of sessions.get(deviceId) ?? []) active.usePlainCamera();
      preferences.set(deviceId, "none");
      fallbacks.add(deviceId);
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

/** Provider-neutral browser processor. It owns source until the output is stopped. */
export async function createCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets, createSegmenter: CameraEffectsProvider, onSlow?: () => void): Promise<CameraEffectsTrack> {
  const canvas = document.createElement("canvas");
  const foreground = document.createElement("canvas");
  const mask = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const person = foreground.getContext("2d");
  const alpha = mask.getContext("2d");
  if (!context || !person || !alpha) {
    source.stop();
    throw new Error("Camera effects are unavailable");
  }
  let segmenter: CameraSegmenter | undefined;
  let loading: Promise<CameraSegmenter> | undefined;
  let background: CameraBackground = "none";
  let ready = false;
  let image: HTMLImageElement | undefined;
  let stopped = false;
  let lastFrame = -Infinity;
  let generation = 0;
  const performanceMeter = new CameraEffectPerformance();
  const loadSegmenter = () =>
    (loading ??= createSegmenter(files)
      .then((loaded) => {
        if (stopped) {
          loaded.close();
          throw new Error("Camera effects stopped");
        }
        segmenter = loaded;
        return loaded;
      })
      .catch((error: unknown) => {
        loading = undefined;
        throw error;
      }));
  let width = source.getSettings().width || 640;
  let height = source.getSettings().height || 360;
  const resize = (next: CameraBackground) => {
    const limit = globalThis.matchMedia?.("(max-width: 640px)").matches ? 640 : 960;
    const scale = next === "none" ? 1 : Math.min(1, limit / width);
    canvas.width = foreground.width = Math.round(width * scale);
    canvas.height = foreground.height = Math.round(height * scale);
  };
  resize("none");
  const usePlainCamera = () => {
    if (stopped) return;
    generation++;
    background = "none";
    image = undefined;
    ready = true;
    resize("none");
    performanceMeter.reset();
  };
  let pipeline: ReturnType<typeof createCameraFrameSource>;
  try {
    pipeline = createCameraFrameSource(source);
  } catch (error) {
    source.stop();
    throw error;
  }
  const output = pipeline.track;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    source.removeEventListener("ended", ended);
    releaseBindings();
    segmenter?.close();
    pipeline.stop();
    source.stop();
  };
  const ended = () => {
    stop();
    output.dispatchEvent(new Event("ended"));
  };
  source.addEventListener("ended", ended, { once: true });
  output.stop = stop;
  output.getSettings = () => ({ ...source.getSettings(), width: canvas.width, height: canvas.height, frameRate: background === "none" ? 30 : 24 });
  const releaseBindings = bindCameraEffectLifecycle(source, output);
  const draw = (input: VideoFrame) => {
    const time = input.timestamp / 1000;
    if (time < lastFrame) return;
    lastFrame = Math.max(lastFrame + 1000 / (background === "none" ? 30 : 24), time);
    if (!ready || !source.enabled || source.muted) {
      performanceMeter.reset();
      return;
    }
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (background === "none" || !segmenter) {
      context.drawImage(input, 0, 0, canvas.width, canvas.height);
      return true;
    }
    person.globalCompositeOperation = "copy";
    person.drawImage(input, 0, 0, canvas.width, canvas.height);
    segmenter.segmentForVideo(foreground, time, (result) => {
      const confidence = result.confidenceMasks?.[0];
      if (!confidence) throw new Error("Camera segmentation did not return a mask");
      if (mask.width !== confidence.width || mask.height !== confidence.height) {
        mask.width = confidence.width;
        mask.height = confidence.height;
      }
      const pixels = alpha.createImageData(mask.width, mask.height);
      const values = confidence.getAsFloat32Array();
      let pixel = 3;
      for (const value of values) {
        pixels.data[pixel] = Math.round(Math.max(0, Math.min(1, (value - 0.25) / 0.5)) * 255);
        pixel += 4;
      }
      alpha.putImageData(pixels, 0, 0);
      person.globalCompositeOperation = "destination-in";
      person.drawImage(mask, 0, 0, canvas.width, canvas.height);
      if (background === "blur") {
        context.filter = "blur(16px)";
        context.drawImage(input, -32, -32, canvas.width + 64, canvas.height + 64);
        context.filter = "none";
      } else if (image) {
        drawCover(context, image, canvas.width, canvas.height);
      }
      context.drawImage(foreground, 0, 0);
    });
    return true;
  };
  const writeFrame = async (input: VideoFrame) => {
    try {
      if (stopped) return;
      if (input.displayWidth !== width || input.displayHeight !== height) {
        width = input.displayWidth;
        height = input.displayHeight;
        resize(background);
      }
      if (!draw(input)) return;
      const processed = new VideoFrame(canvas, { timestamp: input.timestamp });
      try {
        await pipeline.writer.write(processed);
        if (background !== "none" && performanceMeter.record(performance.now())) {
          usePlainCamera();
          onSlow?.();
        }
      } finally {
        processed.close();
      }
    } finally {
      input.close();
    }
  };
  void (async () => {
    try {
      while (!stopped) {
        const { value: input, done } = await pipeline.reader.read();
        if (done) {
          if (!stopped) ended();
          break;
        }
        await writeFrame(input);
      }
    } catch {
      if (!stopped) {
        markCameraEffectFailure(output);
        ended();
      }
    }
  })();
  return {
    track: output,
    stop,
    usePlainCamera,
    async prepare(next) {
      const revision = generation;
      if (next !== "none") await loadSegmenter();
      let nextImage: HTMLImageElement | undefined;
      if (next !== "none" && next !== "blur") {
        nextImage = new Image();
        nextImage.crossOrigin = "anonymous";
        nextImage.src = CAMERA_BACKGROUND_IMAGES[next].avif.url;
        try {
          await nextImage.decode();
        } catch {
          nextImage.src = CAMERA_BACKGROUND_IMAGES[next].webp.url;
          await nextImage.decode();
        }
      }
      if (stopped || generation !== revision) throw new Error("Camera effects stopped");
      return () => {
        if (!stopped && generation === revision) {
          resize(next);
          background = next;
          image = nextImage;
          ready = true;
          performanceMeter.reset();
        }
      };
    },
  };
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number): void {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}
