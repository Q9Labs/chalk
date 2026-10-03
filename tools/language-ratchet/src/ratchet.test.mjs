import assert from "node:assert/strict";
import test from "node:test";
import { countText, exclusionReason, TERMS } from "./ratchet.mjs";

test("browser storage stays foreign while product vocabulary remains banned", () => {
  assert.ok(Object.values(countText("window.sessionStorage.getItem('key')")).every((count) => count === 0));
  for (const term of TERMS) {
    const capitalized = term[0].toUpperCase() + term.slice(1);
    assert.equal(countText(`${term} ${term}Id ${capitalized} Storage`)[term], 3);
  }
});

test("Cloudflare vocabulary exceptions are exact wire-boundary paths", () => {
  assert.equal(exclusionReason("sdks/typescript/client/src/media/remote-track-response.ts"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/tracks.ts"), null);
  assert.equal(exclusionReason("apps/api/internal/adapters/cloudflare/sfu/adapter.go"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/httpapi/sfu_signaling.go"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/recorderworker/ingress_measurement_test.go"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("scripts/capture-ingress/run.mjs"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/mediapublications/reconciliation.go"), null);
  assert.equal(exclusionReason("apps/api/internal/httpapi/episodes.go"), null);
});
