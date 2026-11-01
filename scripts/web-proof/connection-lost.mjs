import { acceptFixtureSocket, trackFixtureSockets } from "./sync-fixture-wire.mjs";
import { fixtureParticipant, syncFixtureEntry } from "./sync-fixture-entry.mjs";
// Real Chromium + Sync wire fixture. No production requests or credentials.
// Run: node scripts/web-proof/connection-lost.mjs [output-dir]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "tsup";
import { chromium } from "playwright";
import { recoveryBudgets } from "./recovery-budgets.mjs";

const budgets = recoveryBudgets();

const output = resolve(process.argv[2] ?? ".private/connection-lost-proof");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "input.css"), `@import "${resolve("packages/ui/src/styles/index.css")}";\n@source "${resolve("sdks/typescript/react/src")}";\n@source "${resolve("packages/ui/src")}";`);
execFileSync("pnpm", ["--dir", "packages/ui", "exec", "tailwindcss", "-i", resolve(output, "input.css"), "-o", resolve(output, "styles.css")], { stdio: "pipe" });
const entry = resolve(output, "page.tsx");
await writeFile(
  entry,
  `
import { Chalk } from "${resolve("sdks/typescript/react/src/components/chalk/Chalk.tsx")}";
${syncFixtureEntry([fixtureParticipant("You"), fixtureParticipant("Remote participant", "member", "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22")], { owner: [], member: [] })}
root.render(<Chalk client={client} spaceName="Fixture call" defaults={{ microphone: false, camera: false }} features={{ sounds: false, whiteboard: false }} />);
window.proof = { client, diagnostics, snapshot: () => ({ connection: client.getSnapshot().connection, roster: client.getSnapshot().participants.roster.map(p => p.displayName), remoteTracks: client.getSnapshot().media.remote.length }) };
`,
);

