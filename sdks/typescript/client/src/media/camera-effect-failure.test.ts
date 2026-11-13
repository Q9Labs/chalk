import { expect, it } from "vitest";
import { ConnectionReporter, type ConnectionReport } from "../connection/report";
import { createCoreTestPlatform } from "../space-client/core.test.helpers";
import { captureClient, stream, track } from "../space-client/capture.test.helpers";
import { configureCameraEffectProvider, loadControlsOwning, markCameraEffectFailure, processCameraStream } from "./camera-effects";

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
  const client = captureClient(platform, { mediaDevices: { releaseTrack: (stopped) => stopped.stop(), getUserMedia: async () => stream([camera]) } });
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

it.each([false, true])("passes microphone-only capture through untouched (aborted: %s)", async (aborted) => {
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
});

it("stops the tracks it owns and rethrows when camera controls fail to load", async () => {
  const failure = new Error("original controls chunk failure");
  const video = track("video");
  const audio = track("audio");
  const rejection = await loadControlsOwning([video, audio], async () => {
    throw failure;
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBe(failure);
  expect(video.readyState).toBe("ended");
  expect(audio.readyState).toBe("ended");
});
