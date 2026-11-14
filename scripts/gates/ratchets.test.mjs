import assert from "node:assert/strict";
import test from "node:test";
import { rises } from "./ratchets.mjs";

const baseline = { files: { "a.mjs": 400 }, copies: { "copy.x": 3 } };

test("a file that grew, a new long file and a higher count are all reported", () => {
  const messages = rises(baseline, { files: { "a.mjs": 401, "b.mjs": 301 }, copies: { "copy.x": 4 } });
  assert.equal(messages.length, 3);
  assert.match(messages[0], /a\.mjs grew from 400 to 401/);
  assert.match(messages[1], /b\.mjs has 301 lines/);
  assert.match(messages[2], /copy\.x rose from 3 to 4/);
});

test("equal or lower numbers pass", () => {
  assert.deepEqual(rises(baseline, { files: { "a.mjs": 400 }, copies: { "copy.x": 2 } }), []);
});
