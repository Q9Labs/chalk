import assert from "node:assert/strict";
import test from "node:test";
import { stallEvidence, stalled } from "./sfu-canary-criteria.mjs";

const camera = (connection, bytesReceived, framesDecoded) => ({ type: "inbound-rtp", kind: "video", source: "camera", id: "v1", connection, bytesReceived, framesDecoded });
const peer = (connection, connectionState, iceConnectionState) => ({ type: "peer-state", connection, connectionState, iceConnectionState });

test("a camera that moved on the same stream is not a stall, and the evidence says by how much", () => {
  const before = [[camera(0, 100, 10)], [camera(0, 100, 10)]];
  const after = [[peer(0, "connected", "connected"), camera(0, 900, 40)], [camera(0, 100, 10)]];
  assert.equal(stalled(after, before), false);
  assert.deepEqual(stallEvidence(after, before)[0], { connections: ["0:connected/connected"], camera: [{ connection: 0, id: "v1", bytes: 800, frames: 30 }] });
});

test("a camera on a connection that was not measured before is reported as new", () => {
  const before = [[camera(0, 100, 10)], [camera(0, 100, 10)]];
  const after = [[camera(1, 50, 5)], [camera(0, 100, 10)]];
  assert.equal(stalled(after, before), false);
  assert.deepEqual(stallEvidence(after, before)[0].camera, [{ connection: 1, id: "v1", bytes: "new", frames: "new" }]);
});
