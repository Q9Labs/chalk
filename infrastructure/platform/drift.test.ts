import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyDrift, driftChildEnv } from "./drift.ts";

const withDirectory = (run: (directory: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), "drift-env-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
};

const record = (status: "in-sync" | "drifted" | "missing" | "skipped") => ({ fqn: "Queue", logicalId: "Queue", resourceType: "AWS.SQS.Queue", status });

test("a record the check skipped is never clean", () => {
  assert.equal(classifyDrift([record("in-sync"), record("skipped")]), "check-failed");
});

test("only records that were all compared and matched are clean", () => {
  assert.equal(classifyDrift([record("in-sync"), record("in-sync")]), "clean");
  assert.equal(classifyDrift([]), "clean");
});

test("a changed or missing resource is drift even when another record was skipped", () => {
  assert.equal(classifyDrift([record("drifted")]), "drift");
  assert.equal(classifyDrift([record("skipped"), record("missing")]), "drift");
});

test("each private-input stack gets only its own inputs file, readable by the owner alone", () => {
  withDirectory((directory) => {
    const parent = { CHALK_SFU_INPUTS: '{"a":1}', CHALK_SFU_STANDBY_INPUTS: '{"b":2}', CHALK_RECORDER_INPUTS: '{"c":3}', CHALK_INFRA_INPUTS: "/stale", KEEP: "yes" };
    const sfu = driftChildEnv("sfu", "production", parent, directory);
    const recorder = driftChildEnv("recorder", "production", parent, directory);
    assert.equal(sfu.missing, undefined);
    assert.equal(readFileSync(sfu.env.CHALK_INFRA_INPUTS!, "utf8"), '{"a":1}');
    assert.equal(statSync(sfu.env.CHALK_INFRA_INPUTS!).mode & 0o777, 0o600);
    assert.equal(readFileSync(recorder.env.CHALK_INFRA_INPUTS!, "utf8"), '{"c":3}');
    assert.equal(sfu.env.KEEP, "yes");
    assert.deepEqual(
      Object.keys(sfu.env).filter((name) => name.endsWith("_INPUTS") && name !== "CHALK_INFRA_INPUTS"),
      [],
    );
  });
});

test("a private-input stack without its secret is reported missing, and other stacks need none", () => {
  withDirectory((directory) => {
    const missing = driftChildEnv("sfu-standby", "production", { CHALK_SFU_INPUTS: "{}", CHALK_INFRA_INPUTS: "/stale" }, directory);
    assert.equal(missing.missing, "CHALK_SFU_STANDBY_INPUTS");
    assert.equal(missing.env.CHALK_INFRA_INPUTS, undefined);
    assert.equal(driftChildEnv("transcription-dispatcher", "production", {}, directory).missing, undefined);
  });
});
