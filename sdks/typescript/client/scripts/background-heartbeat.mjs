// Headful, silent, no-WebRTC transport reproduction against disposable Postgres/Sync.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const duration = Number(process.env.HEARTBEAT_PROOF_SECONDS ?? 160) * 1000;
const directory = await mkdtemp(join(tmpdir(), "chalk-background-heartbeat-"));
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
let fixture, browser, server, chrome;
try {
  fixture = spawn("mix", ["run", "--no-start", "test/support/browser/background_heartbeat.exs"], {
    cwd: join(root, "apps/sync"),
    env: { ...process.env, MIX_ENV: "test" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const config = await new Promise((resolveConfig, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("fixture startup timeout")), 60000);
    fixture.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
    fixture.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (line.startsWith("HEARTBEAT_FIXTURE=")) {
          clearTimeout(timeout);
          resolveConfig(JSON.parse(line.slice("HEARTBEAT_FIXTURE=".length)));
        }
      }
      buffer = buffer.split("\n").at(-1);
    });
  });
  await build({ entryPoints: [resolve(process.env.HEARTBEAT_SDK_ENTRY)], nodePaths: [join(root, "sdks/typescript/client/node_modules"), join(root, "node_modules")], bundle: true, platform: "browser", format: "esm", outfile: join(directory, "client.js") });
  const bundle = await readFile(join(directory, "client.js"));
  server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle);
      return;
    }
    const index = request.url === "/hidden" ? 0 : 1;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><link rel="icon" href="data:,"><title>Chalk heartbeat ${index}</title><script type="module">
      import { createV1SyncClient } from '/client.js';
      const nativeTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) => {
        const scheduled = Date.now();
        return nativeTimeout(() => {
          if ((delay === 500 || delay === 20000) && Date.now() - scheduled > delay + 5000)
            console.log(JSON.stringify({event:'late_timer',delay,elapsed:Date.now()-scheduled,visibility:document.visibilityState}));
          callback(...args);
        }, delay);
      };
      const NativeSocket = WebSocket;
      globalThis.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('close', event => console.log(JSON.stringify({event:'wire_close',code:event.code,reason:event.reason})));
        }
      };
      const nativeClose = WebSocket.prototype.close;
      WebSocket.prototype.close = function(code, reason) {
        console.log(JSON.stringify({event:'client_close',code,reason}));
        return nativeClose.call(this,code,reason);
      };
      const client = createV1SyncClient({url:${JSON.stringify(config.url)},token:async()=>${JSON.stringify(config.tokens[index])}});
      window.client = client;
      let last;
      client.subscribe(() => {
        const s = client.getSnapshot();
        const state = JSON.stringify(s.connection);
        if (state !== last) { console.log(JSON.stringify({event:'connection',connection:s.connection})); last=state; }
      });
      document.addEventListener('visibilitychange',()=>console.log(JSON.stringify({event:'visibility',state:document.visibilityState})));
      await client.start();
    </script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  chrome = spawn(
    chromium.executablePath(),
    ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome startup timeout")), 30000);
    chrome.once("exit", (code) => reject(new Error(`Chrome exited ${code}`)));
    chrome.stderr.on("data", (chunk) => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolveEndpoint(match[1]);
      }
    });
  });
  // Playwright's normal launch forces every page visible. Attach without those overrides.
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  log("browser", { version: browser.version(), durationMs: duration, graceSeconds: 10 });
  const context = browser.contexts()[0];
  const pages = [];
  let hiddenClosed = false,
    lateTimers = 0,
    observerLostParticipant = false;
  for (const name of ["hidden", "visible"]) {
    const page = await context.newPage();
    pages.push(page);
    page.on("console", (message) => {
      if (message.type() === "log") {
        const data = JSON.parse(message.text());
        if (name === "hidden" && data.event === "late_timer") lateTimers++;
        log("page", { tab: name, ...data });
      }
    });
    page.on("pageerror", (error) => log("pageerror", { tab: name, message: error.message }));
    page.on("websocket", (socket) => {
      log("socket_open", { tab: name });
      socket.on("close", () => {
        if (name === "hidden") hiddenClosed = true;
        log("socket_close", { tab: name });
      });
      let lastPing = 0;
      socket.on("framesent", (frame) => {
        const data = JSON.parse(frame.payload);
        if (data.type === "ping") {
          const now = Date.now();
          if (lastPing && now - lastPing > 5000) log("ping_gap", { tab: name, gapMs: now - lastPing });
          lastPing = now;
        }
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${name}`);
    await page.waitForFunction(() => window.client?.getSnapshot().connection.phase === "live");
  }
  const hiddenParticipantId = await pages[0].evaluate(() => window.client.getSnapshot().participantId);
  await pages[1].bringToFront();
  const visibility = await pages[0].evaluate(() => document.visibilityState);
  log("hidden_started", { visibility });
  if (visibility !== "hidden") throw new Error("background page is not hidden");
  const started = Date.now();
  while (Date.now() - started < duration) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 30000));
    const snapshot = await pages[1].evaluate(() => {
      const s = window.client.getSnapshot();
      return { connection: s.connection, presence: s.presence };
    });
    const connected = snapshot.presence?.items.filter((item) => item.state === "connected").map((item) => item.participantId) ?? [];
    if (!connected.includes(hiddenParticipantId)) observerLostParticipant = true;
    log("observer", { elapsedMs: Date.now() - started, connection: snapshot.connection, connectedCount: connected.length, hiddenConnected: connected.includes(hiddenParticipantId) });
  }
  const snapshot = await pages[0].evaluate(() => ({ visibility: document.visibilityState, connection: window.client.getSnapshot().connection }));
  log("result", { hiddenClosed, lateTimers, observerLostParticipant, ...snapshot });
  if (process.env.HEARTBEAT_EXPECT_SURVIVAL === "1" && (hiddenClosed || observerLostParticipant || lateTimers < 10 || snapshot.connection.phase !== "live")) throw new Error("hidden participant did not survive proven throttling");
} finally {
  await browser?.close();
  if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  if (fixture && fixture.exitCode === null) {
    fixture.stdin.end("\n");
    await Promise.race([once(fixture, "exit"), new Promise((resolveExit) => setTimeout(resolveExit, 5000))]);
    if (fixture.exitCode === null) fixture.kill("SIGTERM");
  }
  await rm(directory, { recursive: true, force: true });
}
