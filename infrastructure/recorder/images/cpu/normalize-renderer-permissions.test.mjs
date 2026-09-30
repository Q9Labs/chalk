import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = fileURLToPath(new URL("./normalize-renderer-permissions.mjs", import.meta.url));

test("installed renderer files and directories are readable by the service account", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chalk-renderer-permissions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const renderer = join(root, "renderer");
  const node = join(renderer, "dist", "node");
  mkdirSync(node, { recursive: true });
  const compositor = join(node, "compose.js");
  const dependency = join(node, "assets", "chunk.js");
  mkdirSync(join(node, "assets"));
  writeFileSync(compositor, "export {};\n");
  writeFileSync(dependency, "export {};\n");
  chmodSync(renderer, 0o700);
  chmodSync(join(renderer, "dist"), 0o700);
  chmodSync(node, 0o700);
  chmodSync(join(node, "assets"), 0o700);
  chmodSync(compositor, 0o600);
  chmodSync(dependency, 0o600);

  const result = spawnSync(process.execPath, [script, renderer], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const directory of [renderer, join(renderer, "dist"), node, join(node, "assets")]) {
    assert.equal(statSync(directory).mode & 0o005, 0o005, `${directory} must be traversable by the service account`);
  }
  for (const file of [compositor, dependency]) {
    assert.equal(statSync(file).mode & 0o004, 0o004, `${file} must be readable by the service account`);
  }
});
