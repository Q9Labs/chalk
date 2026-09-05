import assert from "node:assert/strict";
import test from "node:test";
import { exclusionReason } from "./ratchet.mjs";

test("Cloudflare vocabulary exceptions are exact wire-boundary paths", () => {
  assert.equal(exclusionReason("sdks/typescript/client/src/media/remote-track-response.ts"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("sdks/typescript/client/src/media/tracks.ts"), null);
  assert.equal(exclusionReason("apps/api/internal/adapters/cloudflare/sfu/adapter.go"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/httpapi/sfu_signaling.go"), "provider SDK vocabulary adapter");
  assert.equal(exclusionReason("apps/api/internal/mediapublications/reconciliation.go"), null);
  assert.equal(exclusionReason("apps/api/internal/httpapi/episodes.go"), null);
});
