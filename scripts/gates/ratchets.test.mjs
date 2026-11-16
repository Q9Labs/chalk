import assert from "node:assert/strict";
import test from "node:test";
import { baselineRises, isSourceFile, rises } from "./ratchets.mjs";

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


test("ratchet baselines may fall, but cannot rise or add an unapproved long-file exception", () => {
  const previous = { files: { "a.mjs": 400 }, copies: { "copy.x": 3 } };
  assert.deepEqual(baselineRises(previous, { files: { "a.mjs": 399 }, copies: { "copy.x": 2 } }), []);
  assert.equal(baselineRises(previous, { files: { "a.mjs": 401 }, copies: { "copy.x": 3 } }).length, 1);
  assert.equal(baselineRises(previous, { files: { "a.mjs": 400, "new.sh": 320 }, copies: { "copy.x": 3 } }).length, 1);
  assert.deepEqual(baselineRises(previous, { files: { "a.mjs": 400, "old.sh": 330 }, copies: { "copy.x": 3 } }, { "old.sh": 330 }), []);
  assert.equal(baselineRises(previous, { files: { "a.mjs": 400, "old.sh": 331 }, copies: { "copy.x": 3 } }, { "old.sh": 330 }).length, 1);
  assert.equal(baselineRises(previous, { files: { "a.mjs": 400 }, copies: { "copy.x": 4 } }).length, 1);
});


test("the size ratchet includes extensionless Bash scripts", () => {
  assert.equal(isSourceFile("scripts/tools/deploy", "#!/usr/bin/env bash\necho ok\n"), true);
  assert.equal(isSourceFile("scripts/tools/data", "plain text\n"), false);
});
