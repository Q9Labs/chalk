import assert from "node:assert/strict";
import test from "node:test";
import { countsAsEvidence } from "./schema.mjs";
import { formatNumber, limitText, percentile } from "./stats.mjs";

test("percentile is the nearest rank of unsorted values, and null without values", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => 20 - index);
  assert.equal(percentile(twenty, 0.95), 19);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.5), null);
});

test("limitText lists the limits a budget sets, and formatNumber rounds the way the tables show them", () => {
  assert.equal(limitText(undefined), "none");
  assert.equal(limitText({ max_p50: 12.3456, max_p95: 250.4 }), "p50 ≤ 12.3, p95 ≤ 250");
  assert.equal(limitText({ min_p50: 1 }), "p50 ≥ 1");
  assert.equal(formatNumber(null), "–");
  assert.equal(formatNumber(0.123456), "0.123");
});

test("only an uncontended, observable card counts as evidence", () => {
  assert.equal(countsAsEvidence({ contention: undefined }), true);
  assert.equal(countsAsEvidence({ contention: { contended: false } }), true);
  assert.equal(countsAsEvidence({ contention: { contended: true } }), false);
  assert.equal(countsAsEvidence({ contention: { contended: false, unobservable: true } }), false);
});
