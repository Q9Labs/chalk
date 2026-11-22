import { z } from "zod";

const channel = z.number().int().min(0).max(255);
const point = z.strictObject({
  x: z.number().min(0.1).max(0.9),
  y: z.number().min(0.1).max(0.9),
  rgb: z.tuple([channel, channel, channel]),
});
export const probeSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  points: z.tuple([point, point, point]),
});
type Probe = z.infer<typeof probeSchema>;

export async function calibrateMonitor(options: {
  readonly track: MediaStreamTrack;
  readonly signal: AbortSignal;
  readonly start: (signal: AbortSignal) => Promise<Probe>;
  readonly protect: (nonce: string, signal: AbortSignal) => Promise<void>;
  readonly complete: (nonce: string, signal: AbortSignal) => Promise<void>;
  readonly abort: () => Promise<void>;
}): Promise<void> {
  const { track, signal } = options;
  if (track.readyState !== "live" || !track.enabled || track.getSettings().displaySurface !== "monitor") {
    throw new Error("The shared monitor changed.");
  }
  const { video, dispose } = localPreview(track);
  const sample = probeReader(video);
  let probing = false;
  let completed = false;
  let protectedAt = 0;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  try {
    await Promise.race([video.play(), cancelled(deadline)]);
    // Disable the published track only. The on-device clone still sees the monitor.
    track.enabled = false;
    probing = true;
    const probe = await options.start(deadline);
    let frames = 0;
    while (frames < 2) {
      await nextFrame(video, deadline);
      const observed = sample(probe);
      frames = observed.every((mark) => mark.aligned) ? frames + 1 : 0;
    }
    await options.protect(probe.nonce, deadline);
    protectedAt = performance.now();
    frames = 0;
    while (frames < 4) {
      await nextFrame(video, deadline);
      const observed = sample(probe);
      frames = observed.every((mark) => mark.matches === 0) ? frames + 1 : 0;
    }
    // Ensure we sampled genuinely new frames, not several duplicate callbacks.
    if (performance.now() - protectedAt < 60) await pause(60);
    deadline.throwIfAborted();
    await options.complete(probe.nonce, deadline);
    completed = true;
  } finally {
    if (probing && !completed) {
      // If the bridge disappeared, wait out its hard probe deadline before re-enabling sending.
      try {
        await options.abort();
      } catch {
        await pause(4300);
      }
    }
    if (probing && track.readyState === "live") track.enabled = true;
    dispose();
  }
}

function localPreview(track: MediaStreamTrack) {
  const preview = track.clone();
  preview.enabled = true;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([preview]);
  video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, { position: "fixed", width: "1px", height: "1px", opacity: "0.01", pointerEvents: "none" });
  document.body.appendChild(video);
  return {
    video,
    dispose() {
      preview.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}

export function chromiumWindowId(label: string): string | undefined {
  // The classic Chromium picker exposes the platform source ID. A fourth
  // ":s" field instead labels an opaque OS picker session, not a window.
  return /^window:([1-9][0-9]{0,18}):-?[0-9]+$/.exec(label)?.[1];
}

export async function calibrateWindow(options: {
  readonly track: MediaStreamTrack;
  readonly signal: AbortSignal;
  readonly verify: (input: { width: number; height: number; landmarks: number[] }, signal: AbortSignal) => Promise<boolean>;
  readonly start: (signal: AbortSignal) => Promise<Probe>;
  readonly painted: (nonce: string, signal: AbortSignal) => Promise<void>;
  readonly complete: (nonce: string, signal: AbortSignal) => Promise<void>;
  readonly abort: () => Promise<void>;
}): Promise<void> {
  const { track, signal } = options;
  if (!track.enabled || track.readyState !== "live") return;
  const { video, dispose } = localPreview(track);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  let probing = false;
  let completed = false;
  try {
    await Promise.race([video.play(), cancelled(deadline)]);
    await nextFrame(video, deadline);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width < 320 || height < 240) return;
    const landmarks = windowLandmarks(video);
    if (!(await options.verify({ width, height, landmarks }, deadline))) return;
    // Only pause the outgoing publication once the native window actually
    // matches the browser preview. The independent clone still runs.
    deadline.throwIfAborted();
    track.enabled = false;
    probing = true;
    const probe = await options.start(deadline);
    await options.painted(probe.nonce, deadline);
    // Capture time on the local clone uses the same clock as the browser's
    // receipt of the ACK. Leave 1 ms for timestamp rounding; presentation
    // time and callback arrival can both be late for a pre-paint frame.
    let lastCapture = performance.now() + 1;
    const sample = probeReader(video);
    let frames = 0;
    while (frames < 4) {
      await nextFrame(video, deadline, (_, { captureTime }) => {
        if (
          video.videoWidth !== width || video.videoHeight !== height || captureTime === undefined ||
          !Number.isFinite(captureTime) || captureTime > performance.now()
        ) {
          throw new Error("Chalk could not verify the window frame's capture time or size.");
        }
        if (captureTime <= lastCapture) {
          frames = 0;
          return;
        }
        lastCapture = captureTime;
        frames = sample(probe).every((mark) => mark.matches === 0) ? frames + 1 : 0;
      });
    }
    await options.complete(probe.nonce, deadline);
    completed = true;
  } catch {
    // A moving, occluded or mismatched window stays hidden. The caller can
    // retry with a new local sample when a valid window becomes visible.
  } finally {
    if (probing && !completed) {
      try {
        await options.abort();
      } catch {
        await pause(4300);
      }
    }
    if (probing && track.readyState === "live") track.enabled = true;
    dispose();
  }
}

