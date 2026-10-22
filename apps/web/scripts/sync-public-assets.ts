import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCALIDRAW_ASSET_VERSION, MATHJAX_ASSET_VERSION } from "../src/lib/whiteboard-asset-versions";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "../public");
const blankHtml = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>\n';

// Rewriting an unchanged HTML file makes every running Vite server reload its open pages.
function writePublicFile(relativePath: string, contents: string) {
  const outputPath = resolve(publicDir, relativePath);
  if (existsSync(outputPath) && readFileSync(outputPath, "utf8") === contents) return;
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

// Every Vite server imports this script, and parallel browser tests start several at once.
// A versioned tree never changes, so it is staged privately and published by one rename:
// no server sees another rewrite the files it is serving. Staging stays outside public/,
// so a start killed mid-copy can't leave a stray tree for the next build to deploy.
const stagingDir = resolve(scriptDir, "../node_modules/.cache/chalk-public-assets");

function publishVersionedTree(relativeRoot: string, entries: [source: string, relativePath: string][]) {
  const destination = resolve(publicDir, relativeRoot);
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  const staging = mkdtempSync(join(stagingDir, "tree-"));
  try {
    for (const [source, relativePath] of entries) cpSync(source, join(staging, relativePath), { recursive: true });
    renameSync(staging, destination);
  } catch (error) {
    if (!existsSync(destination)) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

publishVersionedTree(`chalk-whiteboard/${EXCALIDRAW_ASSET_VERSION}`, [
  [join(excalidrawRoot, "index.css"), "index.css"],
  [join(excalidrawRoot, "fonts"), "fonts"],
]);
publishVersionedTree(`chalk-mathjax/${MATHJAX_ASSET_VERSION}`, [
  ...["input", "output", "a11y", "ui", "sre", "tex-svg.js", "LICENSE"].map((entry): [string, string] => [join(mathJaxRoot, entry), entry]),
  [join(mathFontRoot, "svg"), "fonts/mathjax-newcm-font/svg"],
  [join(mathFontRoot, "svg.js"), "fonts/mathjax-newcm-font/svg.js"],
]);
