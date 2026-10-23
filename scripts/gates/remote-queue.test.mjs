import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lsofCases = ["test_port_matches_never_authorize_signalling_foreign_processes", "test_quarantine_holder_evidence_is_bounded_and_connection_churn_is_quiet", "test_metro_gets_a_private_slot_port_that_blocks_release", "test_reap_legacy_keeps_live_unmarked_and_recent_resources"];

test("queue cases that need lsof skip on hosts without it", () => {
  const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const emptyPath = mkdtempSync(join(tmpdir(), "chalk-no-lsof-"));
  try {
    const result = spawnSync(python, [new URL("./remote-queue-test.py", import.meta.url).pathname, ...lsofCases.map((name) => `QueueTest.${name}`)], {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath },
      timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /OK \(skipped=4\)/);
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});

test("detached queue preserves FIFO, run IDs, results and crash cleanup", () => {
  // The suite takes about 100 s on a MacBook Air; twice that keeps a loaded runner from timing out.
  const result = spawnSync("python3", [new URL("./remote-queue-test.py", import.meta.url).pathname], { encoding: "utf8", timeout: 240000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
