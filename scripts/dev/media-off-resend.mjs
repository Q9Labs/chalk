// Real-call proof for "an off that Sync never accepted is resent". Local API + Sync and a development
// Cloudflare SFU app; never production. Two Chromium browsers share one Space: A publishes a tone, B listens.
//
//   CHALK_DEVELOPMENT_CREDENTIALS=/path/development-sfu.json node scripts/dev/media-off-resend.mjs
//
//   CHALK_OFF_SCENARIO=lost-off  (default) the send of A's mic off is dropped while the link stays up, then A reconnects
//   CHALK_OFF_SCENARIO=toggle    plain off and on with no injected failure
//   CHALK_OFF_SCENARIO=off-on    off, wait CHALK_OFF_GAP_MS (default 2000), on; measures A sender stats and B decoded signal
//   CHALK_OFF_GAPS_MS=500,2000   (off-on) one off/on cycle per gap
//   CHALK_OFF_FAKE_DEVICE=1      use Chromium's fake microphone with a looping tone file instead of the in-page oscillator
//   CHALK_OFF_BLOCK_MEDIA_CLOSE=1 also fail A's SFU track close request (a second fault, harsher than lost-off)
//   CHALK_OFF_SDK_REF=<git ref>  build the browser SDK from this ref (for example origin/master); default is the working tree
//   CHALK_OFF_OUTPUT=<dir>       report directory (default artifacts/media-off-resend)
//
// Pass means exit code 0 and report.json with "passed": true. Each assertion lists what Sync and the SFU showed B.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor } from "./chalk.mjs";

