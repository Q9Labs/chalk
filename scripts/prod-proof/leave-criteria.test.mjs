import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLeaves, median } from "./leave-criteria.mjs";

const sample = (scenario, ms) => ({ scenario, ms, confirmed: true, deadlineFallback: false, rejectedWhileLeaving: scenario === "publications-403", peerClosedBeforeAck: false });
const baseline = () => Array.from({ length: 5 }, () => sample("ordinary", 200));
const candidate = (ms = 300) => ["ordinary", "publications-403"].flatMap((scenario) => Array.from({ length: 5 }, () => sample(scenario, ms)));

test("uses every candidate sample and the measured 2x baseline plus500ms limit", () => {
  const result = evaluateLeaves(baseline(), candidate(900));
  assert.equal(result.limitMs, 900);
  assert.equal(result.passed, true);
  assert.equal(evaluateLeaves(baseline(), candidate(901)).passed, false);
});

test("rejects a single sample above5seconds even when its median passes", () => {
  const rows = candidate();
  rows[0].ms = 5001;
  assert.equal(evaluateLeaves(baseline(), rows).passed, false);
});

test("production uses the captured baseline even when its local old-client reference is slower", () => {
  assert.equal(evaluateLeaves(baseline(), candidate(801), 150).passed, false);
  assert.equal(evaluateLeaves(baseline(), candidate(800), 150).passed, true);
  for (const value of [NaN, 0, -1, 5001]) assert.throws(() => evaluateLeaves(baseline(), candidate(), value));
});

test("requires every confirmed ack, no deadline fallback, and the observed403 sequence", () => {
  for (const fault of [{ confirmed: false }, { deadlineFallback: true }, { rejectedWhileLeaving: false }, { peerClosedBeforeAck: true }]) {
    const rows = candidate();
    Object.assign(rows[5], fault);
    assert.equal(evaluateLeaves(baseline(), rows).passed, false);
  }
});

test("requires five samples of each scenario and rejects invalid timing data", () => {
  assert.equal(evaluateLeaves(baseline(), candidate().slice(1)).passed, false);
  assert.throws(() => median([]));
  assert.throws(() => median([NaN]));
  assert.equal(median([3, 1, 2, 4]), 2.5);
});
