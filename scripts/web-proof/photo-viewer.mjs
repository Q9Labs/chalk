// Real SDK photo-viewer capture. Run on Linux with an output directory and baseline ref.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build } from "tsup";
import { chromium } from "playwright";

const output = resolve(process.argv[2] ?? ".private/photo-viewer-proof");
const baseline = process.argv[3] ?? "a7f46229c";
const source = (file) => execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" });
await mkdir(output, { recursive: true });
const entry = resolve(output, "page.tsx");
await writeFile(
  entry,
  `
import React from "react";
import { createRoot } from "react-dom/client";
import { MessageBubble } from "${resolve("sdks/typescript/react/src/components/composite/MessageBubble.tsx")}";
import { CallCardStyles } from "${resolve("sdks/typescript/react/src/components/call-card/CallCardStyles.tsx")}";
const theme = new URLSearchParams(location.search).get("theme");
document.documentElement.dataset.chalkTheme = theme;
const attachments = [1,2].map(n => ({attachmentId:"photo-"+n,fileName:"landscape-"+n+".svg",mimeType:"image/svg+xml",sizeBytes:500}));
const resolveUrl = async id => "/"+id+".svg";
createRoot(document.getElementById("root")).render(<main data-chalk data-chalk-theme={theme}>
<CallCardStyles/><h1>Chat</h1><MessageBubble content="Two landscape photos" senderName="Alex" timestamp="2026-01-01T10:00:00Z" displayTime="10:00" showAvatar={false} attachments={attachments} onResolveAttachmentUrl={resolveUrl}/>
</main>);
`,
);
const aliases = {
  "@q9labsai/chalk-client": "sdks/typescript/client/src/index.ts",
  "@q9labsai/chalk-assets": "packages/assets/src/index.ts",
  "@q9labsai/chalk-ui": "packages/ui/src/index.ts",
  "@q9labsai/whiteboard": "packages/whiteboard/src/index.ts",
  "@q9labsai/facehash/react": "packages/facehash/src/react.ts",
  "@q9labsai/facehash": "packages/facehash/src/index.ts",
};
const changed = execFileSync("git", ["diff", "--name-only", baseline, "--", "sdks/typescript/react/src/components"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
for (const revision of ["before", "after"]) {
  await build({
    entry: { page: entry },
    outDir: resolve(output, revision),
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    splitting: false,
    silent: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.alias = Object.fromEntries(Object.entries(aliases).map(([name, file]) => [name, resolve(file)]));
      options.nodePaths = [resolve("apps/web/node_modules"), resolve("sdks/typescript/react/node_modules")];
      options.jsx = "automatic";
      options.loader = { ...options.loader, ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl" };
    },
    esbuildPlugins:
      revision === "before"
        ? [
            {
              name: "baseline",
              setup(builder) {
                builder.onLoad({ filter: /\.[jt]sx?$/ }, ({ path }) => {
                  const file = changed.find((file) => resolve(file) === path);
                  return file ? { contents: source(file), loader: file.endsWith("tsx") ? "tsx" : "ts" } : undefined;
                });
              },
            },
          ]
        : [],
  });
  const input = resolve(output, `${revision}.css`);
  const css = revision === "before" ? source("packages/ui/src/styles/index.css") : await readFile("packages/ui/src/styles/index.css", "utf8");
  await writeFile(
    input,
    css.replaceAll('@import "tailwindcss"', `@import "${resolve("packages/ui/node_modules/tailwindcss/index.css")}"`).replaceAll('@import "tw-animate-css"', `@import "${resolve("packages/ui/node_modules/tw-animate-css/dist/tw-animate.css")}"`) +
      `\n@source "${resolve("sdks/typescript/react/src")}";\n@source "${resolve("packages/ui/src")}";`,
  );
  execFileSync("pnpm", ["--dir", "packages/ui", "exec", "tailwindcss", "-i", input, "-o", resolve(output, `${revision}-styles.css`)], { stdio: "pipe" });
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const revision = url.searchParams.get("revision") === "before" ? "before" : "after";
  if (/^\/(before|after)\/page.js$/u.test(url.pathname)) response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(resolve(output, url.pathname.slice(1))));
  else if (/^\/(before|after)-styles.css$/u.test(url.pathname)) response.writeHead(200, { "content-type": "text/css" }).end(await readFile(resolve(output, url.pathname.slice(1))));
  else if (/^\/photo-[12].svg$/u.test(url.pathname))
    response
      .writeHead(200, { "content-type": "image/svg+xml" })
      .end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="${url.pathname.includes("1") ? "#92c8de" : "#dbb9e7"}"/><path d="M0 500V370L180 130 390 400 600 180 800 370V500Z" fill="#38615a"/><path d="M0 500L300 300 500 500Z" fill="#659d78"/><circle cx="650" cy="90" r="40" fill="#fce9a2"/></svg>`,
      );
  else
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${revision}-styles.css"><style>body{margin:0;background:var(--chalk-app-canvas);color:var(--chalk-app-text);font:16px system-ui}main{padding:32px;max-width:900px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="/${revision}/page.js"></script></body></html>`,
      );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const revision of ["before", "after"])
    for (const theme of ["dark", "light"])
      for (const width of [390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/?revision=${revision}&theme=${theme}`);
        await page.getByRole("button", { name: "View landscape-1.svg", exact: true }).click();
        const viewer = page.getByRole("dialog", { name: "Photo viewer" });
        await viewer.waitFor({ state: "visible" });
        await viewer.getByRole("img", { name: "landscape-1.svg" }).evaluate((img) => img.decode());
        const backdrop = await viewer.evaluate((node) => getComputedStyle(node).backgroundColor);
        assert.equal(backdrop, "rgba(8, 8, 10, 0.94)");
        // Labels annotate evidence without replacing product content.
        await page.evaluate((label) => {
          const badge = document.createElement("aside");
          badge.textContent = label;
          badge.style.cssText = "position:fixed;bottom:8px;left:8px;z-index:99999;background:white;color:black;padding:6px 10px;font:14px system-ui;pointer-events:none";
          document.querySelector("dialog").append(badge);
        }, `${revision.toUpperCase()} · ${theme} · ${width}px · reduced motion`);
        await page.screenshot({ path: resolve(output, `${revision}-${theme}-${width}.png`) });
        await page.keyboard.press("ArrowRight");
        await viewer.getByRole("img", { name: "landscape-2.svg" }).waitFor();
        await page.keyboard.press("ArrowLeft");
        await viewer.getByRole("img", { name: "landscape-1.svg" }).waitFor();
        await page.keyboard.press("Escape");
        await viewer.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "View landscape-1.svg", exact: true }).click();
        await page.getByRole("button", { name: "Close photo viewer", exact: true }).click();
        await viewer.waitFor({ state: "hidden" });
        assert.deepEqual(errors, []);
        results.push({ revision, theme, width, backdrop, arrows: true, escape: true, close: true, pageErrors: errors });
        await page.close();
      }
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1800 } });
    const panels = [];
    for (const width of [1440, 390])
      for (const revision of ["before", "after"])
        panels.push(
          `<figure><figcaption>${revision.toUpperCase()} · ${theme} · ${width}px</figcaption><img style="${width === 390 ? "width:312px;margin:auto" : "width:100%"}" src="data:image/png;base64,${(await readFile(resolve(output, `${revision}-${theme}-${width}.png`))).toString("base64")}"></figure>`,
        );
    await page.setContent(
      `<style>body{background:#eee;color:#111;margin:0;padding:20px;font:18px system-ui}article{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;padding:10px;background:white}figcaption{padding:6px}img{display:block}</style><h1>Photo viewer: ${theme}</h1><article>${panels.join("")}</article>`,
    );
    await page.screenshot({ path: resolve(output, `photo-viewer-${theme}.png`), fullPage: true });
    await page.close();
  }
  await writeFile(resolve(output, "result.json"), JSON.stringify({ baseline, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 2));
  console.log(`Photo viewer proof passed: ${results.length} real-component captures in ${output}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