const root = resolve(import.meta.dirname, "../..");
const { build } = createRequire(resolve(root, "tools/sdk-web-consumer-e2e/package.json"))("esbuild");
const { chromium } = createRequire(resolve(root, "sdks/typescript/client/package.json"))("playwright");
const scenario = process.env.CHALK_OFF_SCENARIO || "lost-off";
const blockMediaClose = process.env.CHALK_OFF_BLOCK_MEDIA_CLOSE === "1";
assert.ok(["lost-off", "toggle", "off-on"].includes(scenario), `unknown scenario ${scenario}`);
const sdkRef = process.env.CHALK_OFF_SDK_REF || null;
const output = resolve(root, process.env.CHALK_OFF_OUTPUT || "artifacts/media-off-resend");
await mkdir(output, { recursive: true });
const credentials = JSON.parse(await readFile(process.env.CHALK_DEVELOPMENT_CREDENTIALS || "/root/chalk-development.json", "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);

// The browser SDK comes from a git ref when asked; the server stack always runs from the working tree.
let sdkRoot = resolve(root, "sdks/typescript/client");
if (sdkRef) {
  const extracted = await mkdtemp(resolve(tmpdir(), "media-off-sdk-"));
  const archive = execFileSync("git", ["archive", sdkRef, "sdks/typescript/client"], { cwd: root, maxBuffer: 200 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", extracted], { input: archive });
  sdkRoot = resolve(extracted, "sdks/typescript/client");
}
const sdkRevision = sdkRef ? execFileSync("git", ["rev-parse", sdkRef], { cwd: root, encoding: "utf8" }).trim() : `${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()} (working tree)`;

let systemToken, tenant, space;
const config = resolveDevConfig({ root, env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "600000", CHALK_DEV_WEB_PORT: "4871" }, requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"], secretResolver: async () => credentials });
config.webJoinPath = "/";
config.databaseName = process.env.CHALK_OFF_DB || "chalk_off_resend_proof";
assert.match(config.databaseName, /^[a-z_]+$/u);
const services = [
  { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${root}/apps/api`, readiness: { url: `${config.urls.api}/readyz` } },
  { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${root}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` } },
];
const localFetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(url.hostname, "127.0.0.1");
  systemToken ??= new Headers(init?.headers).get("Authorization")?.slice(7);
  const response = await fetch(input, init);
  if (response.ok && /\/v1\/tenants(?:\/[^/]+\/spaces)?$/u.test(url.pathname)) {
    const body = await response.clone().json();
    if (url.pathname === "/v1/tenants") tenant = init?.method === "POST" ? body : body.tenants?.find((entry) => entry.name.startsWith("Chalk local dev "));
    else space = init?.method === "POST" ? body : body.spaces?.find((entry) => entry.slug.startsWith("chalk-local-"));
  }
  return response;
};
const runtime = createChalkSupervisor(config, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });
const report = { started: new Date().toISOString(), scenario, sdkRevision, serverRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), timeline: [], assertions: [], passed: false };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const t0 = Date.now();
/** A mono 16-bit 48 kHz sine as a WAV buffer. */
function wavTone(frequency, seconds) {
  const rate = 48000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 16000), 44 + i * 2);
  return buffer;
}
const note = (event, detail = {}) => {
  report.timeline.push({ t: Math.round((Date.now() - t0) / 100) / 10, event, ...detail });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event}`, Object.keys(detail).length ? JSON.stringify(detail) : "");
};
const check = (name, ok, detail) => {
  report.assertions.push({ name, ok, detail });
  note(ok ? "PASS" : "FAIL", { name, ...detail });
};
const save = () => writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));

let http;
const browsers = [];
try {
  await build({ entryPoints: [resolve(root, "sdks/typescript/client/src/server/index.ts")], bundle: true, outfile: `${output}/server-client.mjs`, platform: "node", format: "esm" });
  const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(`${output}/server-client.mjs`).href);
  const fakeDevice = process.env.CHALK_OFF_FAKE_DEVICE === "1";
  const instrument = (fakeDevice ? "window.proofNativeAudio = true;\n" : "") + (await readFile(resolve(import.meta.dirname, "media-off-resend-instrument.js"), "utf8"));
  // Chromium's own fake microphone, fed by a looping 440 Hz tone file, so capture is re-acquired like a real device.
  const toneFile = resolve(await mkdtemp(resolve(tmpdir(), "media-off-tone-")), "tone.wav");
  if (fakeDevice) await writeFile(toneFile, wavTone(440, 10));
  const pageBundle = (
    await build({
      entryPoints: [resolve(import.meta.dirname, "media-off-resend-page.js")],
      alias: { "@q9labsai/chalk-client/effect": `${sdkRoot}/src/effect.ts`, "@q9labsai/chalk-client": `${sdkRoot}/src/index.ts` },
      nodePaths: [resolve(root, "node_modules"), resolve(root, "sdks/typescript/client/node_modules")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
    })
  ).outputFiles[0].text;
  note("starting stack");
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  assert.ok(tenant && space && systemToken);
  const chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: tenant.id, apiKey: systemToken });
  http = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<html><body><main id="root"></main><script>${instrument}</script><script>${pageBundle}</script></body></html>`);
  });
  http.listen(config.ports.web, "127.0.0.1");
  await once(http, "listening");

  const fixtureSpace = await chalk.spaces.create({ name: "Media off resend proof", slug: `off-resend-${Date.now()}`, mediaPlane: "cf_sfu", defaultEpisodeDurationSeconds: 3600, maximumEpisodeDurationSeconds: 3600 });
  const episode = await chalk.episodes.create(fixtureSpace.id, {});
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", ...(fakeDevice ? [`--use-file-for-fake-audio-capture=${toneFile}`] : []), "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  browsers.push(browser);
  const people = [];
  for (const [name, role] of [
    ["Proof A", "owner"],
    ["Proof B", "collaborator"],
  ]) {
    const admission = await chalk.participants.admit(fixtureSpace.id, episode.id, { name, role });
    let access = admission.access;
    let first = true;
    let queue = Promise.resolve();
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    const page = await context.newPage();
    page.on("pageerror", (error) => note("pageerror", { who: name, message: error.message }));
    await page.exposeFunction("proofAccess", (request) => {
      const next = queue.then(async () => {
        if (first) first = false;
        else access = await chalk.participants.issueAccess(fixtureSpace.id, episode.id, admission.participant.id, getAccessRefreshState(access), request);
        return access;
      });
      queue = next.catch(() => undefined);
      return next;
    });
    await page.goto(config.urls.web);
    people.push({ name, page });
  }
  const [a, b] = people;
  for (const person of people) person.id = await person.page.evaluate((join) => window.proof.join(join), { space: fixtureSpace.slug, baseUrl: config.urls.api, syncUrl: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: person.name });
  const state = (person) => person.page.evaluate(() => window.proof.state());
  const waitFor = async (what, predicate, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(500);
    }
  };
  /** Receiver energy of B grows only while A's audio really arrives. */
  const bHearsA = async (windowMs = 3000) => {
    const before = await b.page.evaluate(() => window.proof.receivedAudio());
    await sleep(windowMs);
    const after = await b.page.evaluate(() => window.proof.receivedAudio());
    return { hears: after.energy - before.energy > 0.001, energyDelta: Number((after.energy - before.energy).toFixed(4)), packetsDelta: after.packets - before.packets };
  };
  const projectionOfA = async (viewer) => (await state(viewer)).projection[`${a.id}/microphone`];

  await waitFor("A mic enabled for itself", async () => (await state(a)).microphone === "enabled");
  await waitFor("B sees A mic enabled in Sync", async () => (await projectionOfA(b)) === true);
  const start = await bHearsA();
  const bState = await state(b);
  check("baseline: B hears A", start.hears, { ...start, peers: bState.peers, remoteAudioTracks: bState.remoteAudioTracks });
  check("baseline: A shows mic enabled", (await state(a)).microphone === "enabled", { a: (await state(a)).microphone });

  if (scenario === "off-on") {
    // CHALK_OFF_GAPS_MS is a comma list: one off/on cycle per entry, each with that gap between the off and the on.
    const gaps = (process.env.CHALK_OFF_GAPS_MS || process.env.CHALK_OFF_GAP_MS || "2000").split(",").map(Number);
    const sample = async (label) => {
      const senderBefore = await a.page.evaluate(() => window.proof.senderStats());
      const receiver = await b.page.evaluate(() => window.proof.receiverStats(3000));
      const senderAfter = await a.page.evaluate(() => window.proof.senderStats());
      const sender = senderAfter.map((item, index) => ({ ...item, packetsSentDelta: item.packetsSent - (senderBefore[index]?.packetsSent ?? 0), bytesSentDelta: item.bytesSent - (senderBefore[index]?.bytesSent ?? 0) }));
      note(`sample ${label}`, { sender, receiver });
      return { sender, receiver };
    };
    /** Milliseconds until B decodes a real signal from A, or null when none arrives in time. */
    const audibleSince = async (timeoutMs) => {
      const started = Date.now();
      for (;;) {
        const receiver = await b.page.evaluate(() => window.proof.receiverStats(300));
        if (receiver.some((item) => item.rmsPeak > 0.01)) return Date.now() - started;
        if (Date.now() - started > timeoutMs) return null;
        await sleep(500);
      }
    };
    const optional = (promise) =>
      promise.then(
        () => true,
        () => false,
      );
    const baseline = await audibleSince(40000);
    note("baseline: B first audible", { afterMs: baseline });
    check("baseline: B receives a decoded signal", baseline !== null, {});
    const cycles = [];
    for (const [index, gapMs] of gaps.entries()) {
      const offAt = Date.now();
      const off = await a.page.evaluate(() => window.proof.setMicrophone(false));
      await sleep(Math.max(0, gapMs - (Date.now() - offAt)));
      const onAt = Date.now();
      const on = await a.page.evaluate(() => window.proof.setMicrophone(true));
      const aEnabled = await optional(waitFor("A mic enabled again", async () => (await state(a)).microphone === "enabled", 30000));
      const bSeesOn = aEnabled && (await optional(waitFor("B sees A mic on in Sync", async () => (await projectionOfA(b)) === true, 30000)));
      const settledAfterMs = Date.now() - onAt;
      const audibleAfterMs = await audibleSince(45000);
      const mediaFetches = await a.page.evaluate(
        (since) =>
          window.proof
            .fetchLog()
            .filter((entry) => entry.at > since)
            .map(({ path, status }) => `${path}:${status}`),
        onAt,
      );
      const [senderBefore, receiver] = [await a.page.evaluate(() => window.proof.senderStats()), await b.page.evaluate(() => window.proof.receiverStats(3000))];
      const senderAfter = await a.page.evaluate(() => window.proof.senderStats());
      const cycle = { cycle: index + 1, gapMs, off, on, aEnabled, bSeesOn, settledAfterMs, audibleAfterMs, mediaFetches, sender: senderAfter.map((item, i) => ({ ...item, packetsSentDelta: item.packetsSent - (senderBefore[i]?.packetsSent ?? 0) })), receiver };
      cycles.push(cycle);
      note(`cycle ${index + 1} (gap ${gapMs} ms)`, cycle);
      check(`cycle ${index + 1} (gap ${gapMs} ms): UI on, Sync on, and B decodes A within 45 s`, aEnabled && bSeesOn && audibleAfterMs !== null, { aEnabled, bSeesOn, audibleAfterMs, mediaFetches });
      await sleep(1500);
    }
    report.cycles = cycles;
  } else if (scenario === "lost-off") {
    await a.page.evaluate((flag) => {
      window.proof.faults.dropNextMicrophoneOff = true;
      window.proof.faults.failMediaClose = flag;
      window.proofOff = window.proof.setMicrophone(false);
    }, blockMediaClose);
    note("A turned its mic off; the frame to Sync is dropped, the link stays up");
    const observe = async (label) => {
      const [seenByB, seenByA] = [await state(b), await state(a)];
      note(`observe ${label}`, { projectionSeenByB: seenByB.projection[`${a.id}/microphone`], projectionSeenByA: seenByA.projection[`${a.id}/microphone`], aUi: seenByA.microphone, aConnection: seenByA.connection, bHears: (await bHearsA(1500)).hears });
    };
    await observe("2s after the off");
    await sleep(6000);
    await observe("8s after the off, before the failure is reported");
    await waitFor("drop applied", async () => (await a.page.evaluate(() => window.proof.faults.droppedFrames)) === 1, 10000);
    check("A's UI shows off at once", (await state(a)).microphone === "disabled", { a: (await state(a)).microphone });
    const settled = await a.page.evaluate(() => window.proofOff);
    const afterLoss = await state(a);
    check("the off failed while the connection stayed up", !settled.ok && afterLoss.socketOpen && afterLoss.connection === "live", { settled, socketOpen: afterLoss.socketOpen, connection: afterLoss.connection });
    await observe("after the failure, before the reconnect");
    await a.page.evaluate(() => window.proof.dropConnection());
    note("A's Sync connection closed by the page");
    await waitFor("A reconnecting", async () => (await state(a)).connection !== "live", 20000).catch(() => undefined);
    await waitFor(
      "A live again on a new socket",
      async () => {
        const current = await state(a);
        return current.connection === "live" && current.socketOpen && current.sockets > afterLoss.sockets;
      },
      90000,
    );
    note("A reconnected");
    await sleep(Number(process.env.CHALK_OFF_SETTLE_MS || 20000));
  } else {
    const off = await a.page.evaluate(() => window.proof.setMicrophone(false));
    note("A turned its mic off", off);
    await sleep(10000);
  }

  if (scenario !== "off-on") {
    const finalA = await state(a);
    const finalB = await state(b);
    check("A's UI shows off", finalA.microphone === "disabled", { a: finalA.microphone });
    check("Sync projection (as B sees it) shows A's mic off", finalB.projection[`${a.id}/microphone`] !== true, { projection: finalB.projection[`${a.id}/microphone`] });
    check("Sync projection (as A sees it) shows A's mic off", finalA.projection[`${a.id}/microphone`] !== true, { projection: finalA.projection[`${a.id}/microphone`] });
    const silent = await bHearsA(5000);
    check("B no longer receives A's audio", !silent.hears, silent);
  }

  if (scenario === "toggle") {
    await a.page.evaluate(() => {
      window.proofOn = window.proof.setMicrophone(true);
    });
    const earlyUi = (await state(a)).microphone;
    check("the UI waits for Sync before showing on", earlyUi !== "enabled" || (await projectionOfA(a)) === true, { uiBeforeSync: earlyUi });
    // Recorded, not gated: turning the mic on again after an off is unreliable on master too (the SFU sometimes refuses the republish, and B can receive silence), so it is a separate issue.
    const onDone = await waitFor("A mic enabled again", async () => (await state(a)).microphone === "enabled", 30000).then(
      () => true,
      () => false,
    );
    const onSeenByB =
      onDone &&
      (await waitFor("B sees A mic on in Sync", async () => (await projectionOfA(b)) === true, 30000).then(
        () => true,
        () => false,
      ));
    note("after on (observation only)", { aUiEnabled: onDone, bSeesOn: onSeenByB, bHears: onSeenByB ? await bHearsA(4000) : null, aToneGraphs: (await state(a)).toneGraphs });
  }
  report.passed = report.assertions.every((assertion) => assertion.ok);
} catch (error) {
  note("error", { message: error.message });
  report.error = error.message;
} finally {
  report.finished = new Date().toISOString();
  await save();
  await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  http?.close();
  await runtime.stop().catch(() => undefined);
}
console.log(report.passed ? "PASSED" : "FAILED", `${output}/report.json`);
process.exit(report.passed ? 0 : 1);
