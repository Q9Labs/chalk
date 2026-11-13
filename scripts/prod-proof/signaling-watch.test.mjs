import assert from "node:assert/strict";
import test from "node:test";
import { signalingBody, signalingOperation } from "./signaling-watch.mjs";

test("the unified signal route is a signaling operation and its body names the op and its size", () => {
  assert.equal(signalingOperation("https://api.example.test/v1/spaces/s/episodes/e/media/sfu/signal"), "signal");
  const body = JSON.stringify({ op: "tracks", session_description: { type: "offer", sdp: "v=0" } });
  assert.deepEqual(signalingBody(body), { op: "tracks", replacementCause: null, bytes: Buffer.byteLength(body) });
  const rotation = JSON.stringify({ op: "tracks", replacement_cause: "section_budget" });
  assert.equal(signalingBody(rotation).replacementCause, "section_budget");
});

test("the replacement cause is read from the query string of a per-operation route too", () => {
  const url = "https://api.example.test/v1/spaces/s/episodes/e/media/sfu/tracks?replacement_cause=section_budget";
  assert.equal(signalingBody(JSON.stringify({ session_description: { type: "offer", sdp: "v=0" } }), url).replacementCause, "section_budget");
  assert.equal(signalingBody(null, url).replacementCause, "section_budget");
  assert.equal(signalingBody("{}", "https://api.example.test/v1/spaces/s/episodes/e/media/sfu/tracks").replacementCause, null);
});

test("a body that is empty or not JSON still reports its size", () => {
  assert.deepEqual(signalingBody(null), { op: null, replacementCause: null, bytes: 0 });
  assert.deepEqual(signalingBody("not json"), { op: null, replacementCause: null, bytes: 8 });
});
