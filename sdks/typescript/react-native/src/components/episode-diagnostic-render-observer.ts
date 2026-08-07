const REGISTRY = Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1");

type RenderReporter = (observation: "first_frame" | "not_observable") => void;
type DiagnosticGlobal = typeof globalThis & { [REGISTRY]?: WeakMap<object, RenderReporter> };

export function observeNativeFrameNotObservable(track: object): void {
  try {
    (globalThis as DiagnosticGlobal)[REGISTRY]?.get(track)?.("not_observable");
  } catch {
    // Native rendering stays independent from diagnostic observation.
  }
}
