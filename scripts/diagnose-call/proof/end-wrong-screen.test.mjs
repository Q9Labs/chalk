// @ts-check
// The window end.wrong_screen promises: a failure screen counts from 10 s before the witnessed end to 120 s after it, and not outside.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CATALOGUE } from "./catalogue.mjs";
import { eventOf, judgeFixture, ruleResult } from "./rows.mjs";

const CODE = "end.wrong_screen";
/** @type {import("./rows.mjs").Fixture} */
const positive = JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${CODE}/positive.json`, import.meta.url), "utf8"));
const end = /** @type {Record<string, any>} */ (positive.rows.find((row) => eventOf(row) === "sync.episode.ended"));
const screen = /** @type {Record<string, any>} */ (positive.rows.find((row) => eventOf(row) === "client.call_ended" && row.end_reason === "connection_lost"));

/**
 * The positive fixture with Sync's end row moved by `endShift` and the failure screen placed `offset` ms from that end.
 * @param {number} offset
 * @param {number} [endShift]
 */
function findingsAt(offset, endShift = 0) {
  const at = end.est_server_ms + endShift;
  const rows = positive.rows.map((row) => (row === end ? { ...row, est_server_ms: at } : row === screen ? { ...row, est_server_ms: at + offset } : row));
  return ruleResult(judgeFixture({ ...positive, rows }, CATALOGUE, CODE).verdict, CODE).findings;
}

describe("end.wrong_screen's window around the end", () => {
  it("counts a failure screen up to 10 s before the end, and not one 12 s before it", () => {
    assert.equal(findingsAt(-9_000), 1);
    assert.equal(findingsAt(-12_000), 0);
  });

  it("counts a failure screen up to 120 s after the witnessed end, and not one 125 s after it", () => {
    // Sync's row sits 60 s before the declared end, so both screens fall inside the window the check reads and only the rule's bound decides.
    assert.equal(findingsAt(115_000, -60_000), 1);
    assert.equal(findingsAt(125_000, -60_000), 0);
  });
});

describe("end.wrong_screen's pass", () => {
  /** @type {import("./rows.mjs").Fixture} */
  const healthy = JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${CODE}/healthy.json`, import.meta.url), "utf8"));
  /** @param {string} reason */
  const withScreen = (reason) => {
    const rows = healthy.rows.map((row) => (eventOf(row) === "client.call_ended" ? { ...row, end_reason: reason } : row));
    return ruleResult(judgeFixture({ ...healthy, rows }, CATALOGUE, CODE).verdict, CODE);
  };

  it("needs the Episode-ended screen: a leave, a removal or a closed page leaves the seat unchecked", () => {
    for (const reason of ["episode_ended", "time_limit"]) assert.deepEqual(withScreen(reason), { findings: 0, checked: 1, eligible: 1 }, reason);
    for (const reason of ["left", "removed", "page_closed"]) assert.deepEqual(withScreen(reason), { findings: 0, checked: 0, eligible: 1 }, reason);
  });
});
