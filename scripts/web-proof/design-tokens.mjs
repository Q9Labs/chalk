// Real SDK surfaces and production styles in Chromium; no live service or customer data.
// Run: node scripts/web-proof/design-tokens.mjs [output-dir] [baseline-ref]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "tsup";
import { chromium } from "playwright";

const output = resolve(process.argv[2] ?? ".private/design-token-proof");
const baseline = execFileSync("git", ["rev-parse", process.argv[3] ?? "a7f46229c"], { encoding: "utf8" }).trim();
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await mkdir(output, { recursive: true });
const changed = execFileSync("git", ["diff", "--name-only", baseline, "--", "sdks/typescript/react/src/components"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const beforeSource = resolve(output, "before-source");
await mkdir(beforeSource, { recursive: true });
for (const [index, file] of changed.entries()) await writeFile(resolve(beforeSource, `${index}.tsx`), execFileSync("git", ["show", `${baseline}:${file}`]));
await writeFile(resolve(output, "input.css"), `@import "${resolve("packages/ui/src/styles/index.css")}";\n@source "${resolve("sdks/typescript/react/src")}";\n@source "${resolve("packages/ui/src")}";\n@source "${output}";`);
const entry = resolve(output, "page.tsx");
await writeFile(
  entry,
  `
import React from "react";
import { createRoot } from "react-dom/client";
import { ParticipantTileSurface } from "${resolve("sdks/typescript/react/src/components/participant-tile/ParticipantTile.tsx")}";
import { ScreenSharePresentation } from "${resolve("sdks/typescript/react/src/components/composite/ScreenShareView.tsx")}";
import { MediaRequestDialog } from "${resolve("sdks/typescript/react/src/components/media-request-dialog/MediaRequestDialog.tsx")}";
import { ShellStyles } from "${resolve("sdks/typescript/react/src/components/control-bar/ShellStyles.tsx")}";
import { CallCardStyles } from "${resolve("sdks/typescript/react/src/components/call-card/CallCardStyles.tsx")}";
const q = new URLSearchParams(location.search);
const theme = q.get("theme") ?? "dark";
document.documentElement.dir = q.get("dir") ?? "ltr";
document.documentElement.dataset.chalkTheme = theme;
window.proof = { allowed: 0, stopped: 0, pinned: 0 };
createRoot(document.getElementById("root")).render(<main data-chalk data-chalk-theme={theme}>
  <ShellStyles /><CallCardStyles />
  <header><h1>Call surfaces</h1><p>Design-token proof · {theme} · {document.documentElement.dir} · reduced motion</p></header>
  <div className="proof-grid">
    <section><h2>Muted, hand raised, weak connection</h2><ParticipantTileSurface participant={{id:"fixture",displayName:"Alex Rivera",isLocal:true,isMuted:true,isHandRaised:true,handRaiseOrder:2,connectionQuality:1,isSpeaking:true}} mediaVisible={false} generatedAvatars={false} animatedAvatars={false} onClick={() => window.proof.pinned++} /></section>
    <section><h2>Local screen share</h2><div style={{height:240}}><ScreenSharePresentation sharedByName="You" isLocal primary media={<div style={{height:"100%",background:"linear-gradient(135deg,var(--chalk-app-panel),var(--chalk-app-canvas))"}} />} mediaVisible capture={{surface:"monitor",label:"Demo display"}} onStopSharing={async () => {window.proof.stopped++}} onChangeShare={async () => {}} /></div></section>
    <section className="proof-request"><h2>Media request</h2><MediaRequestDialog request={{requestId:"fixture",kind:"unmute",expiresAt:new Date(Date.now()+300000).toISOString(),actorParticipantId:"alex",actorDisplayName:"Alex"}} onDecline={() => {}} onAllow={() => {window.proof.allowed++}} /></section>
    <section><h2>Raised hand and file types</h2><div className="proof-card"><button className="chalk-shell-raise" aria-pressed="true"><svg viewBox="0 0 24 24"><path d="M8 12V5a1 1 0 0 1 2 0v6-7a1 1 0 0 1 2 0v7-6a1 1 0 0 1 2 0v7-3a1 1 0 0 1 2 0v8c0 6-9 7-11 2l-2-4a1 1 0 0 1 2-1l3 3"/></svg>Hand raised</button><div className="proof-files">{["pdf","docx","xlsx","pptx"].map(extension => <span key={extension} className="call-file-type" data-extension={extension}>{extension.toUpperCase()}</span>)}</div><p>Extension labels preserve meaning without color.</p></div></section>
  </div>
  <div id="opacity-bg" className="bg-[var(--chalk-app-danger)]/10" style={{display:"none"}} />
  <div id="opacity-border" className="border border-[var(--chalk-app-danger)]/35" style={{display:"none"}} />
</main>);
`,
);
execFileSync("pnpm", ["--dir", "packages/ui", "exec", "tailwindcss", "-i", resolve(output, "input.css"), "-o", resolve(output, "styles.css")], { stdio: "pipe" });
const aliases = {
  "@q9labsai/chalk-client": "sdks/typescript/client/src/index.ts",
  "@q9labsai/chalk-ui/reactions": "packages/ui/src/reactions.ts",
  "@q9labsai/chalk-ui/assets": "packages/ui/src/assets.ts",
  "@q9labsai/chalk-ui/button": "packages/ui/src/button.tsx",
  "@q9labsai/chalk-ui": "packages/ui/src/index.ts",
  "@q9labsai/chalk-assets": "packages/assets/src/index.ts",
  "@q9labsai/facehash/react": "packages/facehash/src/react.ts",
  "@q9labsai/facehash": "packages/facehash/src/index.ts",
};
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
                  return file ? { contents: execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" }), loader: file.endsWith("tsx") ? "tsx" : "ts" } : undefined;
                });
              },
            },
          ]
        : [],
  });
}
const layout = `html,body{margin:0;font:14px system-ui;background:var(--chalk-canvas);color:var(--chalk-text)}main{padding:24px;max-width:1440px;margin:auto}header{margin-bottom:20px}h1{font-size:22px;margin:0}h2{font-size:14px;margin:0 0 10px}p{color:var(--chalk-muted-text)}.proof-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.proof-card{padding:20px;border:1px solid var(--chalk-line);border-radius:12px;background:var(--chalk-surface)}.proof-files{display:flex;gap:12px;margin-top:20px}.proof-grid section{min-width:0}.proof-request{position:relative;min-height:260px}@media(max-width:640px){main{padding:16px}.proof-grid{grid-template-columns:1fr;gap:20px}}`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/styles.css") response.writeHead(200, { "content-type": "text/css" }).end(await readFile(resolve(output, "styles.css")));
  else if (/^\/(before|after)\/page.js$/u.test(url.pathname)) response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(resolve(output, url.pathname.slice(1))));
  else
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><style>${layout}</style></head><body><div id="root"></div><script type="module" src="/${url.searchParams.get("revision") === "before" ? "before" : "after"}/page.js"></script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const revision of ["before", "after"])
    for (const theme of ["dark", "light"])
      for (const width of [390, 1440, 1920])
        for (const dir of ["ltr", "rtl"]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.address().port}/?revision=${revision}&theme=${theme}&dir=${dir}`);
          const allow = page.getByRole("button", { name: "Allow", exact: true });
          await allow.waitFor();
          assert.deepEqual(errors, []);
          const computed = await page.evaluate(() => {
            const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Allow");
            const style = getComputedStyle(button);
            return {
              foreground: style.color,
              background: style.backgroundColor,
              opacityBackground: getComputedStyle(document.getElementById("opacity-bg")).backgroundColor,
              opacityBorder: getComputedStyle(document.getElementById("opacity-border")).borderTopColor,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert.equal(computed.overflow, false);
          assert.notEqual(computed.opacityBackground, "rgba(0, 0, 0, 0)");
          assert.match(computed.opacityBackground, /0\.1\)/u);
          assert.match(computed.opacityBorder, /0\.35\)/u);
          if (revision === "after") assert.notEqual(computed.foreground, computed.background);
          await page.screenshot({ path: resolve(output, `${revision}-${theme}-${width}-${dir}.png`), fullPage: true });
          // Keyboard activation and preserved actions, using the real components.
          await allow.focus();
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => window.proof.allowed === 1);
          await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
          await page.waitForFunction(() => window.proof.stopped === 1);
          await page.getByRole("button", { name: "Video tile for Alex Rivera", exact: true }).click();
          await page.waitForFunction(() => window.proof.pinned === 1);
          results.push({ revision, theme, width, dir, ...computed, keyboardAllow: true, stopSharing: true, pin: true });
          await page.close();
        }
  // Compose unaltered browser screenshots in readable before/after pairs.
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1 });
    const panels = [];
    for (const width of [1440, 390])
      for (const revision of ["before", "after"]) {
        const data = (await readFile(resolve(output, `${revision}-${theme}-${width}-ltr.png`))).toString("base64");
        panels.push(`<figure><figcaption>${revision.toUpperCase()} · ${theme} · ${width}px · reduced motion</figcaption><img src="data:image/png;base64,${data}"></figure>`);
      }
    await page.setContent(
      `<html><style>body{margin:0;padding:20px;background:#e5e7eb;font:18px system-ui;color:#111}h1{font-size:24px}article{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;padding:10px;background:white}figcaption{padding:8px;font-weight:600}img{display:block;width:100%}figure:nth-child(n+3) img{width:390px;margin:auto}</style><h1>Design tokens: ${theme} · real React SDK surfaces</h1><article>${panels.join("")}</article></html>`,
    );
    await page.screenshot({ path: resolve(output, `contact-sheet-${theme}.png`), fullPage: true });
    await page.close();
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify({ baseline, head, fixture: "Real SDK presentation components; ShellStyles/CallCardStyles applied to representative class markup; no live media or service.", results }, null, 2) + "\n");
  console.log(`Captured ${results.length} real Chromium states and two before/after contact sheets in ${output}`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
