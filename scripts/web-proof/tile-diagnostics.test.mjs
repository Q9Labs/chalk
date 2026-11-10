import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { measureAdvance, videoNotAdvancing } from "./tile-diagnostics.mjs";

function stageTile(video) {
  const tile = { querySelector: () => video };
  return { querySelector: () => ({ closest: () => tile }) };
}

// A page that runs the same serialized functions Playwright would send to the browser, and returns plain JSON as it does.
function fakePage(globals) {
  return { evaluate: async (fn, arg) => JSON.parse(JSON.stringify(await runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`, globals))) };
}

const emptyVideo = { readyState: 0, videoWidth: 0, srcObject: null, getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) };

// A clock that only moves when the code sleeps, so a measurement never depends on how fast the runner is.
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

// A tile whose decoded-frame counter is frames(ms), where ms is the fake clock's time at the page read.
function decodingPage(clock, frames) {
  const video = { ...emptyVideo, readyState: 4, videoWidth: 640, getVideoPlaybackQuality: () => ({ totalVideoFrames: frames(clock.now()) }) };
  return fakePage({ document: stageTile(video) });
}

function measure(frames, options) {
  const clock = fakeClock();
  return measureAdvance(decodingPage(clock, frames), "Verify B", { clock, windowMs: 3000, pollMs: 500, ...options });
}

test("a stream that starts slowly and then speeds up counts as advancing once a window gains enough", async () => {
  // 1 frame per 2 s for 6 s, then 10 frames per second.
  const measured = await measure((ms) => (ms < 6000 ? 1 + Math.floor(ms / 2000) : 4 + Math.floor((ms - 6000) / 100)), { timeoutMs: 60_000 });
  assert.equal(measured.advancedAfterMs, 6500);
});

test("a stream that decodes at a healthy rate from the first frame counts as advancing after one window", async () => {
  const measured = await measure((ms) => ms / 50, { timeoutMs: 60_000 });
  assert.equal(measured.advancedAfterMs, 3000);
});

test("a stream that never gains enough frames in a window times out and the message shows how far it got", async () => {
  const measured = await measure((ms) => 1 + Math.floor(ms / 1000), { timeoutMs: 10_000 });
  assert.equal(measured.advancedAfterMs, null);
  assert.equal(measured.samples.length, 21);
  assert.deepEqual([measured.samples[0].frames, measured.samples.at(-1).frames], [1, 11]);
  const message = videoNotAdvancing("Verify A", "Verify B", measured, 10_000);
  assert.match(message, /Verify B/);
  assert.match(message, /Verify A/);
  assert.match(message, /10 s/);
  assert.match(message, /\b1 frames\b.*\b11\b/);
});
