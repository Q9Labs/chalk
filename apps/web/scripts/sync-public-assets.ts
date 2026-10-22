import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function copyAsset(source: string, relativePath: string) {
  const destination = resolve(publicDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

for (const directory of ["chalk-whiteboard", "chalk-mathjax"]) {
  rmSync(resolve(publicDir, directory), { recursive: true, force: true });
}
copyAsset(join(excalidrawRoot, "index.css"), "chalk-whiteboard/0.18.1/index.css");
copyAsset(join(excalidrawRoot, "fonts"), "chalk-whiteboard/0.18.1/fonts");
for (const directory of ["input", "output", "a11y", "ui", "sre"]) {
  copyAsset(join(mathJaxRoot, directory), `chalk-mathjax/4.1.3/${directory}`);
}
for (const file of ["tex-svg.js", "LICENSE"]) {
  copyAsset(join(mathJaxRoot, file), `chalk-mathjax/4.1.3/${file}`);
}
copyAsset(join(mathFontRoot, "svg"), "chalk-mathjax/4.1.3/fonts/mathjax-newcm-font/svg");
copyAsset(join(mathFontRoot, "svg.js"), "chalk-mathjax/4.1.3/fonts/mathjax-newcm-font/svg.js");
