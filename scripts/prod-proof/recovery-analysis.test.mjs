import assert from "node:assert/strict";
import test from "node:test";
import { INTERRUPTION_MS, flowGap, recoveryOf } from "./recovery-analysis.mjs";

// A call sampled every 100 ms from t=0 to t=60000. `silent` lists [from, to) ranges with no audio and `quiet` the same for video.
function call({ silent = [], quiet = [], statuses = [] } = {}) {
  const inside = (ranges, t) => ranges.some(([from, to]) => t >= from && t < to);
  const statusAt = (t) => statuses.findLast(([at]) => t >= at)?.[1] ?? "live";
  return Array.from({ length: 600 }, (_, index) => {
    const t = index * 100;
    return { t, fa: !inside(silent, t), fv: !inside(quiet, t), status: statusAt(t) };
  });
}

const window = { faultStart: 20_000, faultEnd: 25_000, watchEnd: 59_000 };

test("a call that never stopped is not interrupted", () => {
  const result = recoveryOf(call(), window);
  assert.equal(result.audio.interrupted, false);
  assert.equal(result.video.interrupted, false);
  assert.equal(result.audio.back_after_fault_end_s, null);
  assert.deepEqual(result.statuses, [{ at_s: -1, status: "live" }]);
});

test("a 5 second blackout that audio leaves 3 seconds after it ends reads as 3 s back, 8 s after the fault began", () => {
  const result = recoveryOf(
    call({
      silent: [[20_000, 28_000]],
      quiet: [[20_000, 31_000]],
      statuses: [
        [21_000, "reconnecting"],
        [29_000, "live"],
      ],
    }),
    window,
  );
  assert.equal(result.audio.interrupted, true);
  assert.equal(result.audio.back_after_fault_end_s, 3);
  assert.equal(result.audio.back_after_fault_start_s, 8);
  assert.equal(result.audio.longest_gap_s, 8.1);
  assert.equal(result.video.back_after_fault_end_s, 6);
  assert.deepEqual(result.statuses, [
    { at_s: -1, status: "live" },
    { at_s: 1, status: "reconnecting" },
    { at_s: 9, status: "live" },
  ]);
});

test("media that resumes while the fault still holds is back at 0 seconds after the fault ends", () => {
  const result = recoveryOf(call({ silent: [[20_000, 23_000]] }), window);
  assert.equal(result.audio.interrupted, true);
  assert.equal(result.audio.back_after_fault_end_s, 0);
  assert.equal(result.audio.back_after_fault_start_s, 3);
});

test("media that never comes back says so instead of inventing a time", () => {
  const result = recoveryOf(call({ silent: [[21_000, 60_000]] }), window);
  assert.equal(result.audio.interrupted, true);
  assert.equal(result.audio.never_back, true);
  assert.equal(result.audio.back_after_fault_end_s, null);
  assert.equal(result.video.interrupted, false);
});

test("a gap at or under the interruption limit is jitter", () => {
  const gap = flowGap(call({ silent: [[20_000, 20_000 + INTERRUPTION_MS - 200]] }), "fa", 19_000, 59_000);
  assert.ok(gap.gap_ms <= INTERRUPTION_MS);
  assert.equal(recoveryOf(call({ silent: [[20_000, 20_000 + INTERRUPTION_MS - 200]] }), window).audio.interrupted, false);
});
