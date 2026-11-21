// @ts-check
/**
 * Fault scenario for `recording.capture_failed` — hop (a) of the symptom's coverage chain.
 * A capture job dies terminal on a media_io attempt failure against real isolated Postgres; the
 * durable rows, the recorder's own output and the claim journal are read back, judged, and handed
 * to the chain as the run's telemetry rows (plus the healthy run's). CHALK_CHAIN_WRITE=1 rewrites
 * the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.capture_failed.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyCapture, rows, seed, world, T0 } from "./fault.helper.mjs";

test("recording.capture_failed: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    jobState: "terminal_failure", errorCode: "media_io", attemptCount: 4, terminalMs: T0 + 600000,
    failures: [{ attempt: 1, code: "media_io", at: T0 + 120000 }],
    journeyEvents: [{ name: "recording.failed", phase: "capture_attempt", state: "failed", at: T0 + 600000, attributes: { error_code: "media_io", capture_outcome: "failed" } }],
    pipelineState: "capture_complete", mediaBundles: 0, gapBundles: 0, completeness: "partial", trackCount: 0, packetCount: 0,
    stopRequestedMs: T0 + 540000, captureCompletedMs: T0 + 560000,
  });
  world({
    logs: {
      "api.log": [rows.apiAttemptFailed("capture", 1, "media_io", "write failed", T0 + 120000)],
      "recorder.log": [rows.captureAttempt(1, 0, 0, "error", T0 + 110000), rows.captureFinished("failed", 0, 0, "error", T0 + 600000)],
      "sfu.log": [rows.sfuSession("capture", "cap1", T0 + 61000), rows.sfuClosed("capture", "cap1", "failed", T0 + 595000)],
    },
  });
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "capture_attempt");

  const healthy = healthyCapture();
  const healthyWorld = await captureWorld(healthy.jobId);
  handoff("recording.capture_failed", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
