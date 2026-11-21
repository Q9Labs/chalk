// @ts-check
/**
 * Fault scenario for `recording.empty` — hop (a) of the symptom's coverage chain.
 * The capture reports capture_empty while the SFU witnessed a participant publishing media: the
 * rule names capture_complete as the broken hop. The sfu rows are the emitter's own output,
 * replayed through the local-log evidence source against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.empty.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyCapture, rows, seed, world, T0 } from "./fault.helper.mjs";

test("recording.empty: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    jobState: "terminal_failure", errorCode: "capture_empty", attemptCount: 1, terminalMs: T0 + 600000,
    pipelineState: "capture_complete", mediaBundles: 0, gapBundles: 0, completeness: "partial", trackCount: 0, packetCount: 0,
    stopRequestedMs: T0 + 540000, captureCompletedMs: T0 + 560000,
  });
  world({
    logs: {
      "sfu.log": [
        rows.sfuSession("participant", "p1", T0 + 60000), rows.sfuSession("capture", "cap1", T0 + 61000),
        rows.sfuPublication("p1", "camera", "video", T0 + 62000),
        rows.sfuIngress("p1", "video", 1200, false, T0 + 100000), rows.sfuTransport("cap1", 0, 0, true, T0 + 540000),
        rows.sfuClosed("capture", "cap1", "completed", T0 + 590000),
      ],
      "recorder.log": [rows.captureAttempt(1, 0, 0, "explicit", T0 + 550000), rows.captureFinished("stopped_without_media", 0, 0, "explicit", T0 + 560000)],
      "client.log": [rows.mediaPublish("publish", "succeeded", T0 + 62000)],
    },
  });
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "capture_complete");

  const healthy = healthyCapture();
  const healthyWorld = await captureWorld(healthy.jobId);
  handoff("recording.empty", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
