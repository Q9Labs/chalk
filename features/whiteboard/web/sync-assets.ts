import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assetFiles, treeDigest } from "./vendor-asset-files";
import { EXCALIDRAW_ASSET_DIGEST, EXCALIDRAW_ASSET_ROOT, EXCALIDRAW_ASSET_VERSION, MATHJAX_ASSET_DIGEST, MATHJAX_ASSET_ROOT, MATHJAX_ASSET_VERSION } from "./whiteboard-asset-versions";

export function syncWhiteboardAssets(publicDir: string) {
  const whiteboardRequire = createRequire(new URL("../packages/canvas/package.json", import.meta.url));
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
    // Keep staging on the app's filesystem and outside Vite's public copy, even with linked dependencies.
    const stagingDirectory = resolve(publicDir, "../.cache/chalk-public-assets");
    mkdirSync(stagingDirectory, { recursive: true });
    const staging = mkdtempSync(join(stagingDirectory, "tree-"));
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
}
