// @ts-check
/**
 * Fault scenario for `transcript.attempt_lost` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.attempt_lost.positive.mjs, a chunk job still leased with
 * an expired lease and no accepted result or retry decision — the attempt was lost — and hands off the telemetry rows that
 * world stands for, plus the healthy run's rows. With CHALK_CHAIN_WRITE=1 it writes the hand-off files under
 * observability/fixtures/transcript.attempt_lost/chain/; a plain run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.attempt_lost.healthy.mjs";
import positive from "./chain-inputs/transcript.attempt_lost.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.attempt_lost";
const ITEM = "0db0d804-c5be-4148-842f-2318467ddef7";
const HEALTHY_ITEM = "712aa20d-c655-433f-b04b-d4696c167efd";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: a leased chunk job's lease expires with no accepted attempt, result or retry`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_chunk", "the captured item is the chunk job under test");

  const [job] = obsOf(positive, ITEM, "transcript.job_state");
  assert.equal(job?.claim, "leased", "the job still sits leased");
  assert(job.value.transcript_lease_expiry_ms <= positive.asof_ms, `the lease expired at ${job.value.transcript_lease_expiry_ms}, before asof ${positive.asof_ms}`);
  const [claim] = obsOf(positive, ITEM, "transcript.claim_decision");
  assert.equal(claim?.value.decision, "leased", "attempt 1 was leased out");
  for (const fact of ["transcript.complete_decision", "transcript.retry_decision", "transcript.attempts", "transcript.chunk_op"]) {
    assert.equal(obsOf(positive, ITEM, fact).length, 0, `the lost attempt left no ${fact} row`);
  }

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
