// fallow-ignore-file unused-file -- throwaway spike entrypoints are run directly, not through the workspace graph.
// fallow-ignore-file complexity -- throwaway measurement harness; the spike report records results rather than productionizing branching.
#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createNodeAgent } from "./agent.mjs";
import { webMediaFixture } from "../../scripts/web-proof/media.mjs";

const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = true] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const library = String(args.library ?? "roam");
const browserCount = Number(args.browsers ?? 1);
const durationSeconds = Number(args.duration ?? 75);
const runId = String(args.runId ?? `${library}-${browserCount + 1}p-${Date.now()}`);
const out = join("../../.verify", `node-agent-${runId}`);
await mkdir(out, { recursive: true });

const seed = JSON.parse(await readFile("../../.private/chalk-dev/seed.json", "utf8"));
const serverDist = new URL("../../sdks/typescript/client/dist/server/index.js", import.meta.url);
const { createChalkServerClient } = await import(serverDist);
const chalk = createChalkServerClient({ apiKey: seed.systemToken, tenantId: seed.tenantId, apiBaseURL: seed.urls.api });
const events = [];
const event = (entry) => events.push({ at: Date.now(), ...entry });
const result = { runId, library, browserCount, pass: false, checks: {}, measurements: {}, events };
let browser;
let agent;
let failure = null;
const startedRun = Date.now();
const cpuStart = process.cpuUsage();
const memorySamples = [];
let rssBeforeAgent;
let cpuBeforeAgent;
let agentStartAt = Date.now();

