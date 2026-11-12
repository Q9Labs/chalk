import assert from "node:assert/strict";
import test from "node:test";
import { allows, corsRefusal, refusedWithoutSignature, unsigned } from "./chat-upload.mjs";

test("a wildcard or a full list of signed headers passes the preflight", () => {
  assert.equal(allows("*", ["content-type"]), true);
  assert.equal(allows("Content-Type, x-amz-checksum-sha256", ["content-type", "x-amz-checksum-sha256"]), true);
  assert.equal(allows("Content-Type", ["content-type", "x-amz-checksum-sha256"]), false);
  assert.equal(allows(null, ["content-type"]), false);
});

test("a refusal names the step and the CORS headers it saw, and hides free text", () => {
  const response = { status: 403, headers: new Headers({ "access-control-allow-origin": "https://nightly.chalkmeet.com", "access-control-allow-methods": "<script>alert(1)</script>" }) };
  const message = corsRefusal("preflight", response, "origin refused");
  assert.match(message, /preflight from an origin on no list failed \(origin refused; HTTP 403;/);
  assert.match(message, /access-control-allow-origin=https:\/\/nightly\.chalkmeet\.com/);
  assert.match(message, /access-control-allow-methods=unexpected/);
  assert.match(message, /access-control-allow-headers=absent/);
});

test("the unsigned object URL drops the signature, and only a refusal passes", () => {
  assert.equal(unsigned("https://acct.r2.cloudflarestorage.com/bucket/key.txt?X-Amz-Signature=abc&X-Amz-Date=1"), "https://acct.r2.cloudflarestorage.com/bucket/key.txt");
  assert.equal(refusedWithoutSignature(403), true);
  assert.equal(refusedWithoutSignature(200), false);
  assert.equal(refusedWithoutSignature(206), false);
});
