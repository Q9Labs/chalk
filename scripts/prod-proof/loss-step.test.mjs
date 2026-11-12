import assert from "node:assert/strict";
import test from "node:test";
import { lossStepOf } from "./loss-step.mjs";

/** Builds a 100 ms sample list: each segment gives its length in seconds, kbit/s, frames/s, frame width and whether audio flows. */
function viewer(segments) {
  const samples = [];
  let t = 0;
  let vb = 0;
  let vf = 0;
  for (const { s, kbps, fps, width, audio = true } of segments) {
    for (let i = 0; i < s * 10; i++) {
      t += 100;
      vb += (kbps * 1000) / 8 / 10;
      vf += fps / 10;
      samples.push({ t, fa: audio, fv: fps > 0, vb, vf, vw: width });
    }
  }
  return samples;
}

// Loss from 20 s to 45 s on a call watched until 125 s.
const window = { faultStart: 20_000, faultEnd: 45_000, watchEnd: 125_000 };

test("video that falls to the low layer and then stops for the rest of the loss is reported with its stop and its way back", () => {
  const samples = viewer([
    { s: 20, kbps: 1500, fps: 30, width: 640 },
    { s: 5, kbps: 240, fps: 15, width: 320 },
    { s: 13, kbps: 0, fps: 0, width: 320 },
    { s: 7, kbps: 0, fps: 0, width: 320 },
    { s: 17, kbps: 240, fps: 15, width: 320 },
    { s: 63, kbps: 1500, fps: 30, width: 640 },
  ]);
  const step = lossStepOf(samples, window);
  assert.equal(step.before_kbps, 1500);
  assert.equal(step.lowest_kbps, 0);
  assert.equal(step.longest_zero_fps_s, 20);
  assert.equal(step.zero_fps_s, 20);
  assert.equal(step.back_to_high_s, 17);
  assert.equal(step.audio_longest_gap_ms, 100);
});

test("a viewer that never leaves the high layer returns at once, and a viewer that never returns says so", () => {
  const steady = viewer([{ s: 125, kbps: 1500, fps: 30, width: 640 }]);
  const held = lossStepOf(steady, window);
  assert.equal(held.back_to_high_s, 0);
  assert.equal(held.zero_fps_s, 0);
  assert.equal(held.lowest_kbps, 1500);

  const stuck = viewer([
    { s: 20, kbps: 1500, fps: 30, width: 640 },
    { s: 105, kbps: 240, fps: 15, width: 320 },
  ]);
  assert.equal(lossStepOf(stuck, window).back_to_high_s, null);
});

test("audio that stops during the loss shows its gap", () => {
  const samples = viewer([
    { s: 30, kbps: 1500, fps: 30, width: 640 },
    { s: 2, kbps: 1500, fps: 30, width: 640, audio: false },
    { s: 93, kbps: 1500, fps: 30, width: 640 },
  ]);
  assert.equal(lossStepOf(samples, window).audio_longest_gap_ms, 2100);
});
