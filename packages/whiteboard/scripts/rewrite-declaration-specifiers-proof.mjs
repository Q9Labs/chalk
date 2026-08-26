import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rewriteDeclarationFiles, rewriteDeclarationSpecifiers } from "../../../scripts/rewrite-declaration-specifiers.mjs";

test("rewrites only extensionless static relative declaration specifiers", () => {
  const source = [
    'export type { ChalkWhiteboardController } from "./controller";',
    'export { chalkEmbeddedWhiteboardManifest } from "./manifest.js";',
    'import "./side-effect";',
    'import "./icon.svg";',
    'import "./index.css";',
    'import "./types.mts";',
    'import("./dynamic");',
    '// export { Comment } from "./comment";',
    'const text = "from \\\"./string\\\"";',
    'export * from "@q9labsai/chalk-whiteboard";',
  ].join("\n");

  assert.equal(
    rewriteDeclarationSpecifiers(source),
    [
      'export type { ChalkWhiteboardController } from "./controller.js";',
      'export { chalkEmbeddedWhiteboardManifest } from "./manifest.js";',
      'import "./side-effect.js";',
      'import "./icon.svg";',
      "",
      'import "./types.mts";',
      'import("./dynamic");',
      '// export { Comment } from "./comment";',
      'const text = "from \\\"./string\\\"";',
      'export * from "@q9labsai/chalk-whiteboard";',
    ].join("\n"),
  );
});

test("rewrites declaration files and removes stale maps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-whiteboard-declaration-proof-"));
  const declarationPath = join(directory, "index.d.ts");
  const nestedDeclarationPath = join(directory, "embedded", "index.d.ts");
  const mapPath = join(directory, "index.d.ts.map");
  const nestedMapPath = join(directory, "embedded", "index.d.ts.map");
  try {
    await mkdir(join(directory, "embedded"));
    await writeFile(declarationPath, 'export type { ChalkWhiteboardController } from "./controller";\n');
    await writeFile(nestedDeclarationPath, 'export type { ChalkEmbeddedWhiteboardTheme } from "./protocol";\n');
    await writeFile(mapPath, '{"version":3}\n');
    await writeFile(nestedMapPath, '{"version":3}\n');

    assert.deepEqual(await rewriteDeclarationFiles(directory), { changedFiles: 2, removedMaps: 2 });
    assert.equal(await readFile(declarationPath, "utf8"), 'export type { ChalkWhiteboardController } from "./controller.js";\n');
    assert.equal(await readFile(nestedDeclarationPath, "utf8"), 'export type { ChalkEmbeddedWhiteboardTheme } from "./protocol.js";\n');
    await assert.rejects(readFile(mapPath), { code: "ENOENT" });
    await assert.rejects(readFile(nestedMapPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
