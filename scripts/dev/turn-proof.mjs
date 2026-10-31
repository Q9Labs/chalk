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
