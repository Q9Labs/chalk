// @ts-check
/**
 * Fault scenario for `transcript.wake_lost` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.wake_lost.positive.mjs, a chunk job whose wake failed and
 * whose first claim landed more than ninety seconds after the job was created — the wake was lost and nothing retried it —
 * and hands off the telemetry rows that world stands for, plus the healthy run's rows. With CHALK_CHAIN_WRITE=1 it writes the
 * hand-off files under observability/fixtures/transcript.wake_lost/chain/; a plain run compares them, so a stale hand-off
 * fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.wake_lost.healthy.mjs";
import positive from "./chain-inputs/transcript.wake_lost.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.wake_lost";
const ITEM = "00e68204-2ea1-418a-9baf-a7609ad7a1c4";
const HEALTHY_ITEM = "712aa20d-c655-433f-b04b-d4696c167efd";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: a failed wake is followed by a first claim more than ninety seconds after creation`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_chunk", "the captured item is the chunk job under test");

  const [wake] = obsOf(positive, ITEM, "transcript.wake_decision");
  assert.equal(wake?.claim, "failed", "the wake decision failed");
  assert.equal(wake?.value.reason_code, "transcript.wake_failed", "the failure is the wake itself");
  const [job] = obsOf(positive, ITEM, "transcript.job_state");
  const claims = obsOf(positive, ITEM, "transcript.claim_decision").sort((a, b) => a.window.to_ms - b.window.to_ms);
  assert.equal(claims[0]?.value.decision, "leased", "the job was eventually claimed");
  const gap = claims[0].window.to_ms - job.value.transcript_created_ms;
  assert(gap > 90_000, `the first claim came ${gap} ms after the job was created, over the 90 s wake budget`);

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
