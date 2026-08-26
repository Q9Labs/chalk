import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assistantFontFiles, buildReactStylesheet, inlineAssistantFonts } from "./build-css.mjs";

test("inlines each Excalidraw Assistant font reference", () => {
  const source = assistantFontFiles.map((fileName) => `@font-face{src:url(\"./fonts/Assistant/${fileName}\")}`).join("\n");
  const fonts = Object.fromEntries(assistantFontFiles.map((fileName) => [fileName, Buffer.from(fileName)]));
  const generated = inlineAssistantFonts(source, fonts);

  for (const fileName of assistantFontFiles) {
    const encodedFont = fonts[fileName].toString("base64");
    assert.match(generated, new RegExp(`url\\(\"data:font/woff2;base64,${encodedFont}\"\\)`));
    assert.doesNotMatch(generated, new RegExp(`fonts/Assistant/${fileName.replaceAll(".", "\\.")}`));
  }
});

test("publishes the React stylesheet and Excalidraw notice", async () => {
  const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const notice = await readFile(join(import.meta.dirname, "..", "THIRD_PARTY_NOTICES.md"), "utf8");

  assert.equal(packageJson.style, "./dist/react/index.css");
  assert.deepEqual(packageJson.sideEffects, ["./dist/react/index.css"]);
  assert.equal(packageJson.exports["./styles.css"], "./dist/react/index.css");
  assert.ok(packageJson.files.includes("THIRD_PARTY_NOTICES.md"));
  assert.match(notice, /Excalidraw 0\.18\.1/);
  assert.match(notice, /MIT License/);
});

test("generates the published stylesheet from Excalidraw production assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-whiteboard-css-proof-"));
  try {
    const outputPath = await buildReactStylesheet(directory);
    const generated = await readFile(outputPath, "utf8");

    assert.equal((generated.match(/url\(\"data:font\/woff2;base64,/g) ?? []).length, assistantFontFiles.length);
    assert.doesNotMatch(generated, /url\(\"\.\/fonts\/Assistant\/Assistant-(?:Regular|Medium|SemiBold|Bold)\.woff2\"\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
