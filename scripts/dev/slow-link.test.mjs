// Run on an isolated Instabox against local development or nightly, never production.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
const fixtureMarker = createHash("sha256").update(root).digest("hex").slice(0, 12);
const output = resolve(process.env.CHALK_SLOW_LINK_OUTPUT ?? "artifacts/slow-link");
const outageSeconds = process.env.CHALK_SLOW_LINK_OUTAGES?.split(",").map(Number) ?? [5, 15, 30];
assert.ok(outageSeconds.length > 0 && outageSeconds.every((seconds) => [5, 15, 30].includes(seconds)), "outages must be selected from 5,15,30 seconds");
await mkdir(output, { recursive: true });
// The caller supplies this private file over SSH stdin, outside the source snapshot.
const nightly = process.env.CHALK_SLOW_LINK_TARGET === "nightly";
assert.ok(!process.env.CHALK_SLOW_LINK_TARGET || nightly, "only the explicit nightly remote target is supported");
const credentials = JSON.parse(await readFile(process.env.CHALK_SLOW_LINK_CREDENTIALS ?? process.env.CHALK_DEVELOPMENT_CREDENTIALS ?? "/root/chalk-development.json", "utf8"));
assert.equal(credentials.environment, nightly ? "nightly" : "development");
if (nightly) {
  for (const [field, protocol, hostname] of [
    ["api_url", "https:", "nightly-api.chalkmeet.com"],
    ["sync_url", "wss:", "nightly-sync.chalkmeet.com"],
  ]) {
    const url = new URL(credentials[field]);
    assert.equal(url.protocol, protocol);
    assert.equal(url.hostname, hostname);
    assert.ok(!url.username && !url.password && !url.search && !url.hash);
  }
  const origin = new URL(credentials.proof_origin);
  assert.equal(origin.protocol, "http:");
  assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(origin.port && origin.pathname === "/" && !origin.username && !origin.password && !origin.search && !origin.hash);
  assert.ok(credentials.api_key?.startsWith("chalk_sk_") && credentials.tenant_id);
} else {
  assert.equal(credentials.source, "chalk-local-dev");
  assert.ok(credentials.appId && credentials.appSecret);
}
let systemToken;
let tenant;
let space;
const config = nightly
  ? { urls: { api: credentials.api_url, web: credentials.proof_origin }, ports: { web: Number(new URL(credentials.proof_origin).port) } }
  : resolveDevConfig({ root, fresh: true, env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "300000", CHALK_DEV_WEB_PORT: "4870" }, requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"], secretResolver: async () => credentials });
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
    if (url.pathname === "/v1/tenants") tenant = init?.method === "POST" ? body : body.tenants?.find((entry) => entry.name === `Chalk local dev ${fixtureMarker}`);
    if (/\/spaces$/u.test(url.pathname)) space = init?.method === "POST" ? body : body.spaces?.find((entry) => entry.slug === `chalk-local-${fixtureMarker}`);
  }
  return response;
};
const runtime = nightly ? undefined : createChalkSupervisor({ ...config, webJoinPath: "/" }, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });
let server;
let chalk;
let episode;
const browsers = [];
const networkSessions = [];
const packetChain = `CHALK_SLOW_${process.pid}`;
const packetFilters = [];
const dropChain = `${packetChain}_DROP`;
let lossPulse;
let lossPulseEnd;
const chains = [];
const firewalls = ["iptables", "ip6tables"];
const firewall = (program, ...args) => execFileSync("sudo", [program, ...args], { stdio: "pipe" });
const tcpChain = `${packetChain}_TCP`;
const pages = [];
const report = { stack: nightly ? "nightly API + Sync + SFU" : "local API + Sync, dedicated development Cloudflare SFU", sdkRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), assertions: [], outages: [] };
const browserBundle = await build({
  stdin: {
    contents: `import { createSpaceClientForPlatform } from './sdks/typescript/client/src/effect.ts'; window.joinProof = async (space, baseUrl, syncUrl, name) => { window.client = createSpaceClientForPlatform({space, baseUrl, getAccess: context => window.proofAccess(context)}, {syncUrl,onConnectionDiagnostic:diagnostic => console.log(JSON.stringify({event:"diagnostic",at:Date.now(),diagnostic}))}); window.states = []; window.client.subscribe(() => { const connection = client.getSnapshot().connection; if (JSON.stringify(connection) !== JSON.stringify(window.states.at(-1)?.connection)) { const event = {at:Date.now(),connection}; window.states.push(event); console.log(JSON.stringify(event)); } }); await window.client.join({displayName:name, microphone:true, camera:false}); };`,
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
  report.stage = nightly ? "create isolated nightly Space" : "start local stack";
  if (!nightly) {
    await runtime.start();
    assert.equal(runtime.status().state, "ready");
    assert.ok(tenant && space && systemToken, "bootstrap must create an isolated local fixture");
  }
  chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: nightly ? credentials.tenant_id : tenant.id, apiKey: nightly ? credentials.api_key : systemToken });
  if (nightly) {
    const runId = randomUUID();
    space = await chalk.spaces.create({
      name: `Slow link proof ${runId}`,
      slug: `slow-link-${runId}`,
      mediaPlane: "cf_sfu",
      recordingPolicy: "disabled",
      transcriptionPolicy: "disabled",
      defaultEpisodeDurationSeconds: 1800,
      maximumEpisodeDurationSeconds: 1800,
      lingerWindowSeconds: 60,
      admissionPolicy: { mode: "open" },
    });
    report.fixture = { spaceId: space.id };
  }
  episode = await chalk.episodes.create(space.id, {});
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<html><title>${request.url === "/tone" ? "Chalk share audio tone" : "Chalk share audio listener"}</title><body><button id="tone">Play tone</button><script>document.querySelector('#tone').onclick = async () => { window.ctx = new AudioContext(); const oscillator = ctx.createOscillator(); oscillator.frequency.value = 1733; oscillator.connect(ctx.destination); oscillator.start(); await ctx.resume(); };</script></body></html>`,
    );
  });
  server.listen(config.ports.web, "127.0.0.1");
  await once(server, "listening");
  report.stage = "join two synthetic participants";
  const admissions = await Promise.all([0, 1].map((index) => chalk.participants.admit(space.id, episode.id, { name: `Slow link ${index}`, role: "owner" })));
  for (let index = 0; index < 2; index++) {
    let admission = admissions[index];
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
    await context.addInitScript((participantIndex) => {
      window.peers = [];
      window.audioSinks = [];
      window.captureSources = [];
      const NativePeer = RTCPeerConnection;
      globalThis.RTCPeerConnection = class extends NativePeer {
        constructor(...args) {
          super(...args);
          window.peers.push(this);
          this.addEventListener("track", async ({ track }) => {
            if (track.kind !== "audio") return;
            const context = new AudioContext();
            const stream = new MediaStream([track]);
            const audio = document.createElement("audio");
            audio.srcObject = stream;
            audio.autoplay = true;
            document.body.append(audio);
            const source = context.createMediaStreamSource(stream);
            const analyser = context.createAnalyser();
            source.connect(analyser);
            analyser.connect(context.destination);
            window.audioSinks.push({ context, analyser, track, audio });
            await context.resume();
            await audio.play();
          });
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
        oscillator.frequency.value = [439, 733][participantIndex];
        const destination = context.createMediaStreamDestination();
        const analyser = context.createAnalyser();
        oscillator.connect(analyser);
        analyser.connect(destination);
        window.captureSources.push({ context, analyser, track: destination.stream.getAudioTracks()[0] });
        oscillator.start();
        await context.resume();
        return destination.stream;
      };
    }, index);
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
      await page.evaluate(({ slug, api, sync, name }) => window.joinProof(slug, api, sync, name), { slug: space.slug, api: config.urls.api, sync: nightly ? credentials.sync_url : `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: `Slow link ${index}` });
    } finally {
      await writeFile(`${output}/network-${index}.json`, JSON.stringify(network, null, 2));
    }
  }
  for (const page of pages) await page.waitForFunction(() => client.getSnapshot().connection.status === "live" && client.getSnapshot().media.local.microphone.state === "enabled");

  for (const page of pages) {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    networkSessions.push(session);
  }
  for (const program of firewalls) {
    for (const chain of [dropChain, packetChain, tcpChain]) {
      firewall(program, "-N", chain);
      chains.push({ program, chain });
      firewall(program, "-A", chain, "-j", chain === dropChain ? "DROP" : "RETURN");
    }
    for (const [direction, port] of [
      ["OUTPUT", "--dport"],
      ["INPUT", "--sport"],
    ]) {
      for (const args of [
        ["-p", "udp", "!", port, "53", "-j", packetChain],
        ["-p", "tcp", port, "443", "-j", tcpChain],
      ]) {
        firewall(program, "-I", direction, ...args);
        packetFilters.push({ program, direction, args });
      }
    }
  }
  const setPacketLoss = (blocked) => {
    for (const program of firewalls) firewall(program, "-R", packetChain, "1", "-j", blocked ? dropChain : "RETURN");
  };
  const droppedPackets = () =>
    firewalls.reduce((total, program) => {
      const counters = firewall(program, "-L", dropChain, "-v", "-n", "-x").toString();
      return total + Number(counters.match(/^\s*(\d+)\s+\d+\s+DROP/m)?.[1] ?? 0);
    }, 0);
  const setFullOutage = (blocked) => {
    setPacketLoss(blocked);
    for (const program of firewalls) firewall(program, "-R", tcpChain, "1", "-j", blocked ? dropChain : "RETURN");
  };
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
              if (stat.kind === "audio" && (stat.type === "inbound-rtp" || stat.type === "outbound-rtp"))
                rtp.push({
                  id: stat.id,
                  type: stat.type,
                  bytes: stat.bytesReceived ?? stat.bytesSent,
                  packets: stat.packetsReceived ?? stat.packetsSent,
                  energy: stat.totalAudioEnergy ?? 0,
                  samples: stat.totalSamplesReceived ?? 0,
                  concealed: stat.concealedSamples ?? 0,
                  jitterBufferEmittedCount: stat.jitterBufferEmittedCount,
                  jitterBufferDelay: stat.jitterBufferDelay,
                  packetsLost: stat.packetsLost,
                });
            }
          const audioRms = window.audioSinks.map(({ analyser }) => {
            const samples = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(samples);
            return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          });
          const describeAudio = ({ context, track, analyser }) => {
            const samples = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(samples);
            return { contextState: context.state, contextTime: context.currentTime, trackEnabled: track.enabled, trackMuted: track.muted, trackState: track.readyState, rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) };
          };
          return { connection: client.getSnapshot().connection, states: window.states, rtp, audioRms, captureAudio: window.captureSources.map(describeAudio), receivedAudio: window.audioSinks.map(describeAudio) };
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
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = await sample(`${label}: media start`);
      await wait(3000);
      const after = await sample(`${label}: media end`);
      const flowing = pages.every((_page, index) =>
        ["inbound-rtp", "outbound-rtp"].every((type) => {
          const bytes = (snapshot) => snapshot.rtp.filter((stat) => stat.type === type).reduce((total, stat) => total + stat.bytes, 0);
          const sameStreamAdvanced = after[index].rtp.some(
            (stat) => stat.type === type && stat.bytes > (before[index].rtp.find((previous) => previous.id === stat.id)?.bytes ?? 0) && (type !== "inbound-rtp" || stat.energy > (before[index].rtp.find((previous) => previous.id === stat.id)?.energy ?? 0)),
          );
          return bytes(after[index]) > 0 && sameStreamAdvanced;
        }),
      );
      if (flowing && after.every((snapshot) => snapshot.audioRms.some((rms) => rms > 0.005))) return { at: Date.now(), snapshots: after };
      if (after.some((snapshot) => snapshot.connection.status === "failed")) break;
    }
    assert.fail(`${label}: every participant must send and receive fresh RTP within 30 seconds`);
  };
  const recordReceivedAudio = async (seconds) =>
    Promise.all(
      pages.map(async (page, index) => {
        const encoded = await page.evaluate(async () => {
          const sink = window.audioSinks.findLast(({ track, analyser }) => {
            const samples = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(samples);
            return track.readyState === "live" && samples.some((value) => Math.abs(value) > 0.005);
          });
          if (!sink) throw new Error("no audible remote track to record");
          const recorder = new MediaRecorder(new MediaStream([sink.track]), { mimeType: "audio/webm;codecs=opus" });
          const chunks = [];
          recorder.addEventListener("dataavailable", ({ data }) => chunks.push(data));
          const stopped = new Promise((resolve, reject) => {
            recorder.addEventListener("stop", resolve, { once: true });
            recorder.addEventListener("error", reject, { once: true });
          });
          recorder.start();
          await new Promise((resolve) => setTimeout(resolve, 2000));
          recorder.stop();
          await stopped;
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
        });
        const filename = `after-${seconds}s-received-${index}.webm`;
        await writeFile(`${output}/${filename}`, Buffer.from(encoded, "base64"));
        return filename;
      }),
    );
  await proveMediaFlow("baseline");
  report.stage = "slow working link";
  // Burst loss also exercises existing media peers; CDP alone leaves their RTP flowing.
  lossPulse = setInterval(() => {
    setPacketLoss(true);
    lossPulseEnd = setTimeout(() => setPacketLoss(false), 40);
  }, 2000);
  await setLink({ latency: 2400, downloadThroughput: 32000, uploadThroughput: 32000, packetLoss: 2 });
  await wait(45000);
  await sample("45s slow link");
  await proveMediaFlow("slow working link");
  report.packetLossCounters = firewalls.map((program) => firewall(program, "-L", dropChain, "-v", "-n", "-x").toString()).join("\n");
  assert.match(report.packetLossCounters, /^\s*[1-9]\d*\s+\d+\s+DROP/m, "kernel must actually drop media packets");
  clearInterval(lossPulse);
  clearTimeout(lossPulseEnd);
  setPacketLoss(false);
  await setLink({});
  await wait(10000);
  for (const seconds of outageSeconds) {
    report.stage = `outage ${seconds}s`;
    const outage = { seconds, startedAt: Date.now(), droppedPacketsBefore: droppedPackets() };
    report.outages.push(outage);
    console.log(JSON.stringify({ event: "outage_start", seconds, at: outage.startedAt }));
    await Promise.all(pages.map((page) => page.context().setOffline(true)));
    setFullOutage(true);
    outage.kernelBlockedAt = Date.now();
    await setLink({ offline: true, packetLoss: 100 });
    await wait(3000);
    const silenceStart = await sample(`${seconds}s outage: loss window start`);
    await wait(seconds * 1000 - 3000);
    const silenceEnd = await sample(`${seconds}s outage: loss window end`);
    const receivedBytes = (snapshot) => snapshot.rtp.filter((stat) => stat.type === "inbound-rtp").reduce((total, stat) => total + stat.bytes, 0);
    for (let index = 0; index < pages.length; index++) assert.ok(receivedBytes(silenceEnd[index]) <= receivedBytes(silenceStart[index]), `participant ${index} must receive no new media during the outage`);
    outage.droppedPacketsAfter = droppedPackets();
    assert.ok(outage.droppedPacketsAfter > outage.droppedPacketsBefore, "kernel must drop traffic during every full outage");
    const restoredAt = Date.now();
    setFullOutage(false);
    await setLink({});
    await Promise.all(pages.map((page) => page.context().setOffline(false)));
    console.log(JSON.stringify({ event: "outage_end", seconds, at: restoredAt }));
    outage.restoredAt = restoredAt;
    outage.measuredInterruptionMs = restoredAt - outage.startedAt;
    await Promise.all(pages.map((page) => page.waitForFunction(() => client.getSnapshot().connection.status === "live" || client.getSnapshot().connection.status === "failed", undefined, { timeout: 65000 })));
    const snapshots = await sample(`after ${seconds}s outage`);
    outage.terminalStates = snapshots.flatMap((snapshot) => snapshot.states.filter((state) => ["failed", "ended"].includes(state.connection.status)));
    assert.ok(
      snapshots.every((snapshot) => snapshot.connection.status === "live" && !snapshot.connection.lastError),
      "automatic recovery must return every participant to live without an error",
    );
    outage.liveAfterRestoreMs = snapshots.map((snapshot) => snapshot.states.find((state) => state.at >= restoredAt && state.connection.status === "live")?.at - restoredAt);
    assert.ok(outage.liveAfterRestoreMs.every(Number.isFinite), "both participants must have a fresh live transition after restoration");
    const media = await proveMediaFlow(`after ${seconds}s outage`);
    outage.bidirectionalAudioAfterRestoreMs = media.at - restoredAt;
    outage.receivedAudioFiles = await recordReceivedAudio(seconds);
    assert.equal(outage.terminalStates.length, 0, "no terminal state or manual retry is allowed");
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
  report.requestId = error.requestId;
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  clearInterval(lossPulse);
  clearTimeout(lossPulseEnd);
  for (const { program, direction, args } of packetFilters) firewall(program, "-D", direction, ...args);
  for (const { program, chain } of [...chains].reverse()) firewall(program, "-F", chain);
  for (const { program, chain } of [...chains].reverse()) firewall(program, "-X", chain);
  for (const session of networkSessions) await session.detach();
  for (const browser of browsers) await browser.close();
  if (episode && chalk) await chalk.episodes.end(space.id, episode.id).catch((error) => console.error(error.message));
  if (server) await new Promise((resolve) => server.close(resolve));
  if (nightly && space && chalk) await chalk.spaces.archive(space.id);
  await runtime?.stop();
}
