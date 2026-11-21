// @ts-check
/**
 * Fault scenario for `recording.stuck` — hop (a) of the symptom's coverage chain.
 * A leased capture job whose pipeline stopped moving long before the Episode-end bound: the rule
 * names the unmoving hop against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.stuck.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyCapture, seed, world, T0 } from "./fault.helper.mjs";

test("recording.stuck: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    jobState: "leased", attemptCount: 1, claimLagMs: 5000, leaseExpiresMs: T0 + 120000,
    pipelineState: "capturing_segmented", mediaBundles: 1, gapBundles: 0, trackCount: 1, packetCount: 400,
    jobUpdatedMs: T0 + 30000, pipelineUpdatedMs: T0 + 30000,
  });
  world({});
  const obs = await decideFor(jobId, rule, { asOf: T0 + 4 * 3600000 });
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "capture_attempt");

  const healthy = healthyCapture();
  const healthyWorld = await captureWorld(healthy.jobId);
  handoff("recording.stuck", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
