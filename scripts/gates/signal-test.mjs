import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// The command that a wrapper runs: it ignores TERM and INT, and so does the grandchild it leaves running.
export const stubbornCommand = '#!/bin/bash\ntrap "" TERM INT\nsleep 30 &\nprintf "%s %s\\n" "$$" "$!" > "$TEST_PIDS"\ntouch "$TEST_READY"\nwait\n';

// Starts a wrapper in its own process group, sends the group a signal once the wrapped command is ready,
// and returns how the wrapper exited and how long it took.
export async function signalWhenReady(context, { args, cwd, env, ready, signal }) {
  const child = spawn("bash", args, { cwd, detached: true, stdio: "ignore", env });
  const exited = new Promise((resolve) => child.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })));
  let early;
  exited.then((result) => (early = result));
  // A failed assertion leaves the wrapper running, and the test runner would wait for it.
  context.after(async () => {
    if (early !== undefined) return;
    process.kill(-child.pid, "SIGKILL");
    await exited;
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    assert.equal(early, undefined, "the wrapper exited before its command started");
    assert.ok(Date.now() < deadline, "the wrapper's command did not start within 10 seconds");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const started = Date.now();
  process.kill(-child.pid, signal);
  const result = await exited;
  return { ...result, seconds: (Date.now() - started) / 1000 };
}

export async function assertStopped(pids) {
  const deadline = Date.now() + 2_000;
  for (const pid of pids) {
    while (isRunning(pid)) {
      assert.ok(Date.now() < deadline, `process ${pid} still runs after the wrapper exited`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
