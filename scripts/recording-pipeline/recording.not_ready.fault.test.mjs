// @ts-check
/**
 * Fault scenario for `recording.not_ready` — hop (a) of the symptom's coverage chain.
 * A render job dead in terminal_failure while the dashboard wants a download: the rule names the
 * recorder hop against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.not_ready.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyRender, seed, world, T0 } from "./fault.helper.mjs";

test("recording.not_ready: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    kind: "render", jobState: "terminal_failure", errorCode: "render_probe", attemptCount: 4, terminalMs: T0 + 900000,
    pipelineState: "terminal_failure", recordingStatus: "failed", failureCode: "render_lost", failedMs: T0 + 900000,
  });
  world({});
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "recorder");

  const healthy = await healthyRender();
  const healthyWorld = await captureWorld(healthy.jobId, { extra: healthy.extra });
  handoff("recording.not_ready", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
