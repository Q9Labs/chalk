/** A camera fixture whose frames do not depend on the document's rendering clock. */
export function syntheticCamera(portrait: HTMLImageElement, width = 1280) {
  const Generator = (globalThis as typeof globalThis & { MediaStreamTrackGenerator: new (options: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } }).MediaStreamTrackGenerator;
  const track = new Generator({ kind: "video" });
  const writer = track.writable.getWriter();
  const canvas = document.createElement("canvas");
  const height = (width * 9) / 16;
  canvas.width = width;
  canvas.height = height;
  const painter = canvas.getContext("2d");
  if (!painter) throw new Error("Missing fixture canvas");
  let tick = 0;
  let writing = false;
  const paint = () => {
    if (writing) return;
    for (let y = 0; y < height; y += 16)
      for (let x = 0; x < width; x += 16) {
        painter.fillStyle = (x / 16 + y / 16 + tick) % 2 ? "#334d6c" : "#b4c1cf";
        painter.fillRect(x, y, 16, 16);
      }
    tick++;
    const imageWidth = (height * portrait.width) / portrait.height;
    painter.drawImage(portrait, (width - imageWidth) / 2 + (Math.sin(tick / 5) * width) / 160, 0, imageWidth, height);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
    writing = true;
    void writer
      .write(frame)
      .finally(() => {
        frame.close();
        writing = false;
      })
      .catch(() => {});
  };
  paint();
  const timer = setInterval(paint, 1000 / 30);
  track.getSettings = () => ({ deviceId: "proof-camera", width, height, frameRate: 30 });
  return {
    track,
    stop() {
      clearInterval(timer);
      void writer.abort().catch(() => {});
      track.stop();
    },
  };
}
