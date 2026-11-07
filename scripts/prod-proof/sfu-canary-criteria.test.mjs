import assert from "node:assert/strict";
import test from "node:test";
import { percentile, rendering, stalled, summarize } from "./sfu-canary-criteria.mjs";

const row = (kind, source, bytes, frames = 0, id = kind) => ({ type: "inbound-rtp", kind, source, id, connection: 0, bytesReceived: bytes, framesDecoded: frames });
const guest = (bytes, frames) => [row("video", "camera", bytes, frames), row("audio", "microphone", bytes)];

test("percentiles use the nearest rank", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
});

test("a join counts when both clients decode video and receive audio", () => {
  assert.equal(rendering([guest(200, 20), guest(200, 20)], [guest(100, 10), guest(100, 10)]), true);
});

test("a stalled direction, frozen video or missing client is not rendering", () => {
  assert.equal(rendering([guest(200, 20), guest(100, 10)], [guest(100, 10), guest(100, 10)]), false);
  assert.equal(rendering([guest(200, 10), guest(200, 20)], [guest(100, 10), guest(100, 10)]), false);
  assert.equal(rendering([guest(200, 20)], [guest(100, 10)]), false);
});

test("a stream on a new connection restarts from zero and is not counted until it grows", () => {
  const after = [[{ ...row("video", "camera", 50, 5), connection: 1 }, ...guest(200, 20).slice(1)], guest(200, 20)];
  assert.equal(rendering(after, [guest(100, 10), guest(100, 10)]), false);
});

test("a summary counts the trials inside the limit and the failures", () => {
  const summary = summarize([{ ms: 3000 }, { ms: 9000 }, { ms: 12000 }, { error: "x" }], 10_000);
  assert.deepEqual(summary, { trials: 4, withinLimit: 2, failed: 1, p50Ms: 9000, p95Ms: 12000, maxMs: 12000 });
});

test("a fault is proven only when no camera video moved", () => {
  assert.equal(stalled([guest(100, 10), guest(100, 10)], [guest(100, 10), guest(100, 10)]), true);
  assert.equal(stalled([guest(200, 20), guest(100, 10)], [guest(100, 10), guest(100, 10)]), false);
});

test("a replaced stream cannot prove that the fault stopped media", () => {
  const replaced = { ...row("video", "camera", 500, 50, "new-stream") };
  assert.equal(stalled([[replaced], guest(100, 10)], [guest(100, 10), guest(100, 10)]), false);
  assert.equal(stalled([[], guest(100, 10)], [guest(100, 10), guest(100, 10)]), false);
});
