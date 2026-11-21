// @ts-check
/**
 * Fault scenario for `playback.decode_failed` — hop (a) of the symptom's coverage chain.
 * The stored object reads back clean (a real ffmpeg-generated MP4, real sha256 committed, real
 * ffprobe/decode pass) and the player still fails inside the URL's lifetime: the rule names the
 * player hop against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/playback.decode_failed.mjs";
import { captureWorld, commitObject, containerUp, decideFor, handoff, healthyRender, readbackRows, rows, seed, world, T0 } from "./fault.helper.mjs";

const LIFETIME = 3_600_000;

test("playback.decode_failed: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId, recordingId } = seed({ kind: "render", jobState: "succeeded", pipelineState: "committed", recordingStatus: "completed", artifact: { complete: true } });
  const { r2Dir } = world({
    objects: { "obj/k": { mp4: { seconds: 2 } } },
    logs: { "web.log": [rows.mediaError(3, 60000, LIFETIME, T0 + 180000), rows.playerErrorNote("pl1", T0 + 181000)] },
  });
  commitObject(recordingId, jobId, "obj/k", r2Dir);
  const extra = readbackRows(recordingId, jobId);
  assert.equal(extra[0]?.recording_r2_result, "ok", "the seeded object's readback must be readable");
  const obs = await decideFor(jobId, rule, { extra });
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "player");

  const healthy = await healthyRender();
  const healthyWorld = await captureWorld(healthy.jobId, { extra: healthy.extra });
  handoff("playback.decode_failed", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
