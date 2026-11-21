// @ts-check
/**
 * The last hop of every slice-12 chain: joins the stack rows the Go fault scenario captured into the symptom's positive and
 * healthy fixtures, then judges them through the same judge the coverage gate and `diagnose` use. The positive fixture must
 * give a finding with the symptom's code; the healthy fixture must check the tenant day and give none.
 *
 *   CHALK_OBS_SYMPTOM=webhook.event_missing node --test scripts/diagnose-call/proof/webhooks-chain.test.mjs
 *
 * CHALK_CHAIN_WRITE=1 rewrites the fixtures; otherwise they are compared.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { judgeFixture } from "./rows.mjs";
import { checkFrom } from "./catalogue.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const code = process.env.CHALK_OBS_SYMPTOM;
const CHAIN = `observability/fixtures/${code}/chain`;

// The webhook chains and the integration chains each prove on their own tenant id so the two Go package
// binaries can run in parallel on the shared gate database.
const TENANT = code.startsWith("integration.") ? "c2000000-0000-4000-8000-00000000000c" : "c1000000-0000-4000-8000-00000000000c";
const DAY = {
  kind: /** @type {const} */ ("tenant"),
  id: TENANT,
  tenant: TENANT,
  day: "2026-11-20",
  window: { from_ms: 1_795_600_000_000, to_ms: 1_795_604_000_000 },
};

const read = (/** @type {string} */ path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const writeOrCompare = (/** @type {string} */ path, /** @type {unknown} */ value) => {
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") {
    writeFileSync(join(root, path), text);
    return;
  }
  assert.deepEqual(read(path), JSON.parse(text), `${path} is not the chain's fixture: run the chain in order with CHALK_CHAIN_WRITE=1`);
};

test(`${code}: the fault scenario's rows judge to its finding, the healthy run to none`, async (t) => {
  assert.ok(code, "CHALK_OBS_SYMPTOM names the symptom this hop builds");
  const symptom = JSON.parse(readFileSync(join(root, "observability/generated/registry.json"), "utf8")).symptoms.find((entry) => entry.code === code);
  assert.ok(symptom, `${code} is not in the generated registry`);
  const check = checkFrom(symptom, await import(new URL(`../../../observability/rules/${code}.mjs`, import.meta.url).href));
  for (const run of ["positive", "healthy"]) {
    const handoff = `${CHAIN}/stack-rows.${run}.json`;
    const fixture = {
      description: `${code} ${run}: rows the real fault scenario's API and Postgres emitted, read back through the tenant-day live reader.`,
      asof_ms: 1_795_604_000_000,
      declaration: DAY,
      chain: [handoff],
      rows: read(handoff),
    };
    writeOrCompare(`observability/fixtures/${code}/${run}.json`, fixture);
    const judged = judgeFixture(fixture, [check], code);
    const findings = judged.verdict.findings.filter((finding) => finding.code === code);
    if (run === "positive") assert.ok(findings.length > 0, `${code} positive run gave no finding; dropped: ${JSON.stringify(judged.dropped)}`);
    else assert.equal(findings.length, 0, `${code} healthy run gave ${findings.length} finding(s)`);
    assert.deepEqual(judged.dropped, [], `${code} ${run} dropped rows`);
  }
});
