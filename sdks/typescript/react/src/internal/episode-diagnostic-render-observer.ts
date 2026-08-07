const REGISTRY = Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1");

type RenderReporter = (observation: "first_frame" | "not_observable") => void;
type DiagnosticGlobal = typeof globalThis & { [REGISTRY]?: WeakMap<object, RenderReporter> };
type VideoFrameElement = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

export function observeFirstRenderedFrame(element: HTMLVideoElement, track: MediaStreamTrack): void {
  try {
    const report = (globalThis as DiagnosticGlobal)[REGISTRY]?.get(track);
    if (!report) return;
    const video = element as VideoFrameElement;
    if (!video.requestVideoFrameCallback) {
      report("not_observable");
      return;
    }
    video.requestVideoFrameCallback(() => report("first_frame"));
  } catch {
    // Rendering stays independent from diagnostic observation.
  }
}
