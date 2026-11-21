// @ts-check
/**
 * Fault scenario for `recording.artifact_unreadable` — hop (a) of the symptom's coverage chain.
 * The artifact commits but the stored bytes fail the committed checksum: the real readback
 * (HEAD + sha256 over the object's actual bytes) proves it and the rule names
 * artifact_readback/storage.r2 against real isolated Postgres.
 * CHALK_CHAIN_WRITE=1 rewrites the hand-off; a plain run compares it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as rule from "../../observability/rules/recording.artifact_unreadable.mjs";
import { captureWorld, containerUp, decideFor, handoff, healthyRender, readbackRows, seed, world, T0 } from "./fault.helper.mjs";

test("recording.artifact_unreadable: the seeded fault names the expected outcome and hop", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId, recordingId } = seed({
    kind: "render", jobState: "succeeded", recordingStatus: "completed", completedMs: T0 + 700000,
    pipelineState: "committed", mediaBundles: 3, gapBundles: 0, completeness: "complete", trackCount: 2, packetCount: 1200,
    stopRequestedMs: T0 + 540000, captureCompletedMs: T0 + 560000, committedMs: T0 + 700000,
    artifact: { complete: true, size: 12345, sha: "ab".repeat(16), duration: 30000 },
  });
  world({ objects: { "obj/k": { bytes: Buffer.alloc(12345, 0x0) } } });
  const extra = readbackRows(recordingId, jobId);
  assert.equal(extra[0]?.recording_r2_result, "checksum_mismatch");
  const obs = await decideFor(jobId, rule, { extra });
  assert.equal(obs.decision.status, "finding");
  assert.equal(obs.decision.hop, "artifact_readback");
  assert.equal(obs.decision.module, "storage.r2");

  const healthy = await healthyRender();
  const healthyWorld = await captureWorld(healthy.jobId, { extra: healthy.extra });
  handoff("recording.artifact_unreadable", { world: obs.world, item: jobId }, { world: healthyWorld.world, item: healthy.jobId });
});
