import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../../..");
const syncDirectory = join(repositoryDirectory, "apps/sync");
const distDirectory = join(packageDirectory, "dist");
const fixturePrefix = "CHALK_SYNC_BROWSER_FIXTURE=";
const fixtureTimeoutMs = 30_000;
const browserTimeoutMs = 15_000;

await run();

async function run() {
  const external = externalFixture();
  const fixture = external ? null : await startFixture(requiredDatabaseUrl());
  let config;
  let browser;
  let browserBundleDirectory;
  let server;

  try {
    config = external ?? (await fixture.ready);
    assertLocalhostWebSocketUrl(config.url);
    browserBundleDirectory = await buildBrowserProof();
    server = await startBrowserServer(config, join(browserBundleDirectory, "client.js"));
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: process.env.CHALK_SYNC_BROWSER_HEADED !== "1" });
    console.log("real-browser sync proof: Chromium launched");
    const page = await browser.newPage();
    const browserErrors = [];
    const missingAssets = [];
    const receivedFrameTypes = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("requestfailed", (request) => {
      missingAssets.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "request failed"}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        missingAssets.push(new URL(response.url()).pathname);
      }
    });
    page.on("websocket", (socket) => {
      socket.on("framereceived", (event) => {
        try {
          receivedFrameTypes.push(JSON.parse(event.payload).type ?? "unknown");
        } catch {
          receivedFrameTypes.push("non-json");
        }
        if (receivedFrameTypes.length > 12) receivedFrameTypes.shift();
      });
      socket.on("socketerror", (error) => missingAssets.push(`websocket: ${error}`));
    });
    await page.goto(server.url, { waitUntil: "load" });
    try {
      await page.waitForFunction(() => "__chalkSyncProof" in window, undefined, { timeout: browserTimeoutMs + 1_000 });
    } catch (error) {
      const diagnostics = [browserErrors.length > 0 ? browserErrors.slice(0, 3).join(" | ") : null, missingAssets.length > 0 ? `missing assets: ${[...new Set(missingAssets)].slice(0, 3).join(", ")}` : null].filter(Boolean).join(" | ");
      throw new Error(`browser harness did not finish: ${diagnostics}`, { cause: error });
    }
    const result = await page.evaluate(() => window.__chalkSyncProof);

    if (!result || result.status !== "passed") {
      throw new Error(`real-browser sync proof failed: ${result?.message ?? "browser harness did not report a result"}`);
    }
    if (browserErrors.length > 0 || missingAssets.length > 0) {
      const diagnostics = [...browserErrors.slice(0, 3), ...[...new Set(missingAssets)].slice(0, 3)].join(" | ");
      throw new Error(`real-browser sync proof emitted browser or network errors: ${diagnostics}; recent frames=${receivedFrameTypes.join(",")}`);
    }

    console.log(`real-browser sync proof passed: url=${config.url} revision=${result.revision}`);
  } finally {
    await browser?.close();
    await server?.close();
    if (browserBundleDirectory) {
      await rm(browserBundleDirectory, { force: true, recursive: true });
    }
    await fixture?.stop();
  }
}

function externalFixture() {
  const url = process.env.CHALK_SYNC_BROWSER_URL;
  const token = process.env.CHALK_SYNC_BROWSER_TOKEN;

  if (!url && !token) {
    return null;
  }
  if (!url || !token) {
    throw new Error("CHALK_SYNC_BROWSER_URL and CHALK_SYNC_BROWSER_TOKEN must be set together");
  }
  return { url, token };
}

function requiredDatabaseUrl() {
  const url = process.env.CHALK_SYNC_TEST_DATABASE_URL ?? process.env.CHALK_DATABASE_URL;
  if (!url) {
    throw new Error("set CHALK_SYNC_TEST_DATABASE_URL to run the Postgres-backed real-browser sync proof");
  }
  return url;
}

function assertLocalhostWebSocketUrl(value) {
  const url = new URL(value);
  const localhost = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (url.protocol !== "ws:" || !localhost.has(url.hostname) || url.pathname !== "/v3/sync") {
    throw new Error("real-browser sync proof only connects to an explicit ws://localhost/v3/sync URL");
  }
}

