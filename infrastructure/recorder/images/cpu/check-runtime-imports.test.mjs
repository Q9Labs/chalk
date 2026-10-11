import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRuntimeImports } from "./check-runtime-imports.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "chalk-renderer-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist/node/assets"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  return root;
}

test("checks lazy chunks even when the entry does not load them", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist/node/compose.js"), 'import "node:fs";');
  writeFileSync(join(root, "dist/node/assets/whiteboard.js"), 'import "chalk-missing-whiteboard-dependency";');
  assert.throws(() => checkRuntimeImports(root), /chalk-missing-whiteboard-dependency/);
  writeFileSync(join(root, "dist/node/assets/whiteboard.js"), 'export { readFile } from "node:fs/promises";');
  assert.equal(checkRuntimeImports(root), 2);
});

test("checks relative dynamic imports and missing files", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist/node/compose.js"), 'const load = () => import("./assets/whiteboard.js");');
  assert.throws(() => checkRuntimeImports(root), /resolved file does not exist/);
  writeFileSync(join(root, "dist/node/assets/whiteboard.js"), "export const paint = 1;");
  assert.equal(checkRuntimeImports(root), 1);
});

test("rejects runtime imports that cannot be statically verified", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist/node/compose.js"), "const load = (name) => import(name);");
  assert.throws(() => checkRuntimeImports(root), /non-literal runtime import/);
});

test("uses import conditions rather than require conditions", (t) => {
  const root = fixture(t);
  const dependency = join(root, "node_modules/conditional");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), '{"type":"module","exports":{"import":"./missing.js","require":"./exists.cjs"}}');
  writeFileSync(join(dependency, "exists.cjs"), "module.exports = 1;");
  writeFileSync(join(root, "dist/node/compose.js"), 'import "conditional";');
  assert.throws(() => checkRuntimeImports(root), /resolved file does not exist/);
});

test("accepts CommonJS builtins and resolves require dependencies", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist/node/compose.cjs"), 'const fs = require("fs");');
  assert.equal(checkRuntimeImports(root), 1);
  writeFileSync(join(root, "dist/node/compose.cjs"), 'require("chalk-missing-require-dependency");');
  assert.throws(() => checkRuntimeImports(root), /chalk-missing-require-dependency/);
});

test("rejects directory imports that Node cannot load", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist/node/compose.js"), 'import "./assets";');
  assert.throws(() => checkRuntimeImports(root), /resolved import is not a file/);
});
