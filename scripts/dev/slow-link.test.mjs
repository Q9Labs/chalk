// Run on Instabox with a dedicated development SFU application, never production.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor } from "./chalk.mjs";

const requireClient = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
const { chromium } = requireClient("playwright");
const { build } = requireClient("esbuild");
const root = process.cwd();
const output = resolve("artifacts/slow-link");
await mkdir(output, { recursive: true });
// The caller supplies this private file over SSH stdin, outside the source snapshot.
const credentials = JSON.parse(await readFile(process.env.CHALK_DEVELOPMENT_CREDENTIALS ?? "/root/chalk-development.json", "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
let systemToken;
let tenant;
let space;
const config = resolveDevConfig({ root, env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "300000", CHALK_DEV_WEB_PORT: "4870" }, requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"], secretResolver: async () => credentials });
const services = [
  { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${root}/apps/api`, readiness: { url: `${config.urls.api}/readyz` } },
  { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${root}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` } },
];
const localFetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(url.hostname, "127.0.0.1");
  systemToken ??= new Headers(init?.headers).get("Authorization")?.slice(7);
  const response = await fetch(input, init);
  if (response.ok) {
    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    if (url.pathname === "/v1/tenants") tenant = init?.method === "POST" ? body : body.tenants?.find((entry) => entry.name.startsWith("Chalk local dev "));
    if (/\/spaces$/u.test(url.pathname)) space = init?.method === "POST" ? body : body.spaces?.find((entry) => entry.slug.startsWith("chalk-local-"));
  }
  return response;
};
const runtime = createChalkSupervisor({ ...config, webJoinPath: "/" }, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });
let server;
let chalk;
let episode;
const browsers = [];
const networkSessions = [];
const pages = [];
const report = { stack: "local API + Sync, dedicated development Cloudflare SFU", assertions: [] };
const browserBundle = await build({
  stdin: {
    contents: `import { createSpaceClientForPlatform } from './sdks/typescript/client/src/effect.ts'; window.joinProof = async (space, baseUrl, syncUrl, name) => { window.client = createSpaceClientForPlatform({space, baseUrl, getAccess: context => window.proofAccess(context)}, {syncUrl}); window.states = []; window.client.subscribe(() => { const connection = client.getSnapshot().connection; if (JSON.stringify(connection) !== JSON.stringify(window.states.at(-1)?.connection)) { const event = {at:Date.now(),connection}; window.states.push(event); console.log(JSON.stringify(event)); } }); await window.client.join({displayName:name, microphone:true, camera:false}); };`,
    resolveDir: root,
    sourcefile: "slow-link-proof.ts",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
});
await build({ entryPoints: ["sdks/typescript/client/src/server/index.ts"], bundle: true, outfile: `${output}/server.mjs`, platform: "node", format: "esm" });
const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(`${output}/server.mjs`).href);
try {
  report.stage = "start local stack";
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  assert.ok(tenant && space && systemToken, "bootstrap must create an isolated local fixture");
  chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: tenant.id, apiKey: systemToken });
  episode = await chalk.episodes.create(space.id, {});
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<html><title>${request.url === "/tone" ? "Chalk share audio tone" : "Chalk share audio listener"}</title><body><button id="tone">Play tone</button><script>document.querySelector('#tone').onclick = async () => { window.ctx = new AudioContext(); const oscillator = ctx.createOscillator(); oscillator.frequency.value = 1733; oscillator.connect(ctx.destination); oscillator.start(); await ctx.resume(); };</script></body></html>`,
    );
  });
  server.listen(config.ports.web, "127.0.0.1");
  await once(server, "listening");
  report.stage = "join two development participants";
  for (let index = 0; index < 2; index++) {
    let admission = await chalk.participants.admit(space.id, episode.id, { name: `Slow link ${index}`, role: "owner" });
    let grant = admission.access;
    let first = true;
    let accessQueue = Promise.resolve();
    const browser =
      browsers[0] ??
      (await chromium.launch({
        channel: "chromium",
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
      }));
    if (!browsers.includes(browser)) browsers.push(browser);
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript(() => {
      window.peers = [];
      const NativePeer = RTCPeerConnection;
      globalThis.RTCPeerConnection = class extends NativePeer {
        constructor(...args) {
          super(...args);
          window.peers.push(this);
        }
      };
      const NativeSocket = WebSocket;
      globalThis.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener("close", (event) => console.log(JSON.stringify({ event: "wire_close", at: Date.now(), code: event.code, reason: event.reason })));
        }
        close(code, reason) {
          console.log(JSON.stringify({ event: "client_close", at: Date.now(), code, reason }));
          super.close(code, reason);
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 439;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        return destination.stream;
      };
    });
    const page = await context.newPage();
    pages.push(page);
    const network = [];
    page.on("console", (message) => {
      if (message.type() === "log") console.log(JSON.stringify({ event: "client", index, message: message.text() }));
    });
    page.on("requestfailed", (request) => network.push({ type: "request-failed", path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on("websocket", (socket) => {
      network.push({ type: "websocket-open", path: new URL(socket.url()).pathname });
      socket.on("socketerror", (error) => network.push({ type: "websocket-error", error }));
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          network.push({ type: "websocket-frame", frameType: frame.type, code: frame.code, status: frame.status });
        } catch {
          network.push({ type: "websocket-frame", bytes: payload.length });
        }
      });
    });
    await page.exposeFunction("proofAccess", (request) => {
      const next = accessQueue.then(async () => {
        if (first) {
          first = false;
          return grant;
        }
        if (request.reason === "join") {
          admission = await chalk.participants.admit(space.id, episode.id, { name: `Slow link ${index}`, role: "owner" });
          grant = admission.access;
        } else {
          grant = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant), request);
        }
        return grant;
      });
      accessQueue = next.catch(() => undefined);
      return next;
    });
    await page.goto(config.urls.web);
    await page.addScriptTag({ content: browserBundle.outputFiles[0].text });
    try {
      await page.evaluate(({ slug, api, sync, name }) => window.joinProof(slug, api, sync, name), { slug: space.slug, api: config.urls.api, sync: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: `Slow link ${index}` });
    } finally {
      await writeFile(`${output}/network-${index}.json`, JSON.stringify(network, null, 2));
    }
  }
  const [sharer, listener] = pages;
  for (const page of pages) await page.waitForFunction(() => client.getSnapshot().connection.status === "live" && client.getSnapshot().media.local.microphone.state === "enabled");

  for (const page of pages) {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    networkSessions.push(session);
  }
  const setLink = (conditions) =>
    Promise.all(
      networkSessions.map((session) =>
        session.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
          packetLoss: 0,
          ...conditions,
        }),
      ),
    );
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sample = async (label) => {
    const snapshots = await Promise.all(
      pages.map((page) =>
        page.evaluate(async () => {
          const rtp = [];
          for (const peer of window.peers)
            for (const stat of (await peer.getStats()).values()) {
              if (stat.type === "inbound-rtp" || stat.type === "outbound-rtp") rtp.push({ type: stat.type, bytes: stat.bytesReceived ?? stat.bytesSent, packets: stat.packetsReceived ?? stat.packetsSent });
            }
          return { connection: client.getSnapshot().connection, states: window.states, rtp };
        }),
      ),
    );
    console.log(JSON.stringify({ event: "sample", label, at: Date.now(), snapshots }));
    report.assertions.push({ label, snapshots });
    return snapshots;
  };
  const proveMediaFlow = async (label) => {
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(
          async () => {
            for (const peer of window.peers)
              for (const stat of (await peer.getStats()).values()) {
                if (stat.type === "inbound-rtp" && stat.bytesReceived > 0) return true;
              }
            return false;
          },
          undefined,
          { timeout: 30000 },
        ),
      ),
    );
    const before = await sample(`${label}: media start`);
    await wait(3000);
    const after = await sample(`${label}: media end`);
    for (let index = 0; index < pages.length; index++)
      for (const type of ["inbound-rtp", "outbound-rtp"]) {
        const bytes = (snapshot) => snapshot.rtp.filter((stat) => stat.type === type).reduce((total, stat) => total + stat.bytes, 0);
        assert.ok(bytes(after[index]) > bytes(before[index]), `${label}: participant ${index} ${type} must keep flowing`);
      }
  };
  await proveMediaFlow("baseline");
  report.stage = "slow working link";
  await setLink({ latency: 2400, downloadThroughput: 32000, uploadThroughput: 32000, packetLoss: 2 });
  await wait(45000);
  await sample("45s slow link");
  await proveMediaFlow("slow working link");
  await setLink({});
  await wait(10000);
  for (const seconds of [5, 15, 30]) {
    report.stage = `outage ${seconds}s`;
    console.log(JSON.stringify({ event: "outage_start", seconds, at: Date.now() }));
    await setLink({ offline: true, packetLoss: 100 });
    await Promise.all(pages.map((page) => page.context().setOffline(true)));
    await wait(seconds * 1000);
    await setLink({});
    await Promise.all(pages.map((page) => page.context().setOffline(false)));
    console.log(JSON.stringify({ event: "outage_end", seconds, at: Date.now() }));
    await wait(25000);
    await Promise.all(pages.map((page) => page.waitForFunction(() => client.getSnapshot().connection.status !== "reconnecting", undefined, { timeout: 40000 }).catch((error) => console.log(JSON.stringify({ event: "recovery_wait", message: error.message })))));
    const snapshots = await sample(`after ${seconds}s outage`);
    if (snapshots.some((s) => s.connection.status !== "live")) {
      console.log(JSON.stringify({ event: "try_again", at: Date.now() }));
      await Promise.all(pages.map((page) => page.evaluate(() => client.join({ displayName: "Slow link retry", microphone: true, camera: false })).catch((error) => console.log(JSON.stringify({ event: "retry_error", message: error.message })))));
      await wait(10000);
      await sample(`retry after ${seconds}s outage`);
    }
    await proveMediaFlow(`after ${seconds}s outage`);
  }
  const final = await sample("final");
  const failures = final.flatMap((s) => s.states.filter((state) => state.connection.status === "failed"));
  report.failures = failures;
  report.stage = "complete";
  report.result = failures.length === 0 && final.every((s) => s.connection.status === "live" && !s.connection.lastError) ? "passed" : "failed";
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  assert.equal(report.result, "passed");
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  for (const session of networkSessions) await session.detach();
  for (const browser of browsers) await browser.close();
  if (episode && chalk) await chalk.episodes.end(space.id, episode.id).catch((error) => console.error(error.message));
  if (server) await new Promise((resolve) => server.close(resolve));
  await runtime.stop();
}