async function startFixture(databaseUrl) {
  const child = spawn("mix", ["run", "--no-start", "test/support/browser/real_browser_fixture.exs"], {
    cwd: syncDirectory,
    env: { ...process.env, MIX_ENV: "test", CHALK_SYNC_TEST_DATABASE_URL: databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = readFixture(child);

  return {
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.stdin.end("\n");
      await waitForExit(child, 10_000);
    },
  };
}

function readFixture(child) {
  return new Promise((resolveFixture, rejectFixture) => {
    let output = "";
    let settled = false;
    let timeout;
    const settle = (callback) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const resolveReady = settle(resolveFixture);
    const rejectReady = settle(rejectFixture);

    timeout = setTimeout(() => rejectReady(new Error("timed out waiting for the local sync browser fixture")), fixtureTimeoutMs);
    child.once("error", (error) => rejectReady(error));
    child.once("exit", (code) => rejectReady(new Error(`local sync browser fixture exited before readiness (code ${code ?? "signal"})`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith(fixturePrefix)) {
          continue;
        }
        try {
          const fixture = JSON.parse(line.slice(fixturePrefix.length));
          if (typeof fixture.url !== "string" || typeof fixture.token !== "string") {
            throw new TypeError("fixture did not provide a WebSocket URL and token");
          }
          resolveReady(fixture);
        } catch (error) {
          rejectReady(error);
        }
      }
    });
    child.stderr.resume();
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, "exit");
  const timedOut = new Promise((resolveTimeout) => {
    setTimeout(resolveTimeout, timeoutMs);
  });

  if (await Promise.race([exited.then(() => true), timedOut.then(() => false)])) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function buildBrowserProof() {
  const directory = await mkdtemp(join(tmpdir(), "chalk-sync-browser-proof-"));

  try {
    const { build } = await import("esbuild");
    await build({
      bundle: true,
      entryPoints: [join(distDirectory, "index.js")],
      format: "esm",
      logLevel: "silent",
      outfile: join(directory, "client.js"),
      platform: "browser",
    });
    return directory;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function startBrowserServer(config, browserBundlePath) {
  await stat(browserBundlePath);

  const server = createServer(async (request, response) => {
    try {
      await serveBrowserRequest(request, response, config, browserBundlePath);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("browser proof asset unavailable");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("local browser proof server did not expose a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose()))),
  };
}

async function serveBrowserRequest(request, response, config, browserBundlePath) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method !== "GET") {
    response.writeHead(405, { "cache-control": "no-store" });
    response.end();
    return;
  }

  if (url.pathname === "/") {
    respond(response, 200, "text/html; charset=utf-8", browserPage());
    return;
  }
  if (url.pathname === "/config.json") {
    respond(response, 200, "application/json; charset=utf-8", JSON.stringify(config));
    return;
  }
  if (url.pathname === "/client/browser-proof.js") {
    await respondFile(response, browserBundlePath);
    return;
  }

  response.writeHead(404, { "cache-control": "no-store" });
  response.end();
}

function browserPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
  </head>
  <body>
    <script type="module">
      import { createV3SyncClient, IndexedDbV3PendingTargetStore } from "/client/browser-proof.js";

      const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const waitFor = async (predicate, description) => {
        const deadline = Date.now() + ${browserTimeoutMs};
        while (Date.now() < deadline) {
          const value = await predicate();
          if (value) return value;
          await sleep(25);
        }
        throw new Error(description);
      };

      try {
        const config = await fetch("/config.json", { cache: "no-store" }).then((response) => response.json());
        const persistenceScope = "real-browser-" + crypto.randomUUID();
        const pendingStore = new IndexedDbV3PendingTargetStore({ scope: persistenceScope });
        const client = createV3SyncClient({
          url: config.url,
          token: async () => config.token,
          pendingStore,
        });

        await client.start();
        await waitFor(() => {
          const snapshot = client.getSnapshot();
          return snapshot.connection.phase === "live" && snapshot.control && snapshot.media && snapshot.presence &&
            snapshot.presence.items.some((item) => item.participantSessionId === snapshot.participantSessionId);
        }, "client did not reach live after control, media, and presence recovery");

        const commandResult = client.setHandRaised(true);
        const persisted = await waitFor(async () => {
          const targets = await pendingStore.load();
          return targets.length === 1 && targets[0].command.name === "set_hand_raised" &&
            targets[0].command.payload.raised === true && targets[0].bytes > 0 ? targets[0] : null;
        }, "client did not persist the v3 hand-raised target");
        await commandResult;
        const snapshot = await waitFor(() => {
          const next = client.getSnapshot();
          const participant = next.control?.participants.find((item) => item.participantSessionId === next.participantSessionId);
          return next.pendingCommandCount === 0 && next.control?.revision === 2 && participant?.handRaised ? next : null;
        }, "client did not converge on the committed control event");
        if ((await pendingStore.load()).length !== 0) throw new Error("client did not clear the persisted v3 target");

        client.stop();
        window.__chalkSyncProof = { status: "passed", revision: snapshot.control.revision, commandId: persisted.commandId };
      } catch (error) {
        window.__chalkSyncProof = { status: "failed", message: error instanceof Error ? error.message : "browser harness failed" };
      }
    </script>
  </body>
</html>`;
}

async function respondFile(response, path) {
  const content = await readFile(path);
  respond(response, 200, contentType(path), content);
}

function respond(response, status, contentType, content) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(content);
}

function contentType(path) {
  return extname(path) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
}
