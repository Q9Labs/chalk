/** A camera fixture whose frames do not depend on the document's rendering clock. */
export function syntheticCamera(portrait: HTMLImageElement, width = 1280) {
  const Generator = (globalThis as typeof globalThis & { MediaStreamTrackGenerator?: new (options: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } }).MediaStreamTrackGenerator;
  const canvas = document.createElement("canvas");
  const height = (width * 9) / 16;
  canvas.width = width;
  canvas.height = height;
  const painter = canvas.getContext("2d");
  if (!painter) throw new Error("Missing fixture canvas");
  painter.drawImage(portrait, 0, 0, width, height);
  if (!Generator) {
    canvas.style.cssText = "position:fixed;width:1px;height:1px;inset:0;opacity:0.01;pointer-events:none";
    document.body.appendChild(canvas);
  }
  const generated = Generator && typeof VideoFrame === "function" ? new Generator({ kind: "video" }) : undefined;
  const writer = generated?.writable.getWriter();
  const track = generated ?? canvas.captureStream(30).getVideoTracks()[0];
  if (!track) throw new Error("Missing fixture camera track");
  let tick = 0;
  let writing = false;
  const paint = () => {
    if (writing) return;
    tick++;
    const scale = Math.max(width / portrait.width, height / portrait.height) * 1.02;
    const imageWidth = portrait.width * scale;
    const imageHeight = portrait.height * scale;
    painter.drawImage(portrait, (width - imageWidth) / 2 + (Math.sin(tick / 8) * width) / 500, (height - imageHeight) / 2, imageWidth, imageHeight);
    if (!writer) {
      if ("requestFrame" in track && typeof track.requestFrame === "function") track.requestFrame();
      return;
    }
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
      void writer?.abort().catch(() => {});
      track.stop();
      canvas.remove();
    },
  };
}
