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
  const preview = track.clone();
  preview.enabled = true;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([preview]);
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
      frames = observed.every((mark) => mark && mark.offset < 0.005) ? frames + 1 : 0;
    }
    await options.protect(probe.nonce, deadline);
    protectedAt = performance.now();
    frames = 0;
    while (frames < 4) {
      await nextFrame(video, deadline);
      const observed = sample(probe);
      frames = observed.every((mark) => mark === null) ? frames + 1 : 0;
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
    preview.stop();
    video.srcObject = null;
  }
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
      for (let i = 0; i < data.length; i += 4) {
        const distance = Math.hypot((data[i] ?? 0) - rgb[0], (data[i + 1] ?? 0) - rgb[1], (data[i + 2] ?? 0) - rgb[2]);
        if (distance > 65) continue;
        const pixel = i / 4;
        count++;
        sumX += left + (pixel % size) + 0.5;
        sumY += top + Math.floor(pixel / size) + 0.5;
      }
      const expectedSquare = (Math.min(width, height) * 0.04) ** 2;
      if (count < expectedSquare / 8 || count > expectedSquare * 2) return null;
      return { offset: Math.hypot(sumX / count - x * width, sumY / count - y * height) / width };
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

async function nextFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    function abort() {
      video.cancelVideoFrameCallback(frame);
      reject(signal.reason);
    }
    const frame = video.requestVideoFrameCallback(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
