import assert from "node:assert/strict";
import test from "node:test";
import { commandBatches, runBatches } from "./command-batches.mjs";

test("a long list of files is split into commands that each fit a Windows command line", () => {
  const files = Array.from({ length: 400 }, (_, index) => `apps/web/src/components/some/deep/folder/File${index}.tsx`);
  const batches = commandBatches(["pnpm", "exec", "oxfmt", "--check", ...files], 4);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.join(" ").length <= 6000));
  assert.ok(batches.every((batch) => batch.slice(0, 4).join(" ") === "pnpm exec oxfmt --check"));
  assert.deepEqual(
    batches.flatMap((batch) => batch.slice(4)),
    files,
  );
});

test("a command with nothing to split stays one command", () => {
  assert.deepEqual(commandBatches(["node", "x.mjs"], 2), [["node", "x.mjs"]]);
});

test("runBatches runs every batch in order and returns the last result", async () => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push([command, ...args, options.cwd]);
    return { failed: false, exitCode: 0, at: calls.length };
  };
  const result = await runBatches(
    exec,
    [
      ["a", "1"],
      ["b", "2"],
    ],
    { cwd: "/r" },
  );
  assert.deepEqual(calls, [
    ["a", "1", "/r"],
    ["b", "2", "/r"],
  ]);
  assert.equal(result.at, 2);
});

test("runBatches stops at the first failure and keeps its exit code", async () => {
  const calls = [];
  const exec = async (command) => {
    calls.push(command);
    return command === "b" ? { failed: true, exitCode: 7 } : { failed: false, exitCode: 0 };
  };
  const result = await runBatches(exec, [["a"], ["b"], ["c"]], {});
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.exitCode, 7);
});
