import { acceptFixtureSocket, trackFixtureSockets } from "./sync-fixture-wire.mjs";
import { fixtureParticipant, syncFixtureEntry } from "./sync-fixture-entry.mjs";
// Local protocol fixture: real Chromium, WebSocket, SDK and failed-call screen.
// No production requests. Run: node scripts/web-proof/join-startup.mjs [output-dir]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { build } from "tsup";
import { chromium, devices } from "playwright";

const output = resolve(process.argv[2] ?? ".private/join-startup-proof");
await mkdir(output, { recursive: true });
const lifecycle = "sdks/typescript/client/src/connection/lifecycle.ts";
const surface = "sdks/typescript/react/src/components/chalk/StatusSurface.tsx";
const diagnostics = "sdks/typescript/client/src/sync/connect-diagnostics.ts";
const transport = "sdks/typescript/client/src/sync/v1-client.ts";
const baselineSources = Object.fromEntries([lifecycle, surface, diagnostics, transport].map((path) => [basename(path), path]));
async function readFrames(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const baseline = execFileSync("git", ["merge-base", "HEAD", "origin/master"], { encoding: "utf8" }).trim();
await writeFile(resolve(output, "revision.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline }, null, 2));
const entry = resolve(output, "page.tsx");
await writeFile(
  entry,
  `
import { StatusSurface } from "${resolve(surface)}";
${syncFixtureEntry([fixtureParticipant("Fixture")], { owner: [] })}
const started = performance.now();
root.render(<StatusSurface phase="entering" callName="Fixture call" />);
try {
  await client.join({ microphone: false, camera: false });
  root.render(<h1>Joined Fixture call</h1>);
} catch {
  const error = client.getSnapshot().connection.lastError;
  root.render(<StatusSurface phase="failed" callName="Fixture call" errorCode={error?.code} sync={error?.sync} onRetry={() => {}} onHome={() => {}} />);
}
window.proof = { dialCount, connection: client.getSnapshot().connection, diagnostics, elapsedMs: Math.round(performance.now() - started) };
window.disposeProof = () => client.dispose();
`,
);

const browser = await chromium.launch({ headless: true });
const results = [];
const lifetime = setTimeout(() => {
  process.exitCode = 1;
  void browser.close();
}, 600000);
try {
  for (const revision of ["before", "after"]) {
    const directory = resolve(output, revision);
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
        options.alias = { "@q9labsai/chalk-client": resolve("sdks/typescript/client/src/index.ts") };
        options.nodePaths = [resolve("apps/web/node_modules")];
        options.jsx = "automatic";
      },
      esbuildPlugins:
        revision === "before"
          ? [
              {
                name: "baseline",
                setup(builder) {
                  builder.onLoad({ filter: /(?:connection\/lifecycle\.ts|chalk\/StatusSurface\.tsx|sync\/(?:connect-diagnostics|v1-client)\.ts)$/ }, ({ path }) => ({
                    contents: execFileSync("git", ["show", `${baseline}:${baselineSources[basename(path)]}`], { encoding: "utf8" }),
                    loader: path.endsWith("tsx") ? "tsx" : "ts",
                  }));
                },
              },
            ]
          : [],
    });
    const bundle = await readFile(resolve(directory, "page.js"));
    // Each fault case owns its real server, sockets, timers and browser cleanup.
    // This manual proof matrix is not shipped in the SDK.
    // fallow-ignore-next-line complexity
    async function runCase(scenario, device, trial = 0) {
      let attempts = 0;
      const lossPattern = scenario === "lossy-stalled" ? (trial % 2 === 0 ? ["close", "stall", "close", "open"] : ["close", "stall", "close", "stall", "close", "open"]) : { retry: ["stall", "open"], offline: ["stall"], rejected: ["close"] }[scenario];
      const upgradeDelayMs = scenario === "lossy-stalled" ? (trial % 3 === 0 ? 1600 : 600) : 8000;
      let fastCloses = 0;
      const fastCloseDelaysMs = [];
      let stalledDials = 0;
      let frames = [];
      const sockets = new Set();
      const timers = new Set();
      const server = createServer(async (request, response) => {
        if (request.url === "/page.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(bundle);
        } else if (request.url === "/frames") {
          frames = await readFrames(request);
          response.end("ok");
        } else if (request.url.includes("/publications")) {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ incarnation: 1, sequence: 0, publications: [] }));
        } else {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.4 Arial;background:#0b0c0e;color:#ececee}#root{height:100dvh}.chalk-root{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}h1,p{margin:0}p{color:#9a9ca3}button{background:transparent;color:inherit;border:0;display:inline-flex;align-items:center;flex-direction:column;gap:8px;font:inherit}button span{display:grid;place-items:center;width:56px;height:56px;border-radius:50%;background:#1d1f23}[data-part=status-actions]{display:flex;gap:28px;margin-top:20px}</style></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>',
          );
        }
      });
      trackFixtureSockets(server, sockets);
      server.on("upgrade", (request, socket) => {
        attempts += 1;
        const step = lossPattern[Math.min(attempts - 1, lossPattern.length - 1)];
        if (step === "close") {
          fastCloses += 1;
          const receivedAt = performance.now();
          const timer = setTimeout(() => {
            timers.delete(timer);
            fastCloseDelaysMs.push(Math.round(performance.now() - receivedAt));
            socket.destroy();
          }, 52);
          timers.add(timer);
          return;
        }
        if (step === "stall") {
          stalledDials += 1;
          return; // Accept TCP without sending an HTTP response.
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (socket.destroyed) return;
          acceptFixtureSocket(request, socket, () => frames);
        }, upgradeDelayMs);
        timers.add(timer);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const context = await browser.newContext(device === "phone" ? { ...devices["Pixel 7"] } : { viewport: { width: 1440, height: 900 } });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error("pageerror", error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.proof, null, { timeout: 45000 });
        const result = await page.evaluate(() => window.proof);
        const expected = revision === "after" && (scenario === "retry" || scenario === "lossy-stalled") ? "live" : "failed";
        assert.ok(attempts > 0, JSON.stringify(result));
        console.log(
          JSON.stringify({ revision, scenario, device, trial, attempts, fastCloses, fastCloseDelaysMs, stalledDials, dialCount: result.dialCount, status: result.connection.status, code: result.connection.lastError?.code, sync: result.connection.lastError?.sync, elapsedMs: result.elapsedMs }),
        );
        assert.equal(result.connection.status, expected, JSON.stringify(result));
        assert.ok(fastCloseDelaysMs.every((delay) => delay < 1000));
        assert.ok(result.dialCount >= attempts && result.dialCount <= attempts + 1);
        if (expected === "live") assert.equal(result.dialCount, attempts);
        if (expected === "live") assert.equal(attempts, scenario === "retry" ? 2 : lossPattern.length);
        if (expected === "live" && scenario === "lossy-stalled") {
          assert.equal(fastCloses / attempts, 0.5);
          assert.equal(stalledDials, trial % 2 === 0 ? 1 : 2);
        }
        if (revision === "after" && expected === "failed") assert.equal(result.connection.lastError.code, "connection.sync_start_failed");
        if (revision === "after" && scenario === "rejected") {
          assert.equal(result.connection.lastError.sync.opened, false);
          assert.equal(result.connection.lastError.sync.closeCode, 1006);
          assert.equal(result.connection.lastError.sync.attempts, result.dialCount);
          assert.ok(result.connection.lastError.sync.attempt <= attempts);
          await page.getByText("The connection closed before the call service could be reached. Try again.", { exact: true }).waitFor();
          await page.getByText(new RegExp(`attempts=${result.dialCount};`)).waitFor();
        }
        if (trial < 2) await page.screenshot({ path: resolve(output, `${revision}-${scenario}-${device}-${trial}.png`) });
        await page.evaluate(() => window.disposeProof());
        results.push({ revision, scenario, device, trial, attempts, fastCloses, fastCloseDelaysMs, stalledDials, ...result });
      } finally {
        await context.close();
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    for (const [scenario, device] of [
      ["retry", "phone"],
      ["offline", "phone"],
      ["rejected", "phone"],
      ["rejected", "desktop"],
    ])
      await runCase(scenario, device);
    if (revision === "before") await runCase("lossy-stalled", "phone");
    else {
      for (let first = 0; first < 30; first += 4) await Promise.all(Array.from({ length: Math.min(4, 30 - first) }, (_, offset) => runCase("lossy-stalled", "phone", first + offset)));
    }
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
} finally {
  clearTimeout(lifetime);
  await browser.close();
}
