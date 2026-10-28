import assert from "node:assert/strict";
import test from "node:test";
import { agreementIssues, truthIssues } from "./agreement.mjs";

function pair({ silent = false, stale = false, badge = true } = {}) {
  return ["a", "b"].map((self) => ({ self, local: { microphone: "enabled", camera: "enabled" }, participants: [{ id: self === "a" ? "b" : "a", microphone: badge, camera: true }], received: [{ id: self === "a" ? "b" : "a", energy: silent && self === "b" ? 0 : 0.01, frames: stale ? 10 : 20 }] }));
}

test("a healthy peer does not mask another sender's missing audio", () => {
  const issues = agreementIssues(pair({ stale: true }), pair({ silent: true }));
  assert.deepEqual(issues, ["a microphone: b playback energy 0"]);
});

test("a ready but frozen camera is not received video proof", () => {
  assert.equal(agreementIssues(pair({ stale: true }), pair({ stale: true })).filter((issue) => issue.includes("frames")).length, 2);
});

test("SFU On and muted Sync badges reproduce the split authority failure", () => {
  const split = pair({ badge: false });
  assert.equal(truthIssues(split).length, 2);
  assert.equal(agreementIssues(pair({ stale: true }), split).filter((issue) => issue.includes("projection")).length, 2);
});

test("both directions need audible capture and advancing frames", () => {
  assert.deepEqual(agreementIssues(pair({ stale: true }), pair()), []);
});
