import assert from "node:assert/strict";
import test from "node:test";
import { countsAsEvidence } from "./schema.mjs";
import { percentile } from "./stats.mjs";

test("percentile is the nearest rank of unsorted values, and null without values", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => 20 - index);
  assert.equal(percentile(twenty, 0.95), 19);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.5), null);
});

test("only an uncontended, observable card counts as evidence", () => {
  assert.equal(countsAsEvidence({ contention: undefined }), true);
  assert.equal(countsAsEvidence({ contention: { contended: false } }), true);
  assert.equal(countsAsEvidence({ contention: { contended: true } }), false);
  assert.equal(countsAsEvidence({ contention: { contended: false, unobservable: true } }), false);
});
