import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "test-strict");

const waitForMarker = async (markerPath) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (readFileSync(markerPath, "utf8") === "started\n") {
        return;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail("the fake mix process did not start");
};

test("a terminated test pipeline fails closed and removes its capture", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "chalk-test-strict-"));
  const markerPath = join(fixtureRoot, "mix-started");
  const fakeMixPath = join(fixtureRoot, "mix");
  writeFileSync(fakeMixPath, `#!/usr/bin/env bash\nprintf 'started\\n' > "\${CHALK_TEST_STRICT_MARKER}"\nsleep 30\n`);
  chmodSync(fakeMixPath, 0o755);

  const child = spawn(scriptPath, [], {
    detached: true,
    env: {
      ...process.env,
      CHALK_TEST_STRICT_MARKER: markerPath,
      PATH: `${fixtureRoot}:${process.env.PATH}`,
      TMPDIR: fixtureRoot,
    },
    stdio: "ignore",
  });

  try {
    await waitForMarker(markerPath);
    assert.ok(child.pid);
    const closePromise = once(child, "close");
    process.kill(-child.pid, "SIGTERM");
    const [status, signal] = await closePromise;
    assert.equal(signal, null);
    assert.equal(status, 143);
    assert.deepEqual(readdirSync(fixtureRoot).sort(), ["mix", "mix-started"], "the captured test output must be removed on termination");
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
