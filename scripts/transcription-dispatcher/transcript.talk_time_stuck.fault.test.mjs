// @ts-check
/**
 * Fault scenario for `transcript.talk_time_stuck` — hop (a) of the symptom's coverage chain.
 *
 * It reads the captured world committed at chain-inputs/transcript.talk_time_stuck.positive.mjs, an Episode whose talk time
 * still says `transcript_pending` while its only in-progress Recording's prep died in terminal failure more than ten
 * minutes earlier and no complete transcript exists — the serve path can never unblock — and hands off the telemetry rows
 * that world stands for, plus the healthy run's rows. With CHALK_CHAIN_WRITE=1 it writes the hand-off files under
 * observability/fixtures/transcript.talk_time_stuck/chain/; a plain run compares them, so a stale hand-off fails here.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import healthy from "./chain-inputs/transcript.talk_time_stuck.healthy.mjs";
import positive from "./chain-inputs/transcript.talk_time_stuck.positive.mjs";
import { borrowedWorlds, chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";

const CODE = "transcript.talk_time_stuck";
const ITEM = "2880ef83-01c5-4f2c-acc4-36450643529d";
const HEALTHY_ITEM = "fc53da9b-32e7-4657-b4f3-d071a6cf5bca";
const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "observability", "fixtures", CODE, "chain");

/** @param {any} world @param {string} item @param {string} fact */
const obsOf = (world, item, fact) => world.evidence[item].observations.filter((o) => o.fact === fact);

test(`${CODE}: talk time stays transcript_pending ten minutes after the only prep died`, async () => {
  const decl = positive.declarations.find((d) => d.id === ITEM);
  assert(decl?.kind === "episode", "the captured item is the Episode under test");

  const [talk] = obsOf(positive, ITEM, "transcript.talk").filter((o) => o.source === "db");
  assert.equal(talk?.claim, "transcript_pending", "talk time still reports transcript_pending");
  assert.equal(talk?.value.transcript_in_progress, 1, "its one in-flight transcription is the dead prep");
  const [recording] = obsOf(positive, ITEM, "transcript.recording");
  assert.equal(recording?.claim, "completed", "the Recording itself completed");
  const [row] = obsOf(positive, ITEM, "transcript.row");
  assert.equal(row?.claim, "none", "no transcript exists at all");
  const [prep] = obsOf(positive, ITEM, "transcript.prep");
  assert.equal(prep?.claim, "terminal_failure", "its transcription prep died terminally");
  assert(prep.value.transcript_terminal_ms <= positive.asof_ms - 600_000, `the prep failed at ${prep.value.transcript_terminal_ms}, more than ten minutes before asof ${positive.asof_ms}`);

  const worlds = await borrowedWorlds(CODE, coverage);
  const positiveFiles = chainFiles(itemRows(positive, ITEM), coverageRows(CODE, coverage, worlds, { asof_ms: positive.asof_ms, tenant: decl.tenant }), "positive");
  const healthyFiles = chainFiles(itemRows(healthy, HEALTHY_ITEM), { witness: [], coverage: [] }, "healthy");
  writeOrCompareRows(CHAIN, [...positiveFiles, ...healthyFiles]);
});
