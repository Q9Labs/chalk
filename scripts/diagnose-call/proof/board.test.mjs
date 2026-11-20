import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATALOGUE } from "./catalogue.mjs";
import { judgeFixture, ruleResult } from "./rows.mjs";

const boardChecks = CATALOGUE.filter(({ code }) => code.startsWith("board.") && code !== "board.view_jumped");

for (const check of boardChecks) {
  test(`${check.code} needs affirmative evidence from each required witness`, () => {
    const fixture = JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${check.code}/healthy.json`, import.meta.url)));
    for (const event of new Set(fixture.rows.map((row) => row.event))) {
      const rows = fixture.rows.filter((row) => row.event !== event);
      const { verdict } = judgeFixture({ ...fixture, rows }, boardChecks, check.code);
      assert.deepEqual(ruleResult(verdict, check.code), { checked: 0, eligible: 1, findings: 0 }, event);
      assert.notEqual(verdict.outcome, "healthy");
    }
  });
}

test("matched updates do not hide an additional Sync push without a corresponding SDK receipt", () => {
  const code = "board.out_of_sync";
  const fixture = JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${code}/healthy.json`, import.meta.url)));
  const push = fixture.rows.find((row) => row.event === "board.sync_delivery");
  fixture.rows.push({ ...push, board_revision: "3", board_correlation_id: "c6110000-0000-4000-8000-000000000000", event_id: "e6ee0000-0000-4000-8000-000000000000" });
  const { verdict } = judgeFixture(fixture, boardChecks, code);
  assert.deepEqual(ruleResult(verdict, code), { checked: 0, eligible: 1, findings: 0 });
});
