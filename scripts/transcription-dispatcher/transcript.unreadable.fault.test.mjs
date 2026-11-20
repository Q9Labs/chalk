// @ts-check
/**
 * Fault scenario for `transcript.unreadable` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.unreadable.positive.mjs, a finalize job whose
 * transcription completed with an artifact recorded while the checker's own R2 readback finds no stored object — the
 * transcript cannot be read back — and hands off the telemetry rows that world stands for, plus the healthy run's rows.
 * With CHALK_CHAIN_WRITE=1 it writes the hand-off files under observability/fixtures/transcript.unreadable/chain/; a plain
 * run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.unreadable.healthy.mjs";
import positive from "./chain-inputs/transcript.unreadable.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.unreadable";
const ITEM = "902cd3ac-7d50-448b-ab2b-df90af8f83ca";
const HEALTHY_ITEM = "449afad6-cf36-466c-8df8-8f4fecd69d30";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: a completed transcript's artifact reads back not_found from R2`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_finalize", "the captured item is the finalize job under test");

  const [row] = obsOf(positive, ITEM, "transcript.row");
  assert.equal(row?.claim, "complete", "the transcription completed");
  assert.equal(row?.value.transcript_artifact_set, true, "an artifact was recorded");
  assert.equal(row?.value.transcript_sha_set, true, "with its checksum recorded");
  const [object] = obsOf(positive, ITEM, "transcript.object");
  assert.equal(object?.claim, "not_found", "the checker's R2 readback finds no stored object");

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
