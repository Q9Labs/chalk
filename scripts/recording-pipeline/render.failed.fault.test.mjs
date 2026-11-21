// @ts-check
/**
 * Fault scenario for `render.failed` — hop (a) of the symptom's coverage chain.
 * The render job dies terminal on the probe failure the #1505 fix addressed: the rule names the
 * render hop and module against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/render.failed.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyRender, rows, seed, world, T0 } from "./fault.helper.mjs";

test("render.failed: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    kind: "render", jobState: "terminal_failure", errorCode: "render_probe", attemptCount: 4, terminalMs: T0 + 600000,
    failures: [{ attempt: 4, code: "render_probe", at: T0 + 600000 }],
    pipelineState: "terminal_failure", mediaBundles: 3, gapBundles: 0, completeness: "complete", trackCount: 2, packetCount: 1200,
    stopRequestedMs: T0 + 540000, captureCompletedMs: T0 + 560000,
  });
  world({
    logs: {
      "api.log": [rows.apiAttemptFailed("render", 4, "render_probe", "rtp timestamp exceeds presentation duration", T0 + 600000)],
      "recorder.log": [rows.renderStage("compose", T0 + 580000), rows.renderStage("probe", T0 + 590000)],
      "r2.log": [rows.bundleHead(0, "ok", T0 + 570000), rows.bundleHead(1, "ok", T0 + 570000), rows.bundleHead(2, "ok", T0 + 570000)],
    },
  });
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");

  const healthy = await healthyRender();
  const healthyWorld = await captureWorld(healthy.jobId, { extra: healthy.extra });
  handoff("render.failed", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
