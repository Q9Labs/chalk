// @ts-check
/**
 * Fault scenario for `recording.never_captured` — hop (a) of the symptom's coverage chain.
 * The capture job is still pending when the Episode ends: the stopped_before_claim shape.
 * The claim rows such a world can never emit are covered by the chain's synthetic coverage file.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.never_captured.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyCapture, seed, world, T0 } from "./fault.helper.mjs";

test("recording.never_captured: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({ jobState: "pending", pipelineState: "reserved", reservationStartsMs: T0, syncStatus: "starting" });
  world({});
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "capture_claim");

  const healthy = healthyCapture();
  const healthyWorld = await captureWorld(healthy.jobId);
  handoff("recording.never_captured", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
