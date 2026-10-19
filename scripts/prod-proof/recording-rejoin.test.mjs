import assert from "node:assert/strict";
import test from "node:test";
import { cameraEvidence, toneEvidence } from "./recording-rejoin.mjs";

function camera(color, marker) {
  const frame = Buffer.alloc(320 * 180 * 3).fill(Buffer.from(color));
  for (let y = 40; y < 100; y++) frame.fill(230, (y * 320 + marker) * 3, (y * 320 + marker + 30) * 3);
  return frame;
}

test("exported camera must show the right guest and phase and must advance", () => {
  const frames = [30, 90, 150].map((marker) => camera([27, 54, 93], marker));
  assert.equal(cameraEvidence(frames, "before", 0).moving, true);
  assert.equal(cameraEvidence(frames, "before", 1).visible, false);
  assert.equal(cameraEvidence(frames, "after", 0).visible, false);
  assert.equal(cameraEvidence([frames[0], frames[0], frames[0]], "before", 0).moving, false);
});

test("mixed audio must contain each guest's tone, not merely energy", () => {
  const pcm = Buffer.alloc(48_000 * 3 * 4);
  for (let index = 0; index < pcm.length / 4; index++) pcm.writeFloatLE(0.1 * Math.sin((2 * Math.PI * 440 * index) / 48_000), index * 4);
  assert.equal(toneEvidence(pcm, 440).present, true);
  assert.equal(toneEvidence(pcm, 880).present, false);
  assert.equal(toneEvidence(Buffer.alloc(pcm.length), 440).present, false);
});
