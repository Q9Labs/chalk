// @ts-check
// end.time_limit fires on the declaration's time limit, so a witnessed end that names another reason contradicts the declaration.
// That contradiction must never read as a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CATALOGUE } from "./catalogue.mjs";
import { ITEM } from "./profile.mjs";
import { completeWatermarks, judgeFixture, ruleResult } from "./rows.mjs";

const CODE = "end.time_limit";
const ONLY = CATALOGUE.filter((def) => def.code === CODE);
/** @type {import("./rows.mjs").Fixture} */
const contradicted = JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${CODE}/contradicted.json`, import.meta.url), "utf8"));
// The problem-report stream is read too, so nothing but the rule keeps the item from reading healthy.
const watermarks = [...completeWatermarks(contradicted.declaration, ONLY, contradicted.asof_ms), { source: "report", subject: ITEM, complete_to_ms: contradicted.asof_ms, evidence_gaps: [], emits: ["report.problem"], build: "report fixture" }];

/** @param {string} reason */
function judgedWithEnd(reason) {
  const rows = contradicted.rows.map((row) => ({ ...row, end_reason: reason }));
  return judgeFixture({ ...contradicted, rows, watermarks }, CATALOGUE, CODE).verdict;
}

describe("end.time_limit against the witnessed end", () => {
  it("is not healthy when the declaration says time limit and Sync's end names another reason", () => {
    for (const reason of ["ended_by_participant", "linger_expired"]) {
      const verdict = judgedWithEnd(reason);
      assert.notEqual(verdict.outcome, "healthy", `Sync end=${reason}`);
      assert.equal(ruleResult(verdict, CODE).checked, 0, `Sync end=${reason}: the check is not counted as passed`);
    }
  });

  it("gives the expected finding when Sync's end agrees with the declaration", () => {
    assert.equal(ruleResult(judgedWithEnd("maximum_duration"), CODE).findings, 1);
  });
});
