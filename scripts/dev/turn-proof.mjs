#!/usr/bin/env node
// Two browsers join one real Space against the real Cloudflare SFU with ICE forced through
// one TURN transport, then check that each side receives the other's audio and video and
// that getStats selected a relay candidate pair on that transport.
//
//   node scripts/dev/turn-proof.mjs <ready-runtime-manifest.json> [relay-udp|relay-tcp|relay-tls|default] [report.json]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createMediaSmokeInitScript } from "./media-smoke-page.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = createRequire(join(root, "sdks/typescript/client/package.json"))("playwright");

const [manifestPath, mode = "default", reportPath] = process.argv.slice(2);
if (!manifestPath) throw new Error("Usage: node scripts/dev/turn-proof.mjs <ready-runtime-manifest.json> [relay-udp|relay-tcp|relay-tls|default] [report.json]");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.state !== "ready") throw new Error(`runtime is ${manifest.state}, not ready`);
const holdMs = Number(process.env.TURN_PROOF_HOLD_MS ?? 0);

// With TURN_PROOF_TTL_S, the browsers use a short-lived credential minted from the real TURN endpoint
// (CHALK_CLOUDFLARE_TURN_KEY_ID and CHALK_CLOUDFLARE_TURN_API_TOKEN) instead of the one the API handed out.
const ttlSeconds = Number(process.env.TURN_PROOF_TTL_S ?? 0);
const shortCredential = ttlSeconds > 0 ? await mintShortCredential(ttlSeconds) : undefined;

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const report = { mode, startedAt: new Date().toISOString() };
const logs = [];
const sides = [];
try {
  const primary = await join_(`${manifest.webURL}${manifest.webJoinPath}?name=Primary`);
  const guest = await join_(`${primary.page.url()}?name=Guest`);
  for (const side of [primary, guest]) {
    await side.page.mouse.move(600, 400);
    await side.page.getByRole("button", { name: "Unmute microphone" }).click();
    await side.page.getByRole("button", { name: "Mute microphone" }).waitFor({ timeout: 30_000 });
    await side.page.mouse.move(640, 420);
    await side.page.getByRole("button", { name: "Turn on camera" }).click();
    await side.page.getByRole("button", { name: "Turn off camera" }).waitFor({ timeout: 30_000 });
  }
  await Promise.all([primary, guest].map((side) => untilRemoteMedia(side.page)));
  if (shortCredential) report.freshCredentialProbe = await primary.page.evaluate((server) => window.__probeRelay(server), shortCredential.server);
  const before = await Promise.all([primary, guest].map(sample));
  await primary.page.waitForTimeout(5000);
  const after = await Promise.all([primary, guest].map(sample));
  report.received = [primary, guest].map((_, index) => delta(before[index], after[index]));
  report.selectedCandidates = await Promise.all([primary, guest].map((side) => side.page.evaluate(() => window.__chalkMediaSmoke.selectedCandidates())));
  await guest.page.screenshot({ path: reportPath ? reportPath.replace(/\.json$/, ".guest.png") : "/tmp/turn-proof.guest.png" });
  if (holdMs > 0) {
    await primary.page.waitForTimeout(holdMs);
    const late = await Promise.all([primary, guest].map(sample));
    report.receivedAfterHold = { holdMs, deltas: [primary, guest].map((_, index) => delta(after[index], late[index])) };
    report.selectedCandidatesAfterHold = await Promise.all([primary, guest].map((side) => side.page.evaluate(() => window.__chalkMediaSmoke.selectedCandidates())));
  }
  if (shortCredential) {
    const waitMs = shortCredential.expiresAtMs - Date.now() + 5000;
    if (waitMs > 0) await primary.page.waitForTimeout(waitMs);
    report.expiredCredentialProbe = await primary.page.evaluate((server) => window.__probeRelay(server), shortCredential.server);
  }
  report.result = verdict(report);
} catch (error) {
  report.result = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  report.browserLogs = logs.slice(-40);
  report.tracks = await Promise.all(sides.map((side) => side.page.evaluate(() => window.__chalkMediaSmoke.tracks()).catch(() => undefined)));
  for (const [index, side] of sides.entries()) await side.page.screenshot({ path: `/tmp/sfu-turn-ev/failure-${index}.png` }).catch(() => undefined);
} finally {
  await browser.close();
}
report.finishedAt = new Date().toISOString();
const text = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, text);
}
process.stdout.write(text);
process.exitCode = report.result === "passed" ? 0 : 1;

