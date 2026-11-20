// @ts-check
/**
 * Fault scenario for `transcript.stuck` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.stuck.positive.mjs, a chunk job still `pending` whose
 * available time passed more than five minutes before the as-of — queued work nobody claimed — and hands off the telemetry
 * rows that world stands for, plus the healthy run's rows. With CHALK_CHAIN_WRITE=1 it writes the hand-off files under
 * observability/fixtures/transcript.stuck/chain/; a plain run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.stuck.healthy.mjs";
import positive from "./chain-inputs/transcript.stuck.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.stuck";
const ITEM = "0e96f1ef-41e1-4802-abc2-c76ddffd751c";
const HEALTHY_ITEM = "712aa20d-c655-433f-b04b-d4696c167efd";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: a pending chunk job's due time passed five minutes ago with no claim`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_chunk", "the captured item is the chunk job under test");

  const [job] = obsOf(positive, ITEM, "transcript.job_state");
  assert.equal(job?.claim, "pending", "the job was never claimed");
  assert(job.value.transcript_available_ms <= positive.asof_ms - 300_000, `the job went available at ${job.value.transcript_available_ms}, more than five minutes before asof ${positive.asof_ms}`);
  assert.equal(obsOf(positive, ITEM, "transcript.claim_decision").length, 0, "no claim decision exists for the job");
  const [row] = obsOf(positive, ITEM, "transcript.row");
  assert.equal(row?.claim, "preparing", "the transcription still waits on transcription work");

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
