import assert from "node:assert/strict";
import test from "node:test";
import { laneCommands } from "./lane-commands.mjs";

test("large Windows formatting scopes check every file without exceeding the cmd shim's limit", () => {
  const files = Array.from({ length: 200 }, (_, index) => `apps/web/src/features/screen annotation long path ${index}.ts`);
  const prefix = ["pnpm", "exec", "oxfmt", "--check"];
  const task = { id: "format", command: [...prefix, ...files] };

  assert.deepEqual([...laneCommands(task, false)], [task.command]);
  const windowsCommands = [...laneCommands(task, true)];
  assert.ok(windowsCommands.length > 1);
  for (const command of windowsCommands) {
    assert.deepEqual(command.slice(0, prefix.length), prefix);
    assert.ok(command.slice(prefix.length).reduce((size, file) => size + file.length + 3, 0) <= 2000);
  }
  assert.deepEqual(
    windowsCommands.flatMap((command) => command.slice(prefix.length)),
    files,
  );
});
