import assert from "node:assert/strict";
import test from "node:test";
import { budgetFailures, summarize, trustedInteractionMs } from "../../apps/web/scripts/call-performance-metrics.mjs";

test("a sustained click regression fails the same median budget used by the gate", () => {
  const limits = { interactionMs: 120 };
  const before = summarize([40, 32, 48, 40, 56].map((interactionMs) => ({ interactionMs })));
  const after = summarize([280, 288, 272, 296, 280].map((interactionMs) => ({ interactionMs })));
  assert.deepEqual(budgetFailures(before, limits, ["interactionMs"]), []);
  assert.equal(budgetFailures(after, limits, ["interactionMs"]).length, 1);
});

test("missing and non-finite measurements cannot become a passing zero", () => {
  assert.throws(() => budgetFailures({}, { heapMiB: 25 }, ["heapMiB"]), /Missing/);
  assert.throws(() => summarize([{ heapMiB: NaN }]), /invalid/);
});

test("trusted input latency retains Event Timing timestamps instead of silently reporting zero", () => {
  const inputs = [{ name: "click", at: 100 }];
  assert.equal(trustedInteractionMs([{ name: "click", startTime: 100, duration: 256 }], inputs), 256);
  assert.equal(trustedInteractionMs([{ name: "click", startTime: 200, duration: 512 }], inputs), 0);
  assert.throws(() => trustedInteractionMs([{ name: "click", duration: 256 }], inputs), /retain startTime/);
});