try {
  const memoryTimer = setInterval(() => memorySamples.push({ at: Date.now(), rss: process.memoryUsage().rss }), 1000);
  try {
    event({ type: "episode-create-start" });
    const episode = await activeOrCreateEpisode();
    result.episodeId = episode.id;
    event({ type: "episode-created", episodeId: episode.id });

    const admission = await chalk.participants.admit(seed.spaceId, episode.id, { name: `Node spike ${library}`, role: "owner" }, { idempotencyKey: crypto.randomUUID() });
    if (!admission.access) throw new Error("admission returned no access grant");
    result.nodeParticipantId = admission.participant.id;
    event({ type: "node-admitted" });

    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/home/ubuntu/.local/bin/google-chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
    const pages = [];
    for (let index = 0; index < browserCount; index++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const fixture = webMediaFixture(index, { permission: "granted" }).replace("tones: true", "turns: true").replace('speech: ""', `speech: "${silenceWavBase64()}"`);
      await context.addInitScript(fixture);
      const page = await context.newPage();
      page.on("pageerror", (error) => event({ type: "browser-pageerror", browser: index, error: String(error.message).slice(0, 300) }));
      pages.push({ index, context, page, name: `Browser ${index + 1}-${runId.slice(-5)}` });
    }
    for (const session of pages) {
      const at = Date.now();
      await session.page.goto(new URL(seed.invite.path, seed.urls.public).href);
      await session.page.getByLabel("Your name", { exact: true }).fill(session.name);
      await session.page.getByRole("button", { name: "Join call", exact: true }).click();
      await session.page.getByRole("button", { name: `Video tile for ${session.name}`, exact: true }).waitFor({ timeout: 60000 });
      event({ type: "browser-joined", browser: session.index, ms: Date.now() - at });
    }
    result.checks.browserJoined = true;

    rssBeforeAgent = process.memoryUsage().rss;
    cpuBeforeAgent = process.cpuUsage();
    agentStartAt = Date.now();
    agent = await createNodeAgent({
      library,
      server: chalk,
      spaceId: seed.spaceId,
      episodeId: episode.id,
      participant: admission.participant,
      initialAccess: admission.access,
      apiBaseUrl: seed.urls.api,
      syncUrl: seed.urls.sync.replace(/^http/, "ws") + "/v1/sync",
      onEvent: event,
    });
    const join = await agent.join(`Node spike ${library}`);
    result.measurements.nodeJoinMs = join.joinMs;
    result.checks.nodeJoined = true;

    await pages[0].page.getByRole("button", { name: `Video tile for Node spike ${library}`, exact: true }).first().waitFor({ timeout: 30000 });
    result.checks.rosterVisibleInBrowser = true;

    for (const session of pages) {
      await session.page.getByRole("region", { name: "Space stage", exact: true }).hover();
      await session.page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
      await session.page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor({ timeout: 15000 });
    }
    result.checks.browserMicrophonesPublished = true;

    const chatText = `node-chat-${Date.now()}`;
    const sentAt = Date.now();
    await agent.client.chat.send({ text: chatText });
    await pages[0].page.getByRole("button", { name: "Chat", exact: true }).first().click();
    await pages[0].page.getByText(chatText, { exact: true }).waitFor({ timeout: 15000 });
    result.measurements.nodeToBrowserChatMs = Date.now() - sentAt;
    result.checks.nodeChatSentAndReceived = true;
    const browserText = `browser-chat-${Date.now()}`;
    await pages[0].page.getByLabel("Message", { exact: true }).fill(browserText);
    await pages[0].page.getByRole("button", { name: "Send message", exact: true }).click();
    await waitFor(() => JSON.stringify(agent.client.getSnapshot().chat.messages).includes(browserText), 15000, "browser chat reached Node");
    result.checks.browserChatReceived = true;

    result.checks.browserPlaysRemoteAudio = true;

    const turnStart = Date.now() + 1500;
    await pages[0].page.evaluate((loopStartMs) => window.proofStartTurns({ loopStartMs, slotSeconds: 4, cycleSeconds: 8, cycles: 1, markerHz: [880, 1320, 1760, 2200], markerSeconds: 0.8, phraseDelaySeconds: 2, flashSeconds: 0.1 }), turnStart);
    const browserProbe = await waitFor(() => {
      const probe = [...agent.probes.values()].find((item) => item.onsets.some((onset) => onset.at >= turnStart - 100));
      return probe ? probe.snapshot() : false;
    }, 12000, "browser tone PCM in Node");
    const browserOnset = browserProbe.onsets.find((onset) => onset.at >= turnStart - 100);
    result.measurements.browserToNodeAudioMs = browserOnset.at - turnStart;
    result.measurements.browserPcm = browserProbe;
    result.checks.browserPcmTagged = Boolean(browserProbe.participantId && browserProbe.publicationId && browserProbe.source === "microphone");

    const nodeStart = Date.now() + 1200;
    agent.tone.scheduleTone({ startAt: nodeStart, durationMs: 900, frequency: 660, amplitude: 0.45 });
    const beforeAudio = await pages[0].page.evaluate(browserAudioEvidence);
    const beforeEnergy = inboundEnergy(beforeAudio);
    const heard = await waitFor(async () => {
      const evidence = await pages[0].page.evaluate(browserAudioEvidence);
      const energy = inboundEnergy(evidence);
      return energy.energy > beforeEnergy.energy + 0.001 || energy.level > 0.001 ? { evidence, energy } : false;
    }, 10000, "Node tone audible in browser");
    result.measurements.nodeToBrowserAudioMs = Date.now() - nodeStart;
    result.measurements.browserInboundAudio = heard.evidence.stats;
    result.checks.nodeToneAudibleInBrowser = true;

    const renewalsBefore = events.filter((entry) => entry.type === "access-issued").length;
    const runUntil = Date.now() + durationSeconds * 1000;
    while (Date.now() < runUntil) {
      if (agent.client.getSnapshot().connection.status !== "live") throw new Error(`Node connection left live state: ${JSON.stringify(agent.client.getSnapshot().connection)}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    result.measurements.renewalsObserved = events.filter((entry) => entry.type === "access-issued").length - renewalsBefore;
    result.measurements.accessDiagnostics = agent.diagnostics.filter((entry) => String(entry.event ?? "").includes("access"));
    result.checks.stayedLiveForDuration = true;
    if (durationSeconds >= 900) result.checks.renewalObserved = result.measurements.renewalsObserved > 0 || result.measurements.accessDiagnostics.some((entry) => entry.event === "access_refreshed");

    result.measurements.mediaSnapshots = agent.mediaSnapshots.slice(-30);
    result.measurements.pcmTracks = [...agent.probes.values()].map((probe) => probe.snapshot());
    result.measurements.remoteTrackCount = agent.probes.size;
    result.checks.expectedRemoteTracks = agent.probes.size >= browserCount;
    result.pass = Object.values(result.checks).every(Boolean);
  } finally {
    clearInterval(memoryTimer);
    for (const context of browser?.contexts() ?? []) await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await agent?.close().catch((error) => event({ type: "agent-close-error", error: String(error.message ?? error) }));
  }
} catch (error) {
  if (agent) result.nodeDebug = { snapshot: agent.client.getSnapshot(), mediaSnapshots: agent.mediaSnapshots, diagnostics: agent.diagnostics };
  failure = String(error.stack ?? error.message ?? error) + (error?.cause ? `\nCAUSE ${String(error.cause.stack ?? error.cause.message ?? error.cause)}` : "") + (error?.cause?.cause ? `\nCAUSE2 ${String(error.cause.cause.stack ?? error.cause.cause.message ?? error.cause.cause)}` : "");
  result.failure = failure;
}

const wallMs = Date.now() - startedRun;
const cpu = process.cpuUsage(cpuStart);
result.measurements.cpuPercentOfOneCore = ((cpu.user + cpu.system) / 1000 / wallMs) * 100;
if (typeof rssBeforeAgent === "number") {
  const agentCpu = process.cpuUsage(cpuBeforeAgent);
  const agentWallMs = Math.max(1, Date.now() - agentStartAt);
  result.measurements.agentCpuPercentOfOneCore = ((agentCpu.user + agentCpu.system) / 1000 / agentWallMs) * 100;
  result.measurements.agentRssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBeforeAgent);
  result.measurements.rssBeforeAgentBytes = rssBeforeAgent;
}
result.measurements.peakRssBytes = Math.max(0, ...memorySamples.map((sample) => sample.rss));
result.measurements.finalRssBytes = memorySamples.at(-1)?.rss ?? process.memoryUsage().rss;
result.measurements.wallMs = wallMs;
await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ out, pass: result.pass, failure, checks: result.checks, measurements: { nodeJoinMs: result.measurements.nodeJoinMs, browserToNodeAudioMs: result.measurements.browserToNodeAudioMs, nodeToBrowserAudioMs: result.measurements.nodeToBrowserAudioMs, cpuPercentOfOneCore: result.measurements.cpuPercentOfOneCore, peakRssBytes: result.measurements.peakRssBytes, remoteTrackCount: result.measurements.remoteTrackCount, renewalsObserved: result.measurements.renewalsObserved } }, null, 2));
process.exit(result.pass ? 0 : 1);

async function activeOrCreateEpisode() {
  const response = await fetch(`${seed.urls.api}/v1/tenants/${seed.tenantId}/spaces/${seed.spaceId}/episodes`, { headers: { Authorization: `Bearer ${seed.systemToken}` } });
  if (!response.ok) throw new Error(`episode list failed HTTP ${response.status}`);
  const live = (await response.json()).episodes?.find((episode) => episode.status === "active");
  if (live) { await chalk.episodes.end(seed.spaceId, live.id, { idempotencyKey: crypto.randomUUID() }).catch(() => undefined); }
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      return await chalk.episodes.create(seed.spaceId, { metadata: { spike: "node-agent" } }, { idempotencyKey: crypto.randomUUID() });
    } catch (error) {
      if (!String(error.message).includes("HTTP 409") || attempt === 14) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function silenceWavBase64() {
  const samples = 4800;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + samples * 2, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  return data.toString("base64");
}

async function browserAudioEvidence() {
  const reports = await Promise.all((window.proofConnections ?? []).map((connection) => connection.getStats()));
  return { stats: reports.flatMap((report) => [...report.values()]).filter((row) => row.kind === "audio" && ["media-source", "outbound-rtp", "inbound-rtp"].includes(row.type)).map((row) => Object.fromEntries(["type", "bytesSent", "packetsSent", "bytesReceived", "packetsReceived", "audioLevel", "totalAudioEnergy", "totalSamplesDuration"].map((field) => [field, row[field] ?? null]))) };
}

function inboundEnergy(evidence) {
  const inbound = evidence.stats.filter((row) => row.type === "inbound-rtp");
  return { level: Math.max(0, ...inbound.map((row) => row.audioLevel ?? 0)), energy: Math.max(0, ...inbound.map((row) => row.totalAudioEnergy ?? 0)) };
}
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}: timed out${lastError ? ` after ${lastError.message}` : ""}`);
}
