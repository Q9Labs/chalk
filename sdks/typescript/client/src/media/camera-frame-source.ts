// Chromium's window-level insertable-stream APIs; other browsers hide the picker.
type FrameProcessor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => { readable: ReadableStream<VideoFrame> };
type FrameGenerator = new (options: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
const environment = globalThis as typeof globalThis & { MediaStreamTrackProcessor?: FrameProcessor; MediaStreamTrackGenerator?: FrameGenerator };

export function cameraFrameProcessingSupported(): boolean {
  return typeof environment.MediaStreamTrackProcessor === "function" && typeof environment.MediaStreamTrackGenerator === "function" && typeof VideoFrame === "function";
}

/** Frame arrival drives processing even when the document is not being rendered. */
export function createCameraFrameSource(source: MediaStreamTrack) {
  const Processor = environment.MediaStreamTrackProcessor;
  const Generator = environment.MediaStreamTrackGenerator;
  if (!Processor || !Generator) throw new Error("Camera frame processing is unavailable");
  const reader = new Processor({ track: source, maxBufferSize: 1 }).readable.getReader();
  const track = new Generator({ kind: "video" });
  const writer = track.writable.getWriter();
  const nativeStop = track.stop.bind(track);
  return {
    track,
    reader,
    writer,
    stop() {
      void reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
      nativeStop();
    },
  };
}