const aliases = {
  "@q9labsai/chalk-client": "sdks/typescript/client/src/index.ts",
  "@q9labsai/chalk-ui/reactions": "packages/ui/src/reactions.ts",
  "@q9labsai/chalk-ui/assets": "packages/ui/src/assets.ts",
  "@q9labsai/chalk-ui/button": "packages/ui/src/button.tsx",
  "@q9labsai/chalk-ui": "packages/ui/src/index.ts",
  "@q9labsai/chalk-assets": "packages/assets/src/index.ts",
  "@q9labsai/recording-presentation": "packages/recording-presentation/src/index.ts",
  "@q9labsai/chalk-whiteboard/react": "packages/whiteboard/src/react/index.ts",
  "@q9labsai/chalk-whiteboard": "packages/whiteboard/src/index.ts",
  "@q9labsai/facehash/react": "packages/facehash/src/react.ts",
  "@q9labsai/facehash": "packages/facehash/src/index.ts",
};
const browser = await chromium.launch({ headless: true });
const lifetime = setTimeout(() => {
  process.exitCode = 1;
  void browser.close();
}, 600000);
const results = [];
try {
  const directory = resolve(output, "current");
  await build({
    entry: { page: entry },
    outDir: directory,
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    splitting: false,
    silent: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.alias = Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, resolve(path)]));
      options.nodePaths = [resolve("apps/web/node_modules"), resolve("sdks/typescript/react/node_modules")];
      options.jsx = "automatic";
      options.loader = { ...options.loader, ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".wasm": "file" };
    },
  });
  for (const [device, width, height] of [
    ["laptop", 1440, 900],
    ["phone", 390, 844],
  ]) {
    let frames = [];
    const sockets = new Set();
    const assets = new Map([
      ["/styles.css", { type: "text/css", path: resolve(output, "styles.css") }],
      ["/page.js", { type: "text/javascript", path: resolve(directory, "page.js") }],
    ]);
    const server = createServer(async (request, response) => {
      const asset = assets.get(request.url);
      if (request.url === "/frames") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        frames = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(204).end();
      } else if (asset) {
        response.writeHead(200, { "content-type": asset.type }).end(await readFile(asset.path));
      } else {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end('<html><head><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0;background:#000;color:#eee;font:14px Arial}button{cursor:pointer}</style></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>');
      }
    });
    trackFixtureSockets(server, sockets);
    server.on("upgrade", (request, socket) => {
      acceptFixtureSocket(request, socket, () => frames);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: resolve(output, "video"), size: { width, height } } });
    try {
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error("pageerror", error.stack));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => window.proof?.client.getSnapshot().connection.status === "live");
      assert.equal(await page.getByText("Remote participant", { exact: true }).count(), 1);
      await page.waitForTimeout(750); // Allow a real heartbeat round-trip before disconnecting.
      const live = await page.evaluate(() => window.proof.snapshot());
      await context.setOffline(true);
      // Start transport loss deterministically; offline alone can leave an
      // established WebSocket alive until its heartbeat timeout.
      for (const socket of sockets) socket.destroy();
      const disconnectedAt = Date.now();
      await page.waitForFunction(() => window.proof.client.getSnapshot().connection.lastError?.code === "connection.sync_recovery_exhausted", null, { timeout: budgets.timeoutMs });
      assert.ok(Date.now() - disconnectedAt >= budgets.syncMs, "Sync exhausted before its real recovery budget");
      const exhausted = await page.evaluate(() => ({ ...window.proof.snapshot(), diagnostics: window.proof.diagnostics }));
      await page.getByRole("heading", { name: "Connection lost", exact: true }).waitFor();
      await page.getByRole("button", { name: "Rejoin", exact: true }).waitFor();
      assert.equal(exhausted.connection.status, "failed");
      assert.deepEqual(exhausted.roster, []);
      assert.equal(exhausted.remoteTracks, 0);
      const giveUp = exhausted.diagnostics.filter((event) => event.event === "recovery_exhausted");
      assert.equal(giveUp.length, 1);
      assert.equal(giveUp[0].recovery.reference, "connection.sync_recovery_exhausted");
      assert.ok(giveUp[0].recovery.attempts > 0);
      assert.ok(giveUp[0].recovery.transport.socketCloses.length > 0);
      assert.ok(giveUp[0].recovery.transport.socketCloses.every((close) => Number.isInteger(close.code) && typeof close.wasClean === "boolean"));
      assert.equal(typeof giveUp[0].recovery.lastHeartbeatReplyAgoMs, "number");
      assert.equal(giveUp[0].recovery.visibilityState, "visible");
      assert.equal(await page.getByText("Remote participant", { exact: true }).count(), 0);
      await page.evaluate((label) => {
        const tag = document.createElement("div");
        tag.textContent = label;
        tag.style.cssText = "position:fixed;bottom:0;left:0;z-index:1000;padding:8px 16px;background:#fff;color:#000;font:14px Arial";
        document.body.append(tag);
      }, `Current: ${width}px, dark, recovery exhausted`);
      await page.screenshot({ path: resolve(output, `current-${device}.png`) });
      await context.setOffline(false);
      await page.getByRole("button", { name: "Rejoin", exact: true }).click();
      await page.waitForFunction(() => window.proof.client.getSnapshot().connection.status === "live");
      assert.equal(await page.getByText("Remote participant", { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => window.proof.client.getSnapshot().connection.lastError), null);
      results.push({ device, live, exhausted, recoveryBudgets: budgets, rejoinVerified: true });
      await page.evaluate(() => window.proof.client.dispose());
    } finally {
      await context.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 2));
  console.log(JSON.stringify(results.map(({ device, exhausted, rejoinVerified }) => ({ device, status: exhausted.connection.status, code: exhausted.connection.lastError?.code, roster: exhausted.roster, rejoinVerified }))));
} finally {
  clearTimeout(lifetime);
  await browser.close();
}
