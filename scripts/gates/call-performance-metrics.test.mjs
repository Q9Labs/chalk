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

test("leak budgets reject steady growth and a fixed retained allocation independently", async () => {
  const { growth, leakFailures } = await import("../../apps/web/scripts/call-leak-check.mjs");
  const budgets = { metrics: { listeners: { perCycle: 0.1, allowance: 4 } } };
  assert.equal(growth(Array.from({ length: 21 }, (_, index) => index * 2)), 2);
  assert.deepEqual(
    leakFailures(
      Array.from({ length: 21 }, () => ({ listeners: 10 })),
      budgets,
    ),
    [],
  );
  assert.ok(
    leakFailures(
      Array.from({ length: 21 }, (_, index) => ({ listeners: 10 + index })),
      budgets,
    ).some((failure) => failure.includes("slope")),
  );
  assert.ok(
    leakFailures(
      Array.from({ length: 21 }, (_, index) => ({ listeners: index === 0 ? 10 : 20 })),
      budgets,
    ).some((failure) => failure.includes("baseline excess")),
  );
  assert.throws(() => leakFailures([{ listeners: 0 }, { listeners: NaN }], budgets), /Missing/);
  assert.ok(leakFailures([{ liveTracks: 1 }, { liveTracks: 1 }], { metrics: { liveTracks: { perCycle: 0, allowance: 0 } } }, { left: true }).some((failure) => failure.includes("must be zero")));
});

test("heap diagnostics compute dominator retained sizes without double-counting shared children", async () => {
  const { summarizeHeap } = await import("../../apps/web/scripts/call-heap-summary.mjs");
  const heap = {
    snapshot: { meta: { node_fields: ["type", "name", "self_size", "edge_count", "detachedness"], node_types: [["synthetic", "object", "native"]], edge_fields: ["type", "to_node"], edge_types: [["property", "weak"]] } },
    strings: ["root", "owner", "shared", "detached"],
    nodes: [0, 0, 0, 2, 0, 1, 1, 10, 2, 0, 1, 2, 30, 0, 0, 2, 3, 20, 0, 2],
    edges: [0, 5, 0, 10, 0, 10, 0, 15],
  };
  const summary = summarizeHeap(heap);
  assert.equal(summary.detachedNodes, 1);
  assert.equal(summary.largestRetainedTypes.find((entry) => entry.type === "object: owner").largestRetainedBytes, 30);
  assert.equal(summary.largestRetainedTypes.find((entry) => entry.type === "object: shared").largestRetainedBytes, 30);
});
