// @ts-check
/**
 * Fault scenario for `transcript.late` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.late.positive.mjs, a finalize job whose transcription
 * completed more than sixty minutes after it was created, and hands off the telemetry rows that world stands for, plus the
 * healthy run's rows. With CHALK_CHAIN_WRITE=1 it writes the hand-off files under
 * observability/fixtures/transcript.late/chain/; a plain run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.late.healthy.mjs";
import positive from "./chain-inputs/transcript.late.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.late";
const ITEM = "a53efec4-341e-4ecf-b30c-3ceab00b4a25";
const HEALTHY_ITEM = "449afad6-cf36-466c-8df8-8f4fecd69d30";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: a finalize job's transcription completes more than sixty minutes after creation`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_finalize", "the captured item is the finalize job under test");

  const [job] = obsOf(positive, ITEM, "transcript.job_state");
  assert.equal(job?.claim, "completed", "the job did complete, only late");
  const [row] = obsOf(positive, ITEM, "transcript.row");
  assert.equal(row?.claim, "complete", "the transcription completed");
  const elapsed = row.value.transcript_completed_ms - row.value.transcript_created_ms;
  assert(elapsed > 3_600_000, `completion came ${elapsed} ms after creation, over the 60 min lateness budget`);

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
