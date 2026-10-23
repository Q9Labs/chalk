import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assetFiles, treeDigest } from "./vendor-asset-files";
import { EXCALIDRAW_ASSET_DIGEST, EXCALIDRAW_ASSET_ROOT, EXCALIDRAW_ASSET_VERSION, MATHJAX_ASSET_DIGEST, MATHJAX_ASSET_ROOT, MATHJAX_ASSET_VERSION } from "../src/lib/whiteboard-asset-versions";

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
// no server sees another rewrite the files it is serving.

// A tree is reused only under the digest of the bytes installed now, so warm and clean builds agree.
function publishVersionedTree(urlRoot: string, digestName: string, pinnedDigest: string, entries: [source: string, relativePath: string][]) {
  const digest = treeDigest(assetFiles(entries));
  if (digest !== pinnedDigest) {
    throw new Error(`Asset digest mismatch: ${urlRoot} copies different bytes; set ${digestName} to "${digest}" so they get a new immutable URL`);
  }
  publishTree(urlRoot, (staging) => {
    for (const [source, relativePath] of entries) cpSync(source, join(staging, relativePath), { recursive: true });
  });
}

function publishTree(urlRoot: string, populate: (staging: string) => void) {
  const destination = resolve(publicDir, urlRoot.slice(1));
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  // A sibling guarantees rename stays on the destination filesystem, even with linked dependencies.
  const staging = mkdtempSync(`${destination}.staging-`);
  try {
    populate(staging);
    renameSync(staging, destination);
  } catch (error) {
    if (!existsSync(destination)) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

publishVersionedTree(EXCALIDRAW_ASSET_ROOT, "EXCALIDRAW_ASSET_DIGEST", EXCALIDRAW_ASSET_DIGEST, [
  [join(excalidrawRoot, "index.css"), "index.css"],
  [join(excalidrawRoot, "fonts"), "fonts"],
]);
publishVersionedTree(MATHJAX_ASSET_ROOT, "MATHJAX_ASSET_DIGEST", MATHJAX_ASSET_DIGEST, [
  ...["input", "output", "a11y", "ui", "sre", "tex-svg.js", "LICENSE"].map((entry): [string, string] => [join(mathJaxRoot, entry), entry]),
  [join(mathFontRoot, "svg"), "fonts/mathjax-newcm-font/svg"],
  [join(mathFontRoot, "svg.js"), "fonts/mathjax-newcm-font/svg.js"],
]);
