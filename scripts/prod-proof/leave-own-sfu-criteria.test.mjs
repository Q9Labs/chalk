import assert from "node:assert/strict";
import test from "node:test";
import { awaitRelease, evaluateOwnSfuLeave, scorecardShape } from "./leave-own-sfu-criteria.mjs";

const good = () => ({
  leave: { confirmed: true, deadlineFallback: false, ms: 240, peerClosedBeforeAck: false },
  capture: { live: 2, audio: 1, video: 1 },
  release: { live: 0, audio: 0, video: 0, ms: 300 },
  survivor: { rosterWithoutLeaver: true, remoteWithoutLeaver: true, ownTracksLive: true },
  episodeStatus: "active",
});

test("a clean Leave passes and feeds the scorecard one sample", () => {
  const sample = good();
  const result = evaluateOwnSfuLeave(sample);
  assert.deepEqual(result, { passed: true, failures: [] });
  assert.deepEqual(scorecardShape(sample, result), { passed: true, candidateSamples: 1, candidateMedianMs: 240, candidateMaxMs: 240, plane: "chalk_sfu" });
});

for (const [name, change, message] of [
  ["a deadline fallback", (s) => (s.leave.deadlineFallback = true), /acknowledgement/],
  ["a slow acknowledgement", (s) => (s.leave.ms = 5001), /over 5000 ms/],
  ["a media close before the acknowledgement", (s) => (s.leave.peerClosedBeforeAck = true), /closed before/],
  ["no capture to release", (s) => (s.capture = { live: 0, audio: 0, video: 0 }), /proves nothing/],
  ["a live camera after Leave", (s) => (s.release.live = 1), /still live/],
  ["a release that finished after the deadline counted from the start of the Leave", (s) => (s.release.ms = 10_001), /released 10001 ms after the Leave began/],
  ["the leaver in the roster", (s) => (s.survivor.rosterWithoutLeaver = false), /lists the leaver/],
  ["media still arriving from the leaver", (s) => (s.survivor.remoteWithoutLeaver = false), /still receives media/],
  ["the survivor losing its capture", (s) => (s.survivor.ownTracksLive = false), /stopped its own capture/],
  ["an ended Episode", (s) => (s.episodeStatus = "ended"), /Episode is ended/],
  ["an Episode already ending", (s) => (s.episodeStatus = "ending"), /Episode is ending, not active/],
]) {
  test(`fails on ${name}`, () => {
    const sample = good();
    change(sample);
    const result = evaluateOwnSfuLeave(sample);
    assert.equal(result.passed, false);
    assert.match(result.failures.join("\n"), message);
  });
}

// A fake clock: sleeping moves time, and the capture ends at `endsAt` ms after the Leave began.
function fakeCapture(endsAt) {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => void (time += ms),
    sample: async () => (time >= endsAt ? { live: 0 } : { live: 2 }),
  };
}

test("tracks that end right at the deadline are seen as ended and pass", async () => {
  const capture = fakeCapture(9900);
  const { after, ms } = await awaitRelease(capture.sample, 0, capture);
  assert.equal(after.live, 0);
  assert.ok(ms <= 10_000);
  assert.equal(evaluateOwnSfuLeave({ ...good(), release: { ...after, ms } }).passed, true);
});

test("tracks that end after the deadline still fail", async () => {
  const capture = fakeCapture(10_100);
  const { after, ms } = await awaitRelease(capture.sample, 0, capture);
  assert.equal(after.live, 2);
  assert.equal(evaluateOwnSfuLeave({ ...good(), release: { ...after, ms } }).passed, false);
});

test("a slow acknowledgement leaves less time to release", async () => {
  const capture = fakeCapture(7000);
  const { after } = await awaitRelease(capture.sample, -4000, capture);
  assert.equal(after.live, 2);
});
