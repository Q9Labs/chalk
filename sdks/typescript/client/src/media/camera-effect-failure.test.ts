import { expect, it } from "vitest";
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
