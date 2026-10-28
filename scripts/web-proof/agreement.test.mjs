import assert from "node:assert/strict";
import test from "node:test";
import { agreementIssues, truthIssues } from "./agreement.mjs";

function pair({ silent = false, stale = false, badge = true } = {}) {
  const otherId = (self) => (self === "a" ? "b" : "a");
  const energy = (self) => (silent && self === "b" ? 0 : 0.01);
  return ["a", "b"].map((self) => ({ self, local: { microphone: "enabled", camera: "enabled" }, participants: [{ id: otherId(self), microphone: badge, camera: true }], received: [{ id: otherId(self), energy: energy(self), frames: stale ? 10 : 20 }] }));
}

test("a healthy peer does not mask another sender's missing audio", () => {
  const issues = agreementIssues(pair({ stale: true }), pair({ silent: true }));
  assert.deepEqual(issues, ["a microphone: b playback energy 0"]);
});

test("a ready but frozen camera is not received video proof", () => {
  assert.equal(agreementIssues(pair({ stale: true }), pair({ stale: true })).filter((issue) => issue.includes("frames")).length, 2);
});

test("the Linux WebKit frame exception preserves microphone, camera projection, badge and control checks", () => {
  const before = pair({ stale: true });
  const after = pair({ stale: true, silent: true });
  after[0].controls = { microphone: false, camera: true };
  after[1].participants[0].camera = false;
  after[1].participants[0].badgeCamera = false;
  assert.deepEqual(agreementIssues(before, after, { checkCameraFrames: false }), ["a microphone: own button disagrees with SDK state", "a microphone: b playback energy 0", "a camera: local enabled, b projection false", "a camera: b badge disagrees"]);
  assert.equal(agreementIssues(before, pair({ stale: true })).filter((issue) => issue.includes("frames")).length, 2, "Frame checks remain the default for macOS WebKit and Chromium");
});

test("SFU On and muted Sync badges reproduce the split authority failure", () => {
  const split = pair({ badge: false });
  assert.equal(truthIssues(split).length, 2);
  assert.equal(agreementIssues(pair({ stale: true }), split).filter((issue) => issue.includes("projection")).length, 2);
});

test("both directions need audible capture and advancing frames", () => {
  assert.deepEqual(agreementIssues(pair({ stale: true }), pair()), []);
});

test("a pending SDK state cannot hide a normal On button during a held fault", () => {
  const samples = pair();
  samples[0].local.microphone = "enabling";
  samples[0].controls = { microphone: true, camera: true };
  assert.deepEqual(truthIssues(samples), ["a microphone: normal On button without confirmed local state"]);
});
