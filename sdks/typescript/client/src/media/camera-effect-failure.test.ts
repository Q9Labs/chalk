import { expect, it } from "vitest";
import { createCoreTestPlatform } from "../space-client/core.test.helpers";
import { createTestOutbox } from "../telemetry/outbox.test.helpers";
import { captureClient, stream, track } from "../space-client/capture.test.helpers";
import { configureCameraEffectProvider, loadControlsOwning, markCameraEffectFailure, processCameraStream } from "./camera-effects";

it("carries a failed processor through camera termination into the bounded report", async () => {
  const base = createCoreTestPlatform();
  const telemetry = createTestOutbox();
  const platform = { ...base, dependencies: { ...base.dependencies, telemetry: telemetry.outbox } };
  const camera = track("video");
  const client = captureClient(platform, { mediaDevices: { releaseTrack: (stopped) => stopped.stop(), getUserMedia: async () => stream([camera]) } });
  try {
    await client.join({ microphone: false, camera: true });
    markCameraEffectFailure(camera);
    camera.stop();
    camera.dispatchEvent(new Event("ended"));
    await telemetry.outbox.flush();
    expect(telemetry.accepted).toContainEqual(expect.objectContaining({ type: "media_state", code: "media_capture_failed", source: "camera", phase: "failed", media_error_kind: "OperationError", media_error_step: "local_capture" }));
    expect(JSON.stringify(telemetry.accepted)).not.toContain(camera.id);
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
