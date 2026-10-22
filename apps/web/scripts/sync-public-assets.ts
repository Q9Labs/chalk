import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCALIDRAW_ASSET_VERSION, MATHJAX_ASSET_VERSION } from "../src/lib/whiteboard-asset-versions";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "../public");
const blankHtml = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>\n';

function writePublicFile(relativePath: string, contents: string) {
  const outputPath = resolve(publicDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
}

writePublicFile("privacy-policy/index.html", blankHtml);

// Keep the package versions in the URL: old deployments may retain these immutable assets.
const whiteboardRequire = createRequire(resolve(scriptDir, "../../../packages/whiteboard/package.json"));
const excalidrawRoot = dirname(whiteboardRequire.resolve("@excalidraw/excalidraw"));
const mathJaxRoot = dirname(whiteboardRequire.resolve("mathjax"));
const mathJaxRequire = createRequire(join(mathJaxRoot, "package.json"));
const mathFontRoot = dirname(mathJaxRequire.resolve("@mathjax/mathjax-newcm-font/package.json"));

function assertAssetVersion(packagePath: string, expected: string) {
  const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || manifest.version !== expected) {
    throw new Error(`Asset version mismatch: ${packagePath}; update the immutable asset version from ${expected} before building`);
  }
}

assertAssetVersion(resolve(excalidrawRoot, "../../package.json"), EXCALIDRAW_ASSET_VERSION);
assertAssetVersion(join(mathJaxRoot, "package.json"), MATHJAX_ASSET_VERSION);
assertAssetVersion(join(mathFontRoot, "package.json"), MATHJAX_ASSET_VERSION);

function copyAsset(source: string, relativePath: string) {
  const destination = resolve(publicDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

copyAsset(join(excalidrawRoot, "index.css"), `chalk-whiteboard/${EXCALIDRAW_ASSET_VERSION}/index.css`);
copyAsset(join(excalidrawRoot, "fonts"), `chalk-whiteboard/${EXCALIDRAW_ASSET_VERSION}/fonts`);
for (const directory of ["input", "output", "a11y", "ui", "sre"]) {
  copyAsset(join(mathJaxRoot, directory), `chalk-mathjax/${MATHJAX_ASSET_VERSION}/${directory}`);
}
for (const file of ["tex-svg.js", "LICENSE"]) {
  copyAsset(join(mathJaxRoot, file), `chalk-mathjax/${MATHJAX_ASSET_VERSION}/${file}`);
}
copyAsset(join(mathFontRoot, "svg"), `chalk-mathjax/${MATHJAX_ASSET_VERSION}/fonts/mathjax-newcm-font/svg`);
copyAsset(join(mathFontRoot, "svg.js"), `chalk-mathjax/${MATHJAX_ASSET_VERSION}/fonts/mathjax-newcm-font/svg.js`);