function windowLandmarks(video: HTMLVideoElement): number[] {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Chalk could not read the local preview.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const energy = (x: number, y: number) => {
    const offset = (y * canvas.width + x) * 4;
    return Math.floor(((pixels[offset] ?? 0) + 2 * (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0)) / 4);
  };
  const landmarks: number[] = [];
  // Skip browser chrome. Keep these positions in sync with Helper's native sample.
  for (const [left, top] of [
    [3, 12],
    [48, 12],
    [3, 48],
  ] as const) {
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const px = left + x * 5;
        const py = top + y * 5;
        const center = energy(px, py);
        if (x < 4) landmarks.push(Math.trunc((energy(px + 5, py) - center) / 4));
        if (y < 4) landmarks.push(Math.trunc((energy(px, py + 5) - center) / 4));
      }
    }
  }
  return landmarks;
}

function probeReader(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Chalk could not read the local preview.");
  return (probe: Probe) => {
    canvas.width = Math.min(video.videoWidth, 960);
    canvas.height = Math.round((video.videoHeight * canvas.width) / video.videoWidth);
    const { width, height } = canvas;
    if (width < 320 || height < 240) throw new Error("The shared image is too small to match.");
    context.drawImage(video, 0, 0, width, height);
    return probe.points.map(({ x, y, rgb }) => {
      const size = Math.round(Math.min(width, height) * 0.1);
      const left = Math.floor(width * x - size / 2);
      const top = Math.floor(height * y - size / 2);
      const data = context.getImageData(left, top, size, size).data;
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let matches = 0;
      for (let i = 0; i < data.length; i += 4) {
        const distance = Math.hypot((data[i] ?? 0) - rgb[0], (data[i + 1] ?? 0) - rgb[1], (data[i + 2] ?? 0) - rgb[2]);
        if (distance > 65) continue;
        const pixel = i / 4;
        const px = left + (pixel % size) + 0.5;
        const py = top + Math.floor(pixel / size) + 0.5;
        count++;
        sumX += px;
        sumY += py;
        if (Math.hypot(px - x * width, py - y * height) < Math.min(width, height) * 0.025) matches++;
      }
      const expectedSquare = (Math.min(width, height) * 0.04) ** 2;
      return {
        matches,
        aligned: count >= expectedSquare / 8 && count <= expectedSquare * 2 && Math.hypot(sumX / count - x * width, sumY / count - y * height) / width < 0.005,
      };
    });
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancelled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function nextFrame(video: HTMLVideoElement, signal: AbortSignal, inspect?: VideoFrameRequestCallback): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    function abort() {
      video.cancelVideoFrameCallback(frame);
      reject(signal.reason);
    }
    const frame = video.requestVideoFrameCallback((now, metadata) => {
      signal.removeEventListener("abort", abort);
      try {
        inspect?.(now, metadata);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
