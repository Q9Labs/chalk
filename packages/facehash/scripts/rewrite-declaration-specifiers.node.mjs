import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { rewriteDeclarationFiles, rewriteDeclarationSpecifiers } from "../../../scripts/rewrite-declaration-specifiers.mjs";

test("rewrites extensionless relative declaration imports for NodeNext", () => {
  const source = ['export type { FacehashNativeProps } from "./FacehashNative";', 'export { Facehash } from "./Facehash.js";', 'import type { FacehashScene } from "./core/index";', 'export * from "./icon.svg";', 'export * from "./module.mts";', 'export * from "@q9labsai/facehash";'].join("\n");

  assert.equal(
    rewriteDeclarationSpecifiers(source),
    ['export type { FacehashNativeProps } from "./FacehashNative.js";', 'export { Facehash } from "./Facehash.js";', 'import type { FacehashScene } from "./core/index.js";', 'export * from "./icon.svg";', 'export * from "./module.mts";', 'export * from "@q9labsai/facehash";'].join("\n"),
  );
});

test("rewrites side-effect imports without touching comments or string literals", () => {
  const source = ['// import "./comment";', 'declare const lookalike: "from \\"./string\\"";', 'import "./side-effect";', 'export * from "./already.mjs";'].join("\n");

  assert.equal(rewriteDeclarationSpecifiers(source), ['// import "./comment";', 'declare const lookalike: "from \\"./string\\"";', 'import "./side-effect.js";', 'export * from "./already.mjs";'].join("\n"));
});

test("rewrites declaration files and removes stale declaration maps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "facehash-declaration-proof-"));
  const declarationPath = path.join(directory, "index.native.d.ts");
  const nestedDeclarationPath = path.join(directory, "core", "index.d.ts");
  const mapPath = path.join(directory, "core", "index.d.ts.map");
  try {
    await mkdir(path.join(directory, "core"));
    await writeFile(declarationPath, 'export type { FacehashNativeProps } from "./FacehashNative";\n');
    await writeFile(nestedDeclarationPath, 'export type { FacehashData } from "./facehash-data";\n');
    await writeFile(mapPath, "{}\n");

    assert.deepEqual(await rewriteDeclarationFiles(directory), { changedFiles: 2, removedMaps: 1 });
    assert.equal(await readFile(declarationPath, "utf8"), 'export type { FacehashNativeProps } from "./FacehashNative.js";\n');
    assert.equal(await readFile(nestedDeclarationPath, "utf8"), 'export type { FacehashData } from "./facehash-data.js";\n');
    await assert.rejects(readFile(mapPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
