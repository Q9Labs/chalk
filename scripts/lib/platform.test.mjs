import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execCommand, execCommandSync, findExecutable, isWindows, killTree, resolveCommand, runCommand, spawnCommand } from "./platform.mjs";

const node = process.execPath;

test("findExecutable finds a command on PATH and a command given with its directory", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "chalk-platform-"));
  try {
    const name = isWindows ? "tool.cmd" : "tool";
    const file = path.join(directory, name);
    writeFileSync(file, "");
    chmodSync(file, 0o755);
    assert.equal(findExecutable("tool", { PATH: directory, PATHEXT: ".CMD" }), file);
    assert.equal(findExecutable(file, {}), file);
    assert.equal(findExecutable("missing-tool", { PATH: directory }), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveCommand keeps a real executable and its arguments as given", () => {
  assert.deepEqual(resolveCommand(node, ["a b", "c"]), { file: node, args: ["a b", "c"] });
});

test("resolveCommand refuses an argument that cmd.exe cannot quote, only on Windows", { skip: !isWindows && "only a Windows .cmd target is quoted" }, () => {
  assert.throws(() => resolveCommand("pnpm", ['say "hi"']), /cannot quote it safely/);
});

test("the sync, async and spawn forms run a command and report its result", async () => {
  assert.equal(execCommandSync(node, ["-p", "1 + 1"], { encoding: "utf8" }).trim(), "2");
  assert.equal((await execCommand(node, ["-p", "2 + 2"], { encoding: "utf8" })).stdout.trim(), "4");
  const child = spawnCommand(node, ["-e", "process.exit(3)"]);
  const [code] = await new Promise((resolve) => child.once("exit", (...result) => resolve(result)));
  assert.equal(code, 3);
});

test("runCommand returns the exit status and names a command that cannot start", () => {
  assert.equal(runCommand(node, ["-e", "process.exit(4)"], { stdio: "ignore" }), 4);
  assert.throws(() => runCommand("chalk-no-such-command", [], { stdio: "ignore" }), /Cannot start chalk-no-such-command/);
});

test("killTree stops a child and its own child", async () => {
  const child = spawnCommand(node, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000)`], {
    detached: !isWindows,
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  killTree(child);
  await exited;
  assert.notEqual(child.exitCode === null ? child.signalCode : child.exitCode, null);
});
