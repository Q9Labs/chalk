import { expect, it, vi } from "vitest";
import { ConnectionReporter, type ConnectionReport } from "../connection/report";
import { createCoreTestPlatform } from "../space-client/core.test.helpers";
import { captureClient, stream, track } from "../space-client/capture.test.helpers";
import { markCameraEffectFailure } from "./camera-effects";

it("carries a failed processor through camera termination into the bounded report", async () => {
  const base = createCoreTestPlatform();
  const reports: ConnectionReport[] = [];
  const reporters: ConnectionReporter[] = [];
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      createConnectionReporter: (access: ConstructorParameters<typeof ConnectionReporter>[0]["access"]) => {
        const reporter = new ConnectionReporter({
          access,
          now: Date.now,
          online: () => true,
          subscribeOnline: () => () => {},
          send: async (_access, report) => {
            reports.push(report);
          },
        });
        reporters.push(reporter);
        return reporter;
      },
    },
  };
  const camera = track("video");
  const client = captureClient(platform, { mediaDevices: { getUserMedia: async () => stream([camera]) } });
  try {
    await client.join({ microphone: false, camera: true });
    markCameraEffectFailure(camera);
    camera.stop();
    camera.dispatchEvent(new Event("ended"));
    const reporter = reporters[0];
    if (!reporter) throw new Error("Missing connection reporter");
    reporter.recordDiagnostic({ event: "connection_failed", state: "live", epoch: 1, code: "media_capture_failed" });
    await Promise.resolve();
    expect(reports[0]?.events).toContainEqual(expect.objectContaining({ event: "media_state", code: "media_capture_failed", source: "camera", phase: "failed", media_error_kind: "OperationError", media_error_step: "local_capture" }));
    expect(JSON.stringify(reports)).not.toContain(camera.id);
  } finally {
    client.dispose();
  }
});

it.each([false, true])("does not load camera controls for microphone-only capture (aborted: %s)", async (aborted) => {
  vi.resetModules();
  const load = vi.fn(async () => {
    throw new Error("camera controls unavailable");
  });
  vi.doMock("./camera-effect-operations", load);
  try {
    const { configureCameraEffectProvider, processCameraStream } = await import("./camera-effects");
    configureCameraEffectProvider({ wasmRoot: "/wasm", modelUrl: "/model" }, async () => {
      throw new Error("Unexpected segmenter creation");
    });
    const audio = track("audio");
    const captured = stream([audio]);
    const controller = new AbortController();
    const cancelled = new Error("capture cancelled");
    if (aborted) controller.abort(cancelled);
    const result = processCameraStream(captured, controller.signal);
    if (aborted) await expect(result).rejects.toBe(cancelled);
    else await expect(result).resolves.toBe(captured);
    expect(audio.readyState).toBe(aborted ? "ended" : "live");
    expect(load).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("./camera-effect-operations");
    vi.resetModules();
  }
});

it("stops captured tracks when camera controls fail to load", async () => {
  vi.resetModules();
  const failure = new Error("original controls chunk failure");
  vi.doMock("./camera-effect-operations", async () => {
    throw failure;
  });
  try {
    const { configureCameraEffectProvider, processCameraStream } = await import("./camera-effects");
    configureCameraEffectProvider({ wasmRoot: "/wasm", modelUrl: "/model" }, async () => {
      throw new Error("Unexpected segmenter creation");
    });
    const video = track("video");
    const audio = track("audio");
    const rejection = await processCameraStream(stream([video, audio])).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ cause: failure });
    expect(video.readyState).toBe("ended");
    expect(audio.readyState).toBe("ended");
  } finally {
    vi.doUnmock("./camera-effect-operations");
    vi.resetModules();
  }
});

it("stops the source when camera effects controls fail to load", async () => {
  vi.resetModules();
  const failure = new Error("original controls chunk failure");
  vi.doMock("./camera-effect-operations", async () => {
    throw failure;
  });
  try {
    const { openCameraEffectsTrack } = await import("./camera-effects");
    const source = track("video");
    const rejection = await openCameraEffectsTrack(source, { wasmRoot: "/wasm", modelUrl: "/model" }, async () => {
      throw new Error("Unexpected segmenter creation");
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ cause: failure });
    expect(source.readyState).toBe("ended");
  } finally {
    vi.doUnmock("./camera-effect-operations");
    vi.resetModules();
  }
});
