import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAP, EXEMPT_LABEL, decide, readCap } from "./ready-cap.mjs";

const pr = (number, overrides = {}) => ({ id: `id-${number}`, number, isDraft: false, labels: { nodes: [] }, mergeQueueEntry: null, ...overrides });

test("drafts are not counted and the pull request being marked ready is not counted against itself", () => {
  const self = pr(10);
  const pullRequests = [self, pr(1), pr(2, { isDraft: true }), pr(3, { isDraft: true })];
  assert.deepEqual(decide({ pullRequests, self, cap: 2 }), { others: 1, queued: 0, cap: 2, exempt: false, over: false });
});

test("marking ready is refused when the others already fill the cap", () => {
  const self = pr(10);
  const pullRequests = [self, pr(1), pr(2, { mergeQueueEntry: { id: "q" } })];
  const result = decide({ pullRequests, self, cap: 2 });
  assert.equal(result.over, true);
  assert.equal(result.queued, 1);
});

test("the exempt label lets one pull request through a full cap", () => {
  const self = pr(10, { labels: { nodes: [{ name: EXEMPT_LABEL }] } });
  const result = decide({ pullRequests: [self, pr(1), pr(2)], self, cap: 1 });
  assert.equal(result.over, false);
  assert.equal(result.exempt, true);
});

test("without a pull request number the count says whether one more would fit", () => {
  assert.equal(decide({ pullRequests: [pr(1), pr(2)], self: undefined, cap: 2 }).over, true);
  assert.equal(decide({ pullRequests: [pr(1)], self: undefined, cap: 2 }).over, false);
});

test("the cap comes from the variable, falls back to the default, and rejects nonsense", () => {
  assert.equal(readCap(undefined), DEFAULT_CAP);
  assert.equal(readCap(""), DEFAULT_CAP);
  assert.equal(readCap(" 9 "), 9);
  for (const bad of ["0", "-1", "2.5", "six"]) assert.throws(() => readCap(bad), /CHALK_READY_CAP/);
});
