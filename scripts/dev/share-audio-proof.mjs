// Run on testbox with a dedicated development SFU application, never production.
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
const output = resolve("artifacts/share-audio");
await mkdir(output, { recursive: true });
// The caller supplies this private file over SSH stdin, outside the source snapshot.
const credentials = JSON.parse(await readFile("/root/chalk-share-audio-development.json", "utf8"));
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
const runtime = createChalkSupervisor(config, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });
let server;
let chalk;
let episode;
const browsers = [];
const pages = [];
const report = { stack: "local API + Sync, dedicated development Cloudflare SFU", assertions: [] };
const browserBundle = await build({
  stdin: {
    contents: `import { createSpaceClientForPlatform } from './sdks/typescript/client/src/effect.ts'; window.joinProof = async (space, baseUrl, syncUrl, name) => { window.client = createSpaceClientForPlatform({space, baseUrl, getAccess: () => window.proofAccess()}, {syncUrl}); await window.client.join({displayName:name, microphone:true, camera:false}); };`,
    resolveDir: root,
    sourcefile: "share-audio-proof.ts",
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
    const admission = await chalk.participants.admit(space.id, episode.id, { name: `Share audio ${index}`, role: "owner" });
    let grant = admission.access;
    let first = true;
    let accessQueue = Promise.resolve();
    // Chrome's fake-media UI substitutes "Fake audio" for display capture.
    // Fake only microphones; use the real tab picker and getDisplayMedia.
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      ignoreDefaultArgs: ["--mute-audio"],
      args: ["--disable-audio-output", "--autoplay-policy=no-user-gesture-required", "--auto-select-tab-capture-source-by-title=Chalk share audio tone", "--enable-usermedia-screen-capturing"],
    });
    browsers.push(browser);
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript(() => {
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
    await page.exposeFunction("proofAccess", () => {
      const next = accessQueue.then(async () => {
        if (first) {
          first = false;
          return grant;
        }
        grant = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant));
        return grant;
      });
      accessQueue = next.catch(() => undefined);
      return next;
    });
    await page.goto(config.urls.web);
    await page.addScriptTag({ content: browserBundle.outputFiles[0].text });
    try {
      await page.evaluate(({ slug, api, sync, name }) => window.joinProof(slug, api, sync, name), { slug: space.slug, api: config.urls.api, sync: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: `Share audio ${index}` });
    } finally {
      await writeFile(`${output}/network-${index}.json`, JSON.stringify(network, null, 2));
    }
  }
  const [sharer, listener] = pages;
  for (const page of pages) await page.waitForFunction(() => client.getSnapshot().connection.status === "live" && client.getSnapshot().media.local.microphone.state === "enabled");
  report.stage = "capture tab audio";
  const tone = await browsers[0].contexts()[0].newPage();
  await tone.goto(`${config.urls.web}/tone`);
  await tone.locator("#tone").click();
  // A digital source must actually oscillate before capture: no silent-fixture pass.
  assert.equal(await tone.evaluate(() => ctx.state), "running");
  await sharer.bringToFront();
  await sharer.evaluate(async () => {
    window.microphoneBefore = client.getSnapshot().media.local.microphone.track;
    await client.media.setScreenShareEnabled(true, { surface: "browser", audio: true });
  });
  report.stage = "receive tab audio";
  await listener.waitForFunction(() => client.getSnapshot().media.remote.some((track) => track.source === "screen_audio" && track.track.readyState === "live"), undefined, { timeout: 60000 });
  assert.equal(await sharer.evaluate(() => client.getSnapshot().media.screenShare.hasAudio), true);
  await listener.waitForFunction(() => client.getSnapshot().participants.roster.some((participant) => participant.media.screenShareHasAudio), undefined, { timeout: 30000 });
  report.stage = "analyse received tone";
  const detected = await listener.evaluate(async () => {
    const remote = client.getSnapshot().media.remote.find((track) => track.source === "screen_audio");
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([remote.track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    source.connect(analyser);
    const audio = new Audio();
    audio.srcObject = new MediaStream([remote.track]);
    await audio.play();
    await context.resume();
    try {
      const bins = new Float32Array(analyser.frequencyBinCount);
      let lastPeak;
      for (let attempt = 0; attempt < 100; attempt++) {
        analyser.getFloatFrequencyData(bins);
        let peak = 0;
        for (let index = 1; index < bins.length; index++) if (bins[index] > bins[peak]) peak = index;
        const frequency = (peak * context.sampleRate) / analyser.fftSize;
        lastPeak = { frequency, decibels: Number.isFinite(bins[peak]) ? bins[peak] : null, enabled: remote.track.enabled, muted: remote.track.muted, settings: remote.track.getSettings() };
        if (Math.abs(frequency - 1733) < 15 && bins[peak] > -50) return { detected: true, ...lastPeak };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { detected: false, ...lastPeak };
    } finally {
      audio.pause();
      audio.srcObject = null;
      source.disconnect();
      await context.close();
    }
  });
  report.tone = detected;
  report.capture = await sharer.evaluate(() => ({ capture: client.getSnapshot().media.screenShare.capture, hasAudio: client.getSnapshot().media.screenShare.hasAudio, microphoneEnabled: client.getSnapshot().media.local.microphone.track.enabled }));
  assert.equal(detected.detected, true, "received audio must contain the 1733 Hz tone");
  report.assertions.push("captured real tab tone", "receiver played and analysed the tone", "local and remote hasAudio true");
  assert.equal(await sharer.evaluate(() => client.getSnapshot().media.local.microphone.track === window.microphoneBefore), true);
  report.stage = "stop share and retain microphone";
  await sharer.evaluate(() => client.media.setScreenShareEnabled(false));
  await listener.waitForFunction(() => !client.getSnapshot().media.remote.some((track) => track.source === "screen_audio"), undefined, { timeout: 30000 });
  assert.equal(await sharer.evaluate(() => client.getSnapshot().media.local.microphone.track === window.microphoneBefore && window.microphoneBefore.readyState === "live" && window.microphoneBefore.enabled), true);
  report.assertions.push("audio released on share stop", "microphone identity retained and live");
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  throw error;
} finally {
  for (const page of pages)
    await page
      .evaluate(async () => {
        await window.client?.leave();
        window.client?.dispose();
      })
      .catch(() => undefined);
  for (const browser of browsers) await browser.close();
  if (episode && chalk) await chalk.episodes.end(space.id, episode.id).catch(() => undefined);
  if (server) await new Promise((resolve) => server.close(resolve));
  await runtime.stop();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
