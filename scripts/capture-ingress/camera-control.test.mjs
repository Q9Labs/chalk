import assert from "node:assert/strict";
import { test } from "node:test";
import { controlCamera } from "./camera-control.mjs";

test("forced low layer survives SDK uplink adaptation and releases afterwards", async () => {
  let parameters = {
    encodings: [
      { rid: "h", active: true },
      { rid: "l", active: true },
    ],
  };
  const sender = {
    getParameters: () => structuredClone(parameters),
    setParameters: async (next) => {
      parameters = structuredClone(next);
    },
  };
  const limit = controlCamera(sender);
  await limit(true);
  // The real SDK's sub-1.5-Mb/s policy disables l; retain the experiment's l.
  const adapted = sender.getParameters();
  adapted.encodings[1].active = false;
  await sender.setParameters(adapted);
  assert.deepEqual(parameters.encodings, [
    { rid: "h", active: false, maxBitrate: 80000 },
    { rid: "l", active: true, maxBitrate: 80000 },
  ]);
  await limit(false);
  const restored = sender.getParameters();
  assert.deepEqual(restored.encodings, [
    { rid: "h", active: true, maxBitrate: 2500000 },
    { rid: "l", active: true, maxBitrate: 650000 },
  ]);
  restored.encodings[1].active = false;
  await sender.setParameters(restored);
  assert.equal(parameters.encodings[1].active, false);
});
