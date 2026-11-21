// @ts-check
/**
 * Fault scenario for `playback.url_expired` — hop (a) of the symptom's coverage chain.
 * The dashboard played on a URL older than its signed lifetime: the API mint row and the player's
 * media_error row are the emitters' own output, replayed through the local-log evidence source.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/playback.url_expired.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyRender, rows, seed, world, T0 } from "./fault.helper.mjs";

const LIFETIME = 600_000;

test("playback.url_expired: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({ kind: "render", jobState: "succeeded", pipelineState: "committed", recordingStatus: "completed", artifact: { complete: true } });
  world({
    logs: {
      "api.log": [rows.mint(T0 + 120000, LIFETIME, T0 + 120000)],
      "web.log": [rows.mediaError(2, LIFETIME + 60000, LIFETIME, T0 + 120000 + LIFETIME + 60000)],
    },
  });
  const obs = await decideFor(jobId, rule);
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "player");

  const healthy = await healthyRender();
  const healthyWorld = await captureWorld(healthy.jobId, { extra: healthy.extra });
  handoff("playback.url_expired", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
