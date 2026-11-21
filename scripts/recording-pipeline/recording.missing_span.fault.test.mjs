// @ts-check
/**
 * Fault scenario for `recording.missing_span` — hop (a) of the symptom's coverage chain.
 * A claimed capture whose claim lag ran past the fleet bound while a failed attempt preceded it:
 * the rule reports the degraded span at capture_claim against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.missing_span.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyCapture, rows, seed, world, T0 } from "./fault.helper.mjs";

test("recording.missing_span: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    jobState: "leased", attemptCount: 2, claimLagMs: 200000, placement: "fleet", leaseExpiresMs: T0 + 3600000,
    failures: [{ attempt: 1, code: "media_io", at: T0 + 120000 }],
    journeyEvents: [{ name: "recording.failed", phase: "capture_attempt", state: "failed", at: T0 + 120000, attributes: { error_code: "media_io", capture_outcome: "failed" } }],
    pipelineState: "capturing_segmented", mediaBundles: 0, gapBundles: 0, trackCount: 1, packetCount: 400,
    captureCompletedMs: T0 + 590000, pipelineUpdatedMs: T0 + 300000,
  });
  world({
    logs: {
      "api.log": [rows.apiClaim(2, 200000, "fleet", T0 + 200000), rows.apiAttemptFailed("capture", 1, "media_io", "write failed", T0 + 120000)],
      "recorder.log": [rows.captureAttempt(2, 400, 1, "explicit", T0 + 550000), rows.captureFinished("stopped", 400, 1, "explicit", T0 + 590000)],
      "sfu.log": [rows.sfuTransport("cap1", 200, 400, true, T0 + 590000)],
    },
  });
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "capture_claim");
  assert.equal(obs.decision.outcome, "degraded");

  const healthy = healthyCapture();
  const healthyWorld = await captureWorld(healthy.jobId);
  handoff("recording.missing_span", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
