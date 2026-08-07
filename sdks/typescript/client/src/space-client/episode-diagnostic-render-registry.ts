import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";

const REGISTRY = Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1");

type RenderObservation = "first_frame" | "not_observable";
type RenderReporter = (observation: RenderObservation) => void;
type DiagnosticGlobal = typeof globalThis & { [REGISTRY]?: WeakMap<object, RenderReporter> };
const renderOwners = new WeakMap<object, EpisodeDiagnosticRuntime>();
const completedTracksByRuntime = new WeakMap<object, WeakSet<EpisodeDiagnosticRuntime>>();

export function registerEpisodeDiagnosticTrack(track: MediaStreamTrack, source: "camera" | "screen", diagnostics: EpisodeDiagnosticRuntime): void {
  try {
    if (completedTracksByRuntime.get(track)?.has(diagnostics) || renderOwners.get(track) === diagnostics) return;
    const registry = renderRegistry();
    let observed = false;
    renderOwners.set(track, diagnostics);
    registry.set(track, (observation) => {
      if (observed) return;
      observed = true;
      const completed = completedTracksByRuntime.get(track) ?? new WeakSet<EpisodeDiagnosticRuntime>();
      completed.add(diagnostics);
      completedTracksByRuntime.set(track, completed);
      const name = source === "screen" ? "screen.start" : "camera.publish";
      if (observation === "first_frame") {
        diagnostics.observe({ name, phase: "first_frame", state: "observed", checkpoint: source === "screen" ? "remote_first_frame" : "terminal", attributes: { direction: "remote", media_kind: source } });
      } else {
        diagnostics.observe({ name, phase: "not_observable", state: "not_observable", checkpoint: source === "screen" ? "remote_first_frame" : "terminal", attributes: { direction: "remote", media_kind: source, reason: "platform_render_unobservable" } });
      }
      registry.delete(track);
      renderOwners.delete(track);
    });
  } catch {
    // Render diagnostics cannot affect track projection.
  }
}

export function unregisterEpisodeDiagnosticTrack(track: MediaStreamTrack, diagnostics?: EpisodeDiagnosticRuntime): void {
  try {
    if (diagnostics !== undefined && renderOwners.get(track) !== diagnostics) return;
    renderRegistry().delete(track);
    renderOwners.delete(track);
  } catch {
    // Render diagnostics cannot affect track teardown.
  }
}

function renderRegistry(): WeakMap<object, RenderReporter> {
  const target = globalThis as DiagnosticGlobal;
  target[REGISTRY] ??= new WeakMap<object, RenderReporter>();
  return target[REGISTRY];
}
