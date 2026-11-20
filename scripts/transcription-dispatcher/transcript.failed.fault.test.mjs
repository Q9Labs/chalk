// @ts-check
/**
 * Fault scenario for `transcript.failed` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.failed.positive.mjs, a chunk job that dead-lettered on
 * `provider_rejected` while its transcription ended `terminal_failure`, and hands off the telemetry rows that world stands
 * for, plus the healthy run's rows. With CHALK_CHAIN_WRITE=1 it writes the hand-off files under
 * observability/fixtures/transcript.failed/chain/; a plain run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.failed.healthy.mjs";
import positive from "./chain-inputs/transcript.failed.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.failed";
const ITEM = "5d714255-497c-46bd-b3a7-168fe6f8c0c7";
const HEALTHY_ITEM = "712aa20d-c655-433f-b04b-d4696c167efd";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: a chunk job dead-letters on provider_rejected with a terminal-failure transcription`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_chunk", "the captured item is the chunk job under test");

  const [job] = obsOf(positive, ITEM, "transcript.job_state");
  assert.equal(job?.claim, "dead_letter", "the job is dead-lettered");
  assert.equal(job?.value.transcript_error_code, "provider_rejected", "the job's last error is the provider's rejection");
  const [row] = obsOf(positive, ITEM, "transcript.row");
  assert.equal(row?.claim, "terminal_failure", "the transcription ended in terminal failure");
  const [retry] = obsOf(positive, ITEM, "transcript.retry_decision");
  assert.equal(retry?.value.decision, "dead_letter", "the retry decision sent the job to the dead letter");
  const [chunk] = obsOf(positive, ITEM, "transcript.chunk_op");
  assert.equal(chunk?.claim, "error", "the chunk lambda failed");
  assert.equal(chunk?.value.reason_code, "transcript.provider_rejected", "the chunk failure is the provider's rejection");

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
