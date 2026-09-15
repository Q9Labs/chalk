import assert from "node:assert/strict";
import test from "node:test";
import { desiredCaptureNodes, minimumRenderNodes, assertReplacementWithinCap } from "./validate-config.mjs";

test("cost-first capture demand has no spare or multi-recording packing", () => {
  assert.equal(desiredCaptureNodes({ episodes: 0, participants: 0, inputMbps: 0 }), 0);
  assert.equal(desiredCaptureNodes({ episodes: 10, participants: 30, inputMbps: 40 }), 10);
  assert.throws(() => desiredCaptureNodes({ episodes: 10, participants: 30, inputMbps: 40, readySpare: 1 }));
  assert.throws(() => desiredCaptureNodes({ episodes: 1, participants: 3, inputMbps: 4, episodesPerNode: 4 }));
  assert.throws(() => desiredCaptureNodes({ episodes: 1, participants: 3, inputMbps: 41 }));
});

test("ten render jobs fit the separate one-hour workload budget", () => {
  assert.equal(minimumRenderNodes(Array.from({ length: 10 }, () => ({ serviceMinutes: 35, deadlineMinutes: 60 }))), 10);
  assert.throws(() => assertReplacementWithinCap({ activeNodes: 10, replacementNodes: 1, maxNodes: 10 }));
});
