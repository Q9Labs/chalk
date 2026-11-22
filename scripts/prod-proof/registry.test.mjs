import { strict as assert } from "node:assert";
import { test } from "node:test";
import { proofPlan } from "./registry.mjs";

test("standalone Transcript and Export need recording, but camera-share does not", () => {
  assert.equal(proofPlan("transcript").recordingRequired, true);
  assert.equal(proofPlan("export").recordingRequired, true);
  assert.equal(proofPlan("camera-share").recordingRequired, false);
});
