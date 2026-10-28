import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { budgetFailures, summarize, trustedInteractionMs, validateScenarioBudgets } from "../../apps/web/scripts/call-performance-metrics.mjs";
import { scenarios } from "../../apps/web/scripts/call-performance-scenarios.mjs";

test("every budgeted scenario runs on each device, and every runner has a budget", () => {
  const budgets = JSON.parse(readFileSync(new URL("../../apps/web/perf-budgets.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateScenarioBudgets(budgets, scenarios));
  assert.throws(
    () =>
      validateScenarioBudgets(
        budgets,
        scenarios.filter(({ id }) => id !== "board"),
      ),
    /Scenario budget has no runner: laptop\/board/,
  );
  const missing = structuredClone(budgets);
  delete missing.scenarios.phone.board;
  assert.throws(() => validateScenarioBudgets(missing, scenarios), /Missing explicit scenario budget: phone\/board/);
});

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

test("a generous startup heap allowance does not disable the late-cycle guard", async () => {
  const { leakFailures } = await import("../../apps/web/scripts/call-leak-check.mjs");
  const samples = Array.from({ length: 21 }, (_, index) => ({ heapMiB: index < 11 ? 0 : (index - 10) * 0.06 }));
  assert.deepEqual(leakFailures(samples, { metrics: { heapMiB: { perCycle: 0.1, allowance: 3, tailPerCycle: 0.05 } } }), ["heapMiB: late slope 0.0600 > 0.05/cycle"]);
});

test("decoder restarts contribute a new generation instead of negative playback deltas", async () => {
  const { videoCounterDelta } = await import("../../apps/web/scripts/call-video-quality.mjs");
  const previous = { totalVideoFrames: 100, droppedVideoFrames: 3 };
  assert.deepEqual(videoCounterDelta(previous, { totalVideoFrames: 110, droppedVideoFrames: 4 }), { frames: 10, dropped: 1, resets: 0 });
  assert.deepEqual(videoCounterDelta(previous, { totalVideoFrames: 5, droppedVideoFrames: 1 }), { frames: 5, dropped: 1, resets: 1 });
});
