// @ts-check
/**
 * Fault scenario for `transcript.speech_dropped` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.speech_dropped.positive.mjs, a finalize job whose
 * accepted provider attempt measured over two seconds of speech while the stored transcript holds zero cues — the provider
 * heard speech but dropped it — and hands off the telemetry rows that world stands for, plus the healthy run's rows. With
 * CHALK_CHAIN_WRITE=1 it writes the hand-off files under observability/fixtures/transcript.speech_dropped/chain/; a plain
 * run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.speech_dropped.healthy.mjs";
import positive from "./chain-inputs/transcript.speech_dropped.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.speech_dropped";
const ITEM = "51006a31-15db-47a7-a08f-c79559eddd68";
const HEALTHY_ITEM = "449afad6-cf36-466c-8df8-8f4fecd69d30";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: an accepted attempt measured speech while the stored transcript holds zero cues`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "job" && decl.job_kind === "transcription_finalize", "the captured item is the finalize job under test");

  const [row] = obsOf(positive, ITEM, "transcript.row");
  assert.equal(row?.claim, "complete", "the transcription completed");
  const [attempt] = obsOf(positive, ITEM, "transcript.attempts");
  assert.equal(attempt?.claim, "accepted", "the provider attempt was accepted");
  assert.equal(attempt?.value.transcript_provider, "openrouter", "the attempt ran on the openrouter provider");
  assert(attempt.value.transcript_observed_ms >= 2_000, `the provider measured ${attempt.value.transcript_observed_ms} ms of speech`);
  const [object] = obsOf(positive, ITEM, "transcript.object");
  assert.equal(object?.claim, "ok", "the stored document read back fine");
  assert.equal(object?.value.transcript_cue_count, 0, "yet it holds zero speech cues");

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
