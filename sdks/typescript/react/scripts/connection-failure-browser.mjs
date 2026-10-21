import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../client/package.json", import.meta.url));
const { build } = require("esbuild");
const { chromium } = require("playwright");

const root = resolve(import.meta.dirname, "../../../..");
const sandbox = await mkdtemp(join(tmpdir(), "chalk-failure-browser-"));
const artifacts = process.env.CHALK_FAILURE_ARTIFACTS ?? sandbox;
const before = process.env.CHALK_FAILURE_BEFORE === "1";
let browser;
let server;
const timeout = setTimeout(() => {
  void cleanup().finally(() => process.exit(1));
}, 150000);
async function cleanup() {
  clearTimeout(timeout);
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(sandbox, { recursive: true, force: true });
}
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});
try {
  await mkdir(artifacts, { recursive: true });
  const sources = {
    "@q9labsai/chalk-client": "sdks/typescript/client/src/index.ts",
    "@q9labsai/chalk-ui": "packages/ui/src/index.ts",
    "@q9labsai/chalk-ui/reactions": "packages/ui/src/reactions.ts",
    "@q9labsai/chalk-ui/assets": "packages/ui/src/assets.ts",
    "@q9labsai/chalk-ui/button": "packages/ui/src/button.tsx",
    "@q9labsai/chalk-assets": "packages/assets/src/index.ts",
    "@q9labsai/chalk-whiteboard": "packages/whiteboard/src/index.ts",
    "@q9labsai/chalk-whiteboard/react": "packages/whiteboard/src/react/index.ts",
    "@q9labsai/facehash": "packages/facehash/src/index.ts",
    "@q9labsai/facehash/react": "packages/facehash/src/react.ts",
  };
  execFileSync("pnpm", ["--dir", "packages/ui", "exec", "tailwindcss", "--input", resolve(root, "apps/web/src/styles.css"), "--output", join(sandbox, "app.css")], { cwd: root, stdio: "pipe" });
  const baselineFiles = new Set(
    ["sdks/typescript/client/src/space-client/errors.ts", "sdks/typescript/client/src/space-client/store.ts", "sdks/typescript/client/src/connection/lifecycle.ts", "sdks/typescript/react/src/components/chalk/Chalk.tsx", "sdks/typescript/react/src/components/chalk/StatusSurface.tsx"].map((file) =>
      resolve(root, file),
    ),
  );
  const baseline = {
    name: "master-baseline",
    setup(plugin) {
      plugin.onLoad({ filter: /\.tsx?$/ }, ({ path }) =>
        baselineFiles.has(path)
          ? { contents: execFileSync("git", ["show", `${process.env.CHALK_FAILURE_BASE_REF ?? "c69cf1ef5cf1727f58c68b130d403494c7297b98"}:${path.slice(root.length + 1)}`], { cwd: root, encoding: "utf8" }), loader: path.endsWith("tsx") ? "tsx" : "ts", resolveDir: resolve(path, "..") }
          : undefined,
      );
    },
  };
  await build({
    plugins: before ? [baseline] : [],
    entryPoints: [join(import.meta.dirname, "connection-failure-browser.tsx")],
    outfile: join(sandbox, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    alias: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, resolve(root, source)])),
    loader: { ".css": "empty", ".woff2": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  server = createServer(async (request, response) => {
    if (request.url === "/access") {
      const token = (audience) => `${Buffer.from('{"alg":"EdDSA"}').toString("base64url")}.${Buffer.from(JSON.stringify({ aud: audience })).toString("base64url")}.fixture`;
      const expiresAt = new Date(Date.now() + 300000).toISOString();
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21", participant_generation: 1 },
          sync: { token: token("chalk-sync"), expires_at: expiresAt },
          media: { token: token("chalk-media"), expires_at: expiresAt, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" } },
        }),
      );
      return;
    }
    if (request.url === "/app.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(join(sandbox, "app.js")));
      return;
    }
    if (request.url === "/app.css") {
      response.setHeader("content-type", "text/css");
      response.end(await readFile(join(sandbox, "app.css")));
      return;
    }
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ headless: true });
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: artifacts, size: { width: 1440, height: 900 } }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      // Block the real WebSocket boundary, not the client's state or modules.
      await page.routeWebSocket(/127\.0\.0\.1:18798/, (socket) => socket.close());
      await page.goto(`http://127.0.0.1:${server.address().port}?theme=${theme}`);
      await page.locator('[data-chalk-status="failed"]').waitFor({ timeout: 20000 });
      const text = await page.locator("main").innerText();
      if (before) {
        assert.match(text, /Check your internet connection/);
        assert.doesNotMatch(text, /Reference:/);
      } else {
        assert.match(text, /The call service did not respond in time/);
        assert.match(text, /Reference: connection.sync_hello_timeout/);
        assert.doesNotMatch(text, /Check your internet connection/);
        assert(await page.getByRole("button", { name: "Try again" }).isEnabled());
      }
      for (const [name, width, height] of [
        ["laptop", 1440, 900],
        ["phone", 390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        for (const direction of ["ltr", "rtl"]) {
          await page.evaluate((dir) => (document.documentElement.dir = dir), direction);
          await page.screenshot({ path: join(artifacts, `${before ? "before" : "after"}-${name}-${theme}-${direction}.png`) });
          assert(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth));
        }
      }
      if (!before) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole("button", { name: "Try again" }).focus();
        assert(await page.getByRole("button", { name: "Try again" }).evaluate((button) => document.activeElement === button));
        const retryAccess = page.waitForRequest((request) => new URL(request.url()).pathname === "/access");
        await page.keyboard.press("Enter");
        await retryAccess;
        await page.locator("[data-call-limbo]").waitFor({ timeout: 5000 });
        await page.locator('[data-chalk-status="failed"]').waitFor({ timeout: 20000 });
        assert.match(await page.locator("main").innerText(), /Reference: connection.sync_hello_timeout/);
      }
    } finally {
      await context.close();
    }
  }
  console.log(`blocked Sync browser proof: ${before ? "before reproduced" : "passed"}; ${artifacts}`);
} finally {
  await cleanup();
}
