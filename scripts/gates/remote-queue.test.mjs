import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("detached queue preserves FIFO, run IDs, results and crash cleanup", () => {
  const result = spawnSync("python3", [new URL("./remote-queue-test.py", import.meta.url).pathname], { encoding: "utf8", timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
