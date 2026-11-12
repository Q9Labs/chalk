import assert from "node:assert/strict";
import test from "node:test";
import { judgeCall, longestGaps } from "./deploy-hold-criteria.mjs";

const sample = (status, mics) => ({ reachable: true, status, errorCode: null, remotes: mics.map(([participantId, bytes]) => ({ participantId, source: "microphone", bytes })) });
const tick = (t, ...guests) => ({ t, guests });
const steady = (t, bytes) => tick(t, sample("live", [["b", bytes], ["c", bytes]]), sample("live", [["a", bytes], ["c", bytes]]), sample("live", [["a", bytes], ["b", bytes]]));

test("the longest gap is the longest time a remote microphone's bytes did not grow", () => {
  const ticks = [steady(0, 100), steady(500, 200), steady(1000, 200), steady(1500, 200), steady(2000, 300), steady(2500, 400)];
  assert.equal(longestGaps(ticks, 0).ms, 1500);
});

test("a track that never resumes counts to the last sample", () => {
  const ticks = [steady(0, 100), steady(500, 200), steady(1000, 200), steady(1500, 200)];
  assert.equal(longestGaps(ticks, 1).ms, 1000);
});

test("a call survives when every guest stays live and hears the others to the end", () => {
  const ticks = Array.from({ length: 20 }, (_, i) => steady(i * 500, 100 * (i + 1)));
  assert.deepEqual(judgeCall(ticks, 3), []);
});

test("a guest that leaves the live status, or stops hearing a guest, fails the call", () => {
  const ticks = Array.from({ length: 20 }, (_, i) => steady(i * 500, 100 * (i + 1)));
  ticks.at(-1).guests[1] = sample("reconnecting", [["a", 2000], ["c", 2000]]);
  assert.match(judgeCall(ticks, 3).join(";"), /guest 2 ended in status reconnecting/);
  const frozen = Array.from({ length: 20 }, (_, i) => tick(i * 500, sample("live", [["b", i < 5 ? i * 100 : 400], ["c", i * 100]]), sample("live", [["a", i * 100], ["c", i * 100]]), sample("live", [["a", i * 100], ["b", i * 100]])));
  assert.match(judgeCall(frozen, 3).join(";"), /guest 1 receives no audio from b/);
});
