import assert from "node:assert/strict";
import test from "node:test";
import { commandBatches } from "./command-batches.mjs";

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
