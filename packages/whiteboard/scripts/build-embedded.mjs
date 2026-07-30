import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const outputRoot = join(packageRoot, "dist", "embedded", "chalk-whiteboard");
const compatibilityManifestPath = join(packageRoot, "src", "embedded", "compatibility-manifest.json");
const compatibilityManifest = JSON.parse(await readFile(compatibilityManifestPath, "utf8"));
if (compatibilityManifest.rendererBuildId !== "chalk-excalidraw-0.18.1-r1" || compatibilityManifest.bridge?.current !== 1 || compatibilityManifest.excalidraw?.version !== "0.18.1") {
  throw new Error("embedded whiteboard compatibility manifest does not match the renderer build");
}
const excalidrawRoot = await findPackageRoot(require.resolve("@excalidraw/excalidraw"), "@excalidraw/excalidraw");
const excalidrawProd = join(excalidrawRoot, "dist", "prod");
const mathJaxRoot = await findPackageRoot(require.resolve("mathjax"), "mathjax");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "mathjax"), { recursive: true });
await mkdir(join(outputRoot, "licenses"), { recursive: true });

await build({
  entryPoints: [join(packageRoot, "src", "embedded", "renderer.tsx")],
  outfile: join(outputRoot, "renderer.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome100", "safari15"],
  minify: true,
  legalComments: "none",
  sourcemap: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

await Promise.all([
  cp(join(excalidrawProd, "fonts"), join(outputRoot, "fonts"), { recursive: true }),
  cp(join(excalidrawProd, "index.css"), join(outputRoot, "index.css")),
  cp(join(mathJaxRoot, "tex-svg.js"), join(outputRoot, "mathjax", "tex-svg.js")),
  cp(compatibilityManifestPath, join(outputRoot, "compatibility-manifest.json")),
  copyWhenPresent(join(mathJaxRoot, "LICENSE"), join(outputRoot, "licenses", "MathJax.txt")),
]);

await writeFile(join(outputRoot, "mathjax-config.js"), `window.MathJax={options:{enableMenu:false},startup:{typeset:false},svg:{fontCache:"none"}};\n`);
await writeFile(
  join(outputRoot, "licenses", "Excalidraw.txt"),
  `MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);
await writeFile(
  join(outputRoot, "chalk.css"),
  [
    "html,body,#root{height:100%;width:100%;margin:0;overflow:hidden;background:#fff}",
    "#root>div{height:100%;width:100%}",
    ".chalk-whiteboard-loading,.chalk-whiteboard-closed{height:100%;display:flex;align-items:center;justify-content:center;font:600 15px Assistant,system-ui,sans-serif;color:#475569}",
    ".excalidraw{--color-primary:#0ea5e9;--color-primary-darker:#0284c7}",
    "iframe,object,embed{display:none!important}",
  ].join("\n"),
);

await writeFile(
  join(outputRoot, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self' data:; frame-src 'none'; img-src 'self' data: blob:; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; form-action 'none'">
    <link id="chalk-excalidraw-styles" rel="stylesheet" href="./index.css">
    <link rel="stylesheet" href="./chalk.css">
    <script defer src="./mathjax-config.js"></script>
    <script defer src="./mathjax/tex-svg.js"></script>
    <script defer src="./renderer.js"></script>
    <title>Chalk Whiteboard</title>
  </head>
  <body>
    <div id="root" aria-label="Chalk whiteboard"></div>
  </body>
</html>
`,
);

const notices = {
  generatedBy: "packages/whiteboard/scripts/build-embedded.mjs",
  artifacts: [
    {
      name: "@excalidraw/excalidraw",
      version: "0.18.1",
      license: "MIT",
      source: "https://github.com/excalidraw/excalidraw",
    },
    {
      name: "mathjax",
      version: "4.1.3",
      license: "Apache-2.0",
      source: "https://github.com/mathjax/MathJax-src",
    },
  ],
};
await writeFile(join(outputRoot, "THIRD_PARTY_NOTICES.json"), `${JSON.stringify(notices, null, 2)}\n`);

const manifest = await artifactManifest(outputRoot);
await writeFile(
  join(outputRoot, "asset-manifest.json"),
  `${JSON.stringify(
    {
      rendererBuildId: "chalk-excalidraw-0.18.1-r1",
      bridgeVersion: 1,
      excalidrawVersion: "0.18.1",
      offlineOnly: true,
      files: manifest,
    },
    null,
    2,
  )}\n`,
);

async function artifactManifest(root) {
  const files = [];
  await visit(root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function visit(directory, files) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path, files);
      continue;
    }
    if (entry.name === "asset-manifest.json") continue;
    const bytes = await readFile(path);
    files.push({
      path: relative(outputRoot, path).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

async function copyWhenPresent(source, destination) {
  try {
    await cp(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function findPackageRoot(entryPoint, expectedName) {
  let directory = dirname(entryPoint);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === expectedName) return directory;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Unable to resolve package root for ${expectedName}`);
    directory = parent;
  }
}
