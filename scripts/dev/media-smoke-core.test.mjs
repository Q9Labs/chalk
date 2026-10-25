import assert from "node:assert/strict";
import test from "node:test";

import { redactProof } from "./media-smoke-core.mjs";

test("redacts invite codes in URL paths and query values", () => {
  assert.equal(redactProof("failed at http://127.0.0.1:3070/abc-defg-hij?name=Guest"), "failed at http://127.0.0.1:3070/[redacted]?name=[redacted]");
  assert.equal(redactProof("retry /ABC-DEFG-HIJ"), "retry /[redacted]");
});

test("redacts word invite credentials before writing proof evidence", () => {
  assert.equal(redactProof("failed https://chalkmeet.com/apple-tiger-lamp-river?name=Guest"), "failed https://chalkmeet.com/[redacted]?name=[redacted]");
  assert.equal(redactProof("retry /APPLE-TIGER-LAMP-RIVER"), "retry /[redacted]");
});
