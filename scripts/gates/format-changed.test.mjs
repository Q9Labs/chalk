import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGatePlan } from "./chalk-gate-plan.mjs";

test("the formatter checks a long list of changed paths, including paths with spaces", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chalk gate format "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const files = Array.from({ length: 200 }, (_, index) => `long screen annotation verification filename ${index}.ts`);
  for (const file of files) writeFileSync(join(root, file), "export const value = 1;\n");
  writeFileSync(join(root, "unrelated.ts"), "export const unrelated=2\n");

  const plan = createGatePlan(files, { repositoryRoot: root });
  const format = plan.tasks.find((task) => task.id === "format");
  const [node, launcher] = format.command;
  const absoluteLauncher = fileURLToPath(new URL(`../../${launcher}`, import.meta.url));
  assert.ok(format.input.length > 8191);
  const run = () => spawnSync(node, [absoluteLauncher], { cwd: root, input: format.input, encoding: "utf8" });
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);

  const changed = files.at(-1);
  writeFileSync(join(root, changed), "export const value=1\n");
  const dirty = run();
  assert.equal(dirty.status, 1, dirty.stderr || dirty.stdout);
  assert.match(dirty.stdout, new RegExp(changed, "u"));
  assert.doesNotMatch(dirty.stdout, /unrelated\.ts/u);
});
