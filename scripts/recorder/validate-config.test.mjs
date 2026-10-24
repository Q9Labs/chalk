import assert from "node:assert/strict";
import test from "node:test";
import { desiredCaptureNodes, minimumRenderNodes, assertReplacementWithinCap, assertOperationalReadiness } from "./validate-config.mjs";

test("capture defaults stay serial; density and free slots are configurable", () => {
  assert.equal(desiredCaptureNodes({ episodes: 0, participants: 0, inputMbps: 0 }), 0);
  assert.equal(desiredCaptureNodes({ episodes: 10, participants: 30, inputMbps: 40 }), 10);
  assert.throws(() => desiredCaptureNodes({ episodes: 10, participants: 30, inputMbps: 40, readySpare: 1 }));
  assert.equal(desiredCaptureNodes({ episodes: 1, participants: 3, inputMbps: 4, episodesPerNode: 4 }), 1);
  assert.throws(() => desiredCaptureNodes({ episodes: 1, participants: 3, inputMbps: 41 }));
});

test("ten render jobs fit the separate one-hour workload budget", () => {
  assert.equal(minimumRenderNodes(Array.from({ length: 10 }, () => ({ serviceMinutes: 35, deadlineMinutes: 60 }))), 10);
  assert.throws(() => assertReplacementWithinCap({ activeNodes: 10, replacementNodes: 1, maxNodes: 10 }));
});

test("unchanged production evidence inputs still open the operational gate", () => {
  const evidence = `sha256:${"a".repeat(64)}`;
  const env = {
    RECORDER_ENVIRONMENT: "production",
    RECORDER_STAGING_EVIDENCE_SHA256: evidence,
    RECORDER_STAGING_EVIDENCE_VERIFIED: "true",
    DO_CAPTURE_TOKEN: "test-capture",
    DO_RENDER_TOKEN: "test-render",
    CLOUDFLARE_API_TOKEN: "test-cloudflare",
    RECORDER_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::000000000000:role/test-recorder",
    RECORDER_BUCKET_NAME: "test-existing-bucket",
    RECORDER_BUCKET_IMPORT_ID: "test-existing-bucket",
    RECORDER_BUCKET_ADOPTION_PLAN_SHA256: evidence,
  };
  assert.equal(assertOperationalReadiness(env).stagingEvidenceDigest, evidence);
  assert.throws(() => assertOperationalReadiness({ ...env, RECORDER_STAGING_EVIDENCE_VERIFIED: "false" }));
});

test("capture floor is in slots and cap is configurable", () => {
  assert.equal(desiredCaptureNodes({ episodes: 4, participants: 0, inputMbps: 0, episodesPerNode: 4, readySpare: 8 }), 3);
  assert.equal(desiredCaptureNodes({ episodes: 10, participants: 0, inputMbps: 0, readySpare: 8, maxNodes: 20 }), 18);
  for (const invalid of [{ episodesPerNode: 0 }, { episodesPerNode: 0.5 }, { readySpare: -1 }, { episodesPerNode: 4, readySpare: 8, maxNodes: 1 }]) {
    assert.throws(() => desiredCaptureNodes({ episodes: 0, participants: 0, inputMbps: 0, ...invalid }));
  }
});