async function join_(url) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  if (shortCredential) await context.addInitScript({ content: overrideCredentialScript(shortCredential) });
  await context.addInitScript({ content: createMediaSmokeInitScript({ iceProof: mode }) });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (process.env.TURN_PROOF_DEBUG || ["error", "warning"].includes(message.type())) logs.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Leave call" }).waitFor({ timeout: 60_000 });
  const side = { page };
  sides.push(side);
  return side;
}

async function untilRemoteMedia(page) {
  await page.waitForFunction(
    () => {
      const remote = window.__chalkMediaSmoke.tracks().remote;
      return ["audio", "video"].every((kind) => remote.some((track) => track.kind === kind && track.readyState === "live"));
    },
    undefined,
    { timeout: Number(process.env.TURN_PROOF_MEDIA_TIMEOUT_MS ?? 90_000) },
  );
}

function sample(side) {
  return side.page.evaluate(() => window.__chalkMediaSmoke.stats());
}

function delta(before, after) {
  const total = (rows, type, kind, field) => rows.filter((row) => row.type === type && row.kind === kind).reduce((sum, row) => sum + row[field], 0);
  return Object.fromEntries(
    ["audio", "video"].map((kind) => [kind, { receivedBytes: total(after, "inbound-rtp", kind, "bytesReceived") - total(before, "inbound-rtp", kind, "bytesReceived"), receivedPackets: total(after, "inbound-rtp", kind, "packetsReceived") - total(before, "inbound-rtp", kind, "packetsReceived") }]),
  );
}

function receivesMedia(deltas) {
  return deltas.every((side) => side.audio.receivedPackets > 0 && side.video.receivedPackets > 0);
}

function verdict(result) {
  if (!receivesMedia(result.received)) return "failed";
  if (result.receivedAfterHold && !receivesMedia(result.receivedAfterHold.deltas)) return "failed";
  if (mode === "default") return "passed";
  const protocol = mode.replace("relay-", "");
  const relayed = result.selectedCandidates.every((connections) => connections.some((pair) => pair.localCandidateType === "relay" && pair.localRelayProtocol === protocol));
  return relayed ? "passed" : "failed";
}

async function mintShortCredential(ttl) {
  const keyId = process.env.CHALK_CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CHALK_CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) throw new Error("TURN_PROOF_TTL_S needs CHALK_CLOUDFLARE_TURN_KEY_ID and CHALK_CLOUDFLARE_TURN_API_TOKEN");
  const mintedAtMs = Date.now();
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl }),
  });
  if (!response.ok) throw new Error(`short TURN credential request returned status ${response.status}`);
  const server = (await response.json()).iceServers.find((entry) => entry.username);
  return { server: { urls: server.urls.filter((url) => url.startsWith("turn:") && url.includes("transport=udp")).slice(0, 1), username: server.username, credential: server.credential }, expiresAtMs: mintedAtMs + ttl * 1000 };
}

function overrideCredentialScript({ server }) {
  return String.raw`(() => {
    const server = ${JSON.stringify(server)};
    const Native = window.RTCPeerConnection;
    window.__NativeRTCPeerConnection = Native;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, args) {
        const config = args[0] ?? {};
        const iceServers = (config.iceServers ?? []).map((entry) => (entry.username ? { ...entry, username: server.username, credential: server.credential } : entry));
        return Reflect.construct(target, [{ ...config, iceServers }, ...args.slice(1)]);
      },
    });
    window.__probeRelay = (probeServer) =>
      new Promise((resolve) => {
        const peer = new Native({ iceServers: [probeServer], iceTransportPolicy: "relay" });
        const result = { relayCandidates: 0, errors: [] };
        peer.createDataChannel("probe");
        peer.onicecandidate = (event) => { if (event.candidate?.type === "relay") result.relayCandidates += 1; };
        peer.onicecandidateerror = (event) => result.errors.push({ errorCode: event.errorCode, errorText: event.errorText });
        void peer.createOffer().then((offer) => peer.setLocalDescription(offer));
        setTimeout(() => { peer.close(); resolve(result); }, 8000);
      });
  })();`;
}
