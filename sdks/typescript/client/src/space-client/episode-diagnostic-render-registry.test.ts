import { describe, expect, it } from "vitest";
import { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import { registerEpisodeDiagnosticTrack, unregisterEpisodeDiagnosticTrack } from "./episode-diagnostic-render-registry";

const NOW = Date.parse("2026-08-04T10:00:00.000Z");
const REGISTRY = Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1");

describe("registerEpisodeDiagnosticTrack", () => {
  it("turns one web frame callback into conditional screen-share proof", () => {
    const runtime = makeRuntime();
    const track = {} as MediaStreamTrack;
    registerEpisodeDiagnosticTrack(track, "screen", runtime);
    const report = (globalThis as unknown as Record<symbol, WeakMap<object, (observation: "first_frame" | "not_observable") => void>>)[REGISTRY]?.get(track);

    report?.("first_frame");
    report?.("first_frame");

    expect(runtime.inspect().ring.filter((event) => event.name === "screen.start" && event.phase === "first_frame")).toHaveLength(1);
  });

  it("records native renderer opacity as not observable rather than success", () => {
    const runtime = makeRuntime();
    const track = {} as MediaStreamTrack;
    registerEpisodeDiagnosticTrack(track, "camera", runtime);

    (globalThis as unknown as Record<symbol, WeakMap<object, (observation: "first_frame" | "not_observable") => void>>)[REGISTRY]?.get(track)?.("not_observable");

    expect(runtime.inspect().ring.at(-1)).toMatchObject({ name: "camera.publish", phase: "not_observable", state: "not_observable", attributes: { reason: "platform_render_unobservable" } });
  });

  it("does not re-register a completed track and removes pending tracks on teardown", () => {
    const runtime = makeRuntime();
    const track = {} as MediaStreamTrack;
    registerEpisodeDiagnosticTrack(track, "camera", runtime);
    const registry = (globalThis as unknown as Record<symbol, WeakMap<object, (observation: "first_frame" | "not_observable") => void>>)[REGISTRY];
    registry?.get(track)?.("first_frame");
    registerEpisodeDiagnosticTrack(track, "camera", runtime);
    expect(registry?.get(track)).toBeUndefined();

    const pendingTrack = {} as MediaStreamTrack;
    registerEpisodeDiagnosticTrack(pendingTrack, "camera", runtime);
    unregisterEpisodeDiagnosticTrack(pendingTrack, runtime);
    expect(registry?.get(pendingTrack)).toBeUndefined();
  });
});

function makeRuntime(): EpisodeDiagnosticRuntime {
  let id = 0;
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const runtime = new EpisodeDiagnosticRuntime({ apiBaseUrl: "https://api.chalk.test", createId: () => `sdk-id-${++id}`, now: () => NOW, setTimeout: () => 1, clearTimeout: () => undefined, exporter: async () => undefined });
  runtime.rotateCredential({ token: `${encode({ alg: "none" })}.${encode({ aud: "chalk-diagnostics" })}.signature`, expiresAt: new Date(NOW + 60_000).toISOString(), generation: 1, intakePath: "/_internal/episode-diagnostic-events" });
  return runtime;
}
