import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOwnLeaves } from "./leave-criteria.mjs";

const sample = (scenario, overrides = {}) => ({ scenario, confirmed: true, deadlineFallback: false, ms: 300, rejectedWhileLeaving: scenario === "publications-403", peerClosedBeforeAck: false, ...overrides });
const five = (scenario, overrides) => Array.from({ length: 5 }, () => sample(scenario, overrides));

test("five ordinary and five rejected Leaves acknowledged within 5 s pass", () => {
  const result = evaluateOwnLeaves([...five("ordinary"), ...five("publications-403")]);
  assert.equal(result.passed, true);
  assert.equal(result.maxMs, 300);
});

test("an unacknowledged Leave, a slow Leave, an unobserved rejection or a premature peer close each fail", () => {
  const ok = five("ordinary");
  const rejected = five("publications-403");
  assert.equal(evaluateOwnLeaves([...ok, ...rejected.slice(1), sample("publications-403", { confirmed: false })]).passed, false);
  assert.equal(evaluateOwnLeaves([...five("ordinary", { ms: 5001 }), ...rejected]).passed, false);
  assert.equal(evaluateOwnLeaves([...ok, ...five("publications-403", { rejectedWhileLeaving: false })]).passed, false);
  assert.equal(evaluateOwnLeaves([...ok, ...five("publications-403", { peerClosedBeforeAck: true })]).passed, false);
});

test("fewer than five samples of a scenario do not pass", () => {
  assert.equal(evaluateOwnLeaves([...five("ordinary"), ...five("publications-403").slice(1)]).passed, false);
});
