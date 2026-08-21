import { createPreviewSyntheticTrack } from "./preview-track";

const WIDTH = 640;
const HEIGHT = 360;
const FRAME_RATE = 5;
const REDRAW_MS = 500;

export interface PreviewCameraTrack {
  readonly track: MediaStreamTrack;
  stop(): void;
}

export interface PreviewCameraTrackOptions {
  readonly id?: string;
  readonly displayName?: string;
}

/** Paints a stable local portrait card and captures it as a camera-shaped video track. */
export function createPreviewCameraTrack({ id = "preview-camera-track", displayName = "Preview Participant" }: PreviewCameraTrackOptions = {}): PreviewCameraTrack {
  if (typeof document === "undefined") return createFallbackCameraTrack(id);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  if (typeof canvas.captureStream !== "function") return createFallbackCameraTrack(id);
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return createFallbackCameraTrack(id);
  }
  if (!context) return createFallbackCameraTrack(id);
  paintCamera(context, displayName, 0);
  let track: MediaStreamTrack | undefined = undefined;
  try {
    const stream = canvas.captureStream(FRAME_RATE);
    [track] = stream.getVideoTracks();
  } catch {
    return createFallbackCameraTrack(id);
  }
  if (!track) return createFallbackCameraTrack(id);
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    paintCamera(context, displayName, tick);
  }, REDRAW_MS);
  let stopped = false;
  return {
    track,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      track.stop();
    },
  };
}

function paintCamera(context: CanvasRenderingContext2D, displayName: string, tick: number): void {
  context.fillStyle = "#1f2933";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#364553";
  context.fillRect(0, 0, WIDTH, 48);
  context.fillStyle = "#90a4ae";
  context.font = "14px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillText("CHALK · LIVE CAMERA", 24, 30);
  context.fillStyle = "#f4e7d0";
  context.beginPath();
  context.arc(WIDTH / 2, 150, 58, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#d2a679";
  context.beginPath();
  context.arc(WIDTH / 2, 137, 61, Math.PI, Math.PI * 2);
  context.fill();
  context.fillStyle = "#dce7ef";
  context.fillRect(WIDTH / 2 - 92, 208, 184, 112);
  context.fillStyle = "#ffffff";
  context.font = "600 22px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
  context.textAlign = "center";
  context.fillText(displayName, WIDTH / 2, 336);
  context.fillStyle = tick % 2 === 0 ? "#69d19b" : "#8be2b3";
  context.beginPath();
  context.arc(WIDTH - 28, 24, 6, 0, Math.PI * 2);
  context.fill();
  context.textAlign = "left";
}

function createFallbackCameraTrack(id: string): PreviewCameraTrack {
  const track = createPreviewSyntheticTrack("video", id, "Chalk SDK preview camera");
  let stopped = false;
  return {
    track,
    stop: () => {
      if (stopped) return;
      stopped = true;
      track.stop();
    },
  };
}
