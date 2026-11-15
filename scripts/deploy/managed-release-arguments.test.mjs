import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "./managed-release-arguments.mjs";

const base = [
  "--manifest",
  "release.json",
  "--environment",
  "nightly",
  "--region",
  "ap-southeast-1",
  "--instance-id",
  "i-0123456789abcdef0",
  "--document-name",
  "chalk-nightly-managed-episode-release",
  "--document-version",
  "1",
  "--parameter-prefix",
  "/chalk/nightly/managed-episode",
  "--request-id",
  "1.1.release",
  "--log-group-name",
  "/chalk/nightly/managed-episode",
];

test("the environment's dispatcher configuration is bound unless the deploy is a proof host's", () => {
  assert.equal(parseArguments(base).dispatcherConfigParameter, "/chalk/nightly/release/recorder.json");
  assert.equal(parseArguments([...base, "--no-dispatcher-binding"]).dispatcherConfigParameter, undefined);
});

test("a proof host cannot ask for a dispatcher configuration as well", () => {
  assert.throws(() => parseArguments([...base, "--no-dispatcher-binding", "--dispatcher-config-parameter", "/chalk/nightly/release/recorder.json"]), /cannot be combined/);
});
