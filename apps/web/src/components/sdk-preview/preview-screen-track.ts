const WIDTH = 1280;
const HEIGHT = 720;
const FRAME_RATE = 4;
const REDRAW_MS = 500;

function paintDocument(context: CanvasRenderingContext2D, tick: number): void {
  context.fillStyle = "#fbfaf7";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#f4f3ef";
  context.fillRect(0, 0, WIDTH, 56);
  context.fillStyle = "#deddd7";
  context.fillRect(0, 56, WIDTH, 1);
  for (const [index, color] of ["#d67b7b", "#d9b641", "#80b879"].entries()) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(28 + index * 22, 28, 6, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#ffffff";
  context.fillRect(380, 16, 520, 24);
  context.fillStyle = "#858a92";
  context.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textAlign = "center";
  context.fillText("chalk.team/docs/product-review", 640, 33);
  context.textAlign = "left";
  context.fillStyle = "#202329";
  context.font = "600 40px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
  context.fillText("Design review", 96, 140);
  context.fillStyle = "#6d727b";
  context.font = "16px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
  context.fillText("Friday, August 1 · Product & engineering", 96, 172);
  const cards = [
    { value: "42 ms", label: "p95 join time" },
    { value: "99.99%", label: "Space availability" },
    { value: "5", label: "open decisions" },
  ];
  for (const [index, { value, label }] of cards.entries()) {
    const x = 96 + index * 320;
    context.fillStyle = "#ffffff";
    context.fillRect(x, 220, 280, 110);
    context.strokeStyle = "#deddd7";
    context.strokeRect(x + 0.5, 220.5, 279, 109);
    context.fillStyle = "#202329";
    context.font = "600 30px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(value, x + 24, 272);
    context.fillStyle = "#6d727b";
    context.font = "14px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
    context.fillText(label, x + 24, 302);
  }
  const lines = ["Keep Space controls in reserved space below the stage", "Ship whiteboard as a first-class collaborative surface", "Use a single calm focus border across form controls"];
  for (const [index, line] of lines.entries()) {
    const y = 390 + index * 70;
    context.fillStyle = "#ffffff";
    context.fillRect(96, y, 900, 52);
    context.strokeStyle = "#deddd7";
    context.strokeRect(96.5, y + 0.5, 899, 51);
    context.fillStyle = "#e8f1e4";
    context.beginPath();
    context.arc(124, y + 26, 12, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#49645d";
    context.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(String(index + 1), 120, y + 30);
    context.fillStyle = "#202329";
    context.font = "15px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
    context.fillText(line, 148, y + 31);
  }
  context.fillStyle = tick % 2 === 0 ? "#202329" : "#fbfaf7";
  context.fillRect(1052, 402, 2, 22);
}

export interface PreviewScreenTrack {
  readonly track: MediaStreamTrack;
  stop(): void;
}

/** Captures a painted canvas as a live video track so the preview stage renders a real screen share. */
export function createPreviewScreenTrack(): PreviewScreenTrack | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  if (typeof canvas.captureStream !== "function") return null;
  const context = canvas.getContext("2d");
  if (!context) return null;
  let tick = 0;
  paintDocument(context, tick);
  const stream = canvas.captureStream(FRAME_RATE);
  const [track] = stream.getVideoTracks();
  if (!track) return null;
  const timer = setInterval(() => {
    tick += 1;
    paintDocument(context, tick);
  }, REDRAW_MS);
  return {
    track,
    stop: () => {
      clearInterval(timer);
      track.stop();
    },
  };
}
