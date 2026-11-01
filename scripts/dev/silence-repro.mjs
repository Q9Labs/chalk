// Linux/Instabox only. Local API + Sync and a development Cloudflare SFU app. Never production.
// Classroom pattern: N participants join muted with cameras off, then speakers unmute. Each listener is
// sampled once per second per remote speaker through the whole ladder: roster, remote publication, track,
// inbound bytes, audioLevel, bound audio element, element paused, play() result.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor } from "./chalk.mjs";

const root = resolve(import.meta.dirname, "../..");
const requireConsumer = createRequire(resolve(root, "tools/sdk-web-consumer-e2e/package.json"));
const { build } = requireConsumer("esbuild");
const { chromium } = requireConsumer("playwright");

// name -> where the server and the SDK/React source come from. "npm" uses the published client bundle.
const builds = {
  "5.2.6": { serverRev: "origin/master", sdkRev: "2ec22c54b", npm: "5.2.6" },
  master: { serverRev: "origin/master", sdkRev: "origin/master" },
  pr716: { serverRev: "origin/master", sdkRev: "origin/fix/mic-mute-keeps-publication" },
  pr708: { serverRev: "origin/devin/mic-mute-keeps-publication", sdkRev: "origin/devin/mic-mute-keeps-publication" },
};
// Per-direction impairment (RTT = egress + ingress delay). Only the default interface is shaped, so browser-to-local
// API/Sync traffic on lo is untouched. Mobile caps egress at 1 Mbit/s with a queue of about one second.
const profiles = {
  open: null,
  home: { egress: "delay 75ms 15ms loss 2%", ingress: "delay 75ms 15ms loss 2%" },
  mobile: { egress: "delay 150ms 30ms loss 8% rate 1mbit limit 100", ingress: "delay 150ms 30ms loss 8%" },
};
// kill: the publisher's tracks are force-closed at the SFU 5 s after first publish.
// listener-kill: every listener's pulled track of each speaker is force-closed once, mid-call.
// pull503: the browser's remote-pull requests fail with 503 media.unavailable at a fixed rate.
// toggle: after the first unmute every speaker mutes for 4 s and unmutes for 8 s, repeatedly, so each unmute is a fresh publication.
// mute-cycle: speaker 0 alone taps mute and unmute ten times each, 2 to 6 s apart (same gaps for every build); the other speakers stay unmuted.
// ghost-end: 8 people, 4 speakers; at 35 s four browsers (two speakers, two listeners) are killed without leaving, 5 s later the owner ends the Episode for everyone.
// natural-idle: everyone joins, 20 s of quiet, then the first speaker unmutes (a class start); SR_FIRST_UNMUTE_S sets the delay for any other condition. Cloudflare drops a session unused for 15 s.
const faults = ["kill", "listener-kill", "pull503", "toggle", "mute-cycle", "ghost-end", "natural-idle"];
// A condition is "+"-joined parts: at most one network profile and any faults, for example "home+pull503".
const conditionOf = (name) => {
  const parts = name.split("+");
  const profileName = parts.find((part) => Object.hasOwn(profiles, part)) ?? "open";
  const faultNames = parts.filter((part) => !Object.hasOwn(profiles, part));
  assert.ok(
    faultNames.every((fault) => faults.includes(fault)),
    `unknown condition ${name}`,
  );
  return { profileName, profile: profiles[profileName], faults: faultNames };
};

const want = (process.env.SR_BUILDS || "5.2.6,pr716").split(",");
const wantConditions = (process.env.SR_CONDITIONS || "open,home,mobile").split(",");
const runsPerCell = Number(process.env.SR_RUNS || 2);
const runStart = Number(process.env.SR_RUN_START || 0);
const participantsCount = Number(process.env.SR_N || 8);
const speakerCount = Number(process.env.SR_SPEAKERS || 4);
const runSeconds = Number(process.env.SR_SECONDS || 105);
const firstUnmuteSeconds = Number(process.env.SR_FIRST_UNMUTE_S || 3);
const killDelayMs = Number(process.env.SR_KILL_DELAY_MS || 5000);
const pull503Rate = Number(process.env.SR_PULL503_RATE || 0.4);
const listenerKillFrom = Number(process.env.SR_LISTENER_KILL_FROM || 30);
// HTTPS_PROXY/NO_PROXY in the harness environment reach the API (Go honors them for its Cloudflare calls); the browsers are launched without them and stay on the shaped link.
const output = resolve(root, process.env.SR_OUTPUT || "artifacts/silence-repro");
await mkdir(output, { recursive: true });
// "sdk:<git ref>" tests that ref's SDK and React source on the master server tree; "ref:<git ref>" takes both from the ref.
// "npm:<version>@<git ref>" runs the published client <version> against the server built from that ref (what a customer on an old SDK sees after a server deploy).
const buildSpec = (name) => {
  if (name.startsWith("npm:")) {
    const [npm, serverRev] = name.slice(4).split("@");
    return { serverRev, sdkRev: builds[npm]?.sdkRev, npm };
  }
  if (name.startsWith("sdk:")) return { serverRev: "origin/master", sdkRev: name.slice(4) };
  if (name.startsWith("ref:")) return { serverRev: name.slice(4), sdkRev: name.slice(4) };
  return builds[name];
};
assert.ok(want.every((name) => buildSpec(name)));
wantConditions.forEach(conditionOf);

const credentials = JSON.parse(await readFile(process.env.CHALK_DEVELOPMENT_CREDENTIALS || "/tmp/sr-creds.json", "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
const sfu = `https://rtc.live.cloudflare.com/v1/apps/${credentials.appId}`;
const sfuFetch = (path, init = {}) => fetch(`${sfu}${path}`, { ...init, headers: { authorization: `Bearer ${credentials.appSecret}`, "content-type": "application/json" } });

const git = (...args) => execFileSync("git", args, { maxBuffer: 400 * 1024 * 1024 });
const exportTree = (rev, destination, paths = []) => {
  execFileSync("mkdir", ["-p", destination]);
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: git("archive", rev, ...paths), maxBuffer: 400 * 1024 * 1024 });
};
const resolveRev = (rev) => git("rev-parse", rev).toString().trim();

async function publishedClient(version) {
  const destination = resolve(root, ".private/silence-repro/packages", version);
  const metadata = await (await fetch(`https://registry.npmjs.org/@q9labsai%2fchalk-client/${version}`)).json();
  const archive = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(integrity, metadata.dist.integrity, `SDK ${version} integrity`);
  execFileSync("mkdir", ["-p", destination]);
  execFileSync("tar", ["-xzf", "-", "-C", destination, "--strip-components=1"], { input: archive });
  return destination;
}

const sh = (command) => execFileSync("sh", ["-c", command], { encoding: "utf8" });
const defaultInterface = () => sh("ip route show default | awk '{print $5; exit}'").trim();
const tc = (...args) => execFileSync("sudo", ["tc", ...args], { stdio: "pipe" });
// Only UDP is shaped, which is Chromium's WebRTC media path to the SFU (DNS and NTP excluded). TCP stays clean: the local
// API's own calls to Cloudflare are a datacenter link in production, and the box's control channel must keep working.
// Egress: prio qdisc, UDP through netem in band 3, the rest in band 1. Ingress: UDP is redirected to ifb0 and shaped there.
const setNetem = (profile) => {
  clearNetem();
  if (!profile) return;
  const dev = defaultInterface();
  const unshapedUdpPorts = ["53", "123"];
  tc("qdisc", "add", "dev", dev, "root", "handle", "1:", "prio", "bands", "3", "priomap", ...Array(16).fill("0"));
  tc("qdisc", "add", "dev", dev, "parent", "1:3", "handle", "30:", "netem", ...profile.egress.split(" "));
  for (const port of unshapedUdpPorts) tc("filter", "add", "dev", dev, "parent", "1:", "protocol", "ip", "prio", "1", "u32", "match", "ip", "protocol", "17", "0xff", "match", "ip", "dport", port, "0xffff", "flowid", "1:1");
  tc("filter", "add", "dev", dev, "parent", "1:", "protocol", "ip", "prio", "2", "u32", "match", "ip", "protocol", "17", "0xff", "flowid", "1:3");
  try {
    execFileSync("sudo", ["ip", "link", "add", "ifb0", "type", "ifb"], { stdio: "pipe" });
  } catch {} // already exists
  execFileSync("sudo", ["ip", "link", "set", "ifb0", "up"]);
  tc("qdisc", "add", "dev", dev, "handle", "ffff:", "ingress");
  for (const port of unshapedUdpPorts) tc("filter", "add", "dev", dev, "parent", "ffff:", "protocol", "ip", "prio", "1", "u32", "match", "ip", "protocol", "17", "0xff", "match", "ip", "sport", port, "0xffff", "action", "pass");
  tc("filter", "add", "dev", dev, "parent", "ffff:", "protocol", "ip", "prio", "2", "u32", "match", "ip", "protocol", "17", "0xff", "action", "mirred", "egress", "redirect", "dev", "ifb0");
  tc("qdisc", "add", "dev", "ifb0", "root", "netem", ...profile.ingress.split(" "));
};
// Packets and drops the two netem qdiscs handled, as proof the shaping saw the room's media.
const shapedPackets = () => {
  const stats = (dev) => {
    const text = execFileSync("sudo", ["tc", "-s", "qdisc", "show", "dev", dev], { encoding: "utf8" });
    const netem = text.slice(text.indexOf("qdisc netem"));
    const match = /Sent \d+ bytes (\d+) pkt \(dropped (\d+)/u.exec(netem);
    return match ? { packets: Number(match[1]), dropped: Number(match[2]) } : null;
  };
  return { egress: stats(defaultInterface()), ingress: stats("ifb0") };
};
const clearNetem = () => {
  const dev = defaultInterface();
  for (const args of [
    ["qdisc", "del", "dev", dev, "root"],
    ["qdisc", "del", "dev", dev, "ingress"],
    ["qdisc", "del", "dev", "ifb0", "root"],
  ]) {
    try {
      tc(...args);
    } catch {} // nothing to remove
  }
};

function browserInstrumentation({ frequency }) {
  window.matrixErrors = [];
  window.matrixPeers = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      window.matrixPeers.push(this);
      const born = performance.now();
      const line = (this.srTimeline = [["created", 0, Date.now()]]);
      const mark = (name) => line.push([name, Math.round(performance.now() - born), Date.now()]);
      this.srMark = mark;
      this.addEventListener("icegatheringstatechange", () => mark(`gathering:${this.iceGatheringState}`));
      this.addEventListener("iceconnectionstatechange", () => mark(`ice:${this.iceConnectionState}`));
      this.addEventListener("connectionstatechange", () => mark(`conn:${this.connectionState}`));
      this.addEventListener("track", () => mark("track"));
      this.addEventListener("icecandidate", (event) => mark(event.candidate ? `candidate:${event.candidate.type}` : "candidate:end"));
      let dtls = false;
      let packets = false;
      const timer = setInterval(async () => {
        if (this.connectionState === "closed" || (dtls && packets)) return clearInterval(timer);
        try {
          (await this.getStats()).forEach((stat) => {
            if (!dtls && stat.type === "transport" && stat.dtlsState === "connected") {
              dtls = true;
              mark("dtls:connected");
            }
            if (!packets && stat.type === "inbound-rtp" && stat.packetsReceived > 0) {
              packets = true;
              mark("first-rtp");
            }
          });
        } catch {} // the connection closed between ticks
      }, 50);
    }
    setLocalDescription(description) {
      this.srMark(`setLocal:${description?.type ?? "implicit"}`);
      return super.setLocalDescription(description);
    }
    setRemoteDescription(description) {
      this.srMark(`setRemote:${description?.type}`);
      return super.setRemoteDescription(description);
    }
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = new MediaStream();
    if (constraints.audio) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      (window.matrixToneGraphs ??= []).push({ context, oscillator, destination });
    }
    return stream;
  };
  window.srMidFor = (speaker) => {
    const entry = window.matrixClient.getSnapshot().media.remote.find((candidate) => candidate.source === "microphone" && candidate.participantId === speaker);
    if (!entry?.track) return null;
    for (const pc of window.matrixPeers) {
      if (pc.connectionState === "closed") continue;
      const transceiver = pc.getTransceivers().find((candidate) => candidate.receiver.track?.id === entry.track.id);
      if (transceiver?.mid) return transceiver.mid;
    }
    return null;
  };
  window.srSample = async () => {
    const snapshot = window.matrixClient.getSnapshot();
    const remote = [];
    for (const entry of snapshot.media.remote.filter((entry) => entry.source === "microphone")) {
      const track = entry.track;
      let inbound = null;
      for (const pc of window.matrixPeers) {
        if (pc.connectionState === "closed") continue;
        const receiver = pc.getReceivers().find((candidate) => candidate.track?.id === track?.id);
        if (!receiver) continue;
        (await receiver.getStats()).forEach((stat) => {
          if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) inbound = { bytes: stat.bytesReceived || 0, packets: stat.packetsReceived || 0, audioLevel: stat.audioLevel ?? null, energy: stat.totalAudioEnergy ?? null };
        });
      }
      const element = track ? window.srElements?.[track.id] : undefined;
      remote.push({
        speaker: entry.participantId,
        trackId: track?.id ?? null,
        readyState: track?.readyState ?? null,
        muted: track?.muted ?? null,
        inbound,
        element: element ? { bound: element.audio.srcObject?.getAudioTracks()[0]?.id === track.id, paused: element.audio.paused, play: element.play } : null,
      });
    }
    return {
      status: snapshot.connection.status,
      mic: snapshot.media.local.microphone.state,
      micDetail: JSON.parse(JSON.stringify(snapshot.media.local.microphone, (_key, value) => (value instanceof MediaStreamTrack ? undefined : value))),
      commandError: window.matrixCommandError ? { code: window.matrixCommandError.code ?? null, message: String(window.matrixCommandError.message ?? "").slice(0, 160) } : null,
      self: snapshot.self.participantId,
      roster: snapshot.participants.roster.map((participant) => participant.participantId),
      remote,
      errors: window.matrixErrors.splice(0),
    };
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { started: new Date().toISOString(), options: { runsPerCell, participantsCount, speakerCount, runSeconds, killDelayMs }, runs: [] };
const save = async () => writeFile(`${output}/silence-repro.json`, JSON.stringify(report));
const allBrowsers = [];
let http;

// Box CPU for the harness-load check: cumulative jiffies [total, idle, steal] from /proc/stat plus the 1 minute load; null off Linux.
function boxCpu() {
  if (process.platform !== "linux") return null;
  const [, user, nice, system, idle, iowait, irq, softirq, steal] = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/u).map(Number);
  return { jiffies: [user + nice + system + idle + iowait + irq + softirq + steal, idle + iowait, steal], load1: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) };
}

async function runBuild(name) {
  const spec = buildSpec(name);
  const dir = resolve(root, ".private/silence-repro", name.replaceAll(/\W/gu, "_"));
  const serverRoot = `${dir}/server`;
  const sdkRoot = `${dir}/sdk`;
  const serverSha = resolveRev(spec.serverRev);
  const sdkSha = resolveRev(spec.sdkRev);
  exportTree(serverSha, serverRoot);
  exportTree(sdkSha, sdkRoot, ["sdks/typescript/client", "sdks/typescript/react"]);
  const packagePath = spec.npm ? await publishedClient(spec.npm) : null;
  console.log(`Build ${name}: server ${serverSha.slice(0, 9)}, sdk ${sdkSha.slice(0, 9)}${spec.npm ? ` (npm ${spec.npm})` : ""}`);

  let systemToken, tenant;
  const config = resolveDevConfig({
    root: serverRoot,
    env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "600000", CHALK_DEV_WEB_PORT: "4870" },
    requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"],
    secretResolver: async () => credentials,
  });
  config.webJoinPath = "/synthetic";
  config.databaseName = `chalk_silence_repro_${name.replace(/\W/gu, "_").toLowerCase()}`;
  const services = [
    { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${serverRoot}/apps/api`, readiness: { url: `${config.urls.api}/readyz` } },
    { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${serverRoot}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` } },
  ];
  const localFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.hostname, "127.0.0.1");
    systemToken ??= new Headers(init?.headers).get("Authorization")?.slice(7);
    const response = await fetch(input, init);
    if (response.ok && /\/v1\/tenants$/u.test(url.pathname)) {
      const body = await response.clone().json();
      tenant = init?.method === "POST" ? body : body.tenants?.find((entry) => entry.name.startsWith("Chalk local dev "));
    }
    return response;
  };
  const runtime = createChalkSupervisor(config, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });

  const sdkTs = `${sdkRoot}/sdks/typescript`;
  const aliases = {
    "matrix-client-effect": packagePath ? `${packagePath}/dist/effect.js` : `${sdkTs}/client/src/effect.ts`,
    "matrix-react-context": `${sdkTs}/react/src/bindings/context.tsx`,
    "matrix-react-hooks": `${sdkTs}/react/src/bindings/hooks.ts`,
    "matrix-react-controls": `${sdkTs}/react/src/components/control-bar/control-bar-behavior.ts`,
    "@q9labsai/chalk-client": packagePath ? `${packagePath}/dist/index.js` : `${sdkTs}/client/src/index.ts`,
  };
  const built = await build({
    entryPoints: [resolve(root, "scripts/dev/silence-repro-page.jsx")],
    alias: aliases,
    nodePaths: [resolve(root, "node_modules"), resolve(root, "sdks/typescript/client/node_modules"), resolve(root, "sdks/typescript/react/node_modules"), resolve(root, "tools/sdk-web-consumer-e2e/node_modules")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  const bundle = built.outputFiles[0].text;
  const serverClientFile = `${output}/server-client-${name}.mjs`;
  await build({ entryPoints: [`${serverRoot}/sdks/typescript/client/src/server/index.ts`], bundle: true, outfile: serverClientFile, platform: "node", format: "esm", nodePaths: [resolve(root, "node_modules"), resolve(root, "sdks/typescript/client/node_modules")] });
  const { createChalkServerClient, getAccessRefreshState } = await import(serverClientFile);

  const syncDir = `${serverRoot}/apps/sync`;
  const prod = { ...process.env, MIX_ENV: "prod" };
  execFileSync("mix", ["deps.get"], { cwd: syncDir, env: prod, stdio: "ignore" });
  execFileSync("mix", ["compile"], { cwd: syncDir, env: prod, stdio: "ignore" });
  execFileSync("go", ["build", "-o", "/dev/null", "./cmd"], { cwd: `${serverRoot}/apps/api`, stdio: "ignore" });
  console.log(`Starting server for ${name}.`);
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  assert.ok(tenant && systemToken);
  const chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: tenant.id, apiKey: systemToken });
  http = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<html><body><main id="root"></main><script>${bundle}</script></body></html>`);
  });
  http.listen(config.ports.web, "127.0.0.1");
  await once(http, "listening");

  try {
    // Conditions rotate inside each run index, so slow drift at the SFU spreads over all conditions.
    for (let runIndex = runStart; runIndex < runStart + runsPerCell; runIndex++)
      for (const conditionName of wantConditions) {
        const condition = conditionOf(conditionName);
        const run = {
          build: name,
          serverSha,
          sdkSha,
          condition: conditionName,
          profile: condition.profileName,
          netem: condition.profile,
          kill: condition.faults.includes("kill"),
          listenerKill: condition.faults.includes("listener-kill"),
          pull503: condition.faults.includes("pull503") ? pull503Rate : 0,
          toggle: condition.faults.includes("toggle"),
          muteCycle: condition.faults.includes("mute-cycle"),
          ghostEnd: condition.faults.includes("ghost-end"),
          firstUnmuteSeconds: condition.faults.includes("natural-idle") ? 20 : firstUnmuteSeconds,
          runIndex,
          started: new Date().toISOString(),
          network: [],
          actions: [],
          samples: [],
          faults: [],
          kills: [],
          listenerKills: [],
          injected503: [],
        };
        report.runs.push(run);
        try {
          setNetem(condition.profile);
          const episodeStatus = async (spaceId, episodeId) => {
            const response = await fetch(`${config.urls.api}/v1/tenants/${tenant.id}/spaces/${spaceId}/episodes/${episodeId}`, { headers: { authorization: `Bearer ${systemToken}` } });
            return response.ok ? (await response.json()).status : `http-${response.status}`;
          };
          await runRoom(run, { chalk, config, getAccessRefreshState, name, conditionName, episodeStatus });
        } catch (error) {
          run.error = error.message;
          console.log(`Run failed ${name}/${conditionName}/${runIndex}: ${error.message}`);
        } finally {
          if (condition.profile) run.shaped = shapedPackets();
          clearNetem();
        }
        await save();
        console.log(`Done ${name}/${conditionName}/${runIndex}${run.error ? " (error)" : ""}`);
      }
  } finally {
    clearNetem();
    if (http) await new Promise((done) => http.close(done));
    http = undefined;
    await runtime.stop();
  }
}

async function runRoom(run, { chalk, config, getAccessRefreshState, name, conditionName, episodeStatus }) {
  const space = await chalk.spaces.create({
    name: `Silence ${name}`,
    // The timestamp goes first: a long build name pushed it past the 60-character cut, and rooms of one build and condition then collided on the slug (409).
    slug: `sr-${Date.now().toString(36)}-${conditionName.replaceAll(/\W/gu, "-").toLowerCase()}-${name.replaceAll(/\W/gu, "-")}`.slice(0, 60),
    mediaPlane: "cf_sfu",
    defaultEpisodeDurationSeconds: 3600,
    maximumEpisodeDurationSeconds: 7200,
    lingerWindowSeconds: 600,
  });
  const episode = await chalk.episodes.create(space.id, {});
  const browser = await chromium.launch({
    headless: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$/iu.test(key))),
    executablePath: process.env.SR_CHROMIUM || undefined,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  allBrowsers.push(browser);
  const origin = Date.now();
  const ids = new Map();
  const participantIds = [];
  const pullSessions = [];
  const random = seededRandom(run.runIndex * 7919 + name.length * 31 + conditionName.length);
  const connections = Array.from({ length: participantsCount }, () => new Set());
  const killed = new Set();
  const participants = [];
  try {
    // Admission creates an SFU session; admit one at a time and retry a provider timeout.
    const admissions = [];
    for (let index = 0; index < participantsCount; index++) {
      for (let attempt = 1; ; attempt++) {
        try {
          admissions.push(await chalk.participants.admit(space.id, episode.id, { name: index === 0 ? "Synthetic teacher" : `Synthetic student ${index}`, role: index === 0 ? "owner" : "collaborator" }));
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          run.faults.push({ kind: "admit-retry", participant: index, message: error.message });
        }
      }
    }
    await Promise.all(
      Array.from({ length: participantsCount }, async (_, index) => {
        const admission = admissions[index];
        let access = admission.access;
        connections[index].add(access.media.client_payload.connectionId);
        let firstAccess = true;
        let accessQueue = Promise.resolve();
        const context = await browser.newContext({ permissions: ["microphone"] });
        await context.addInitScript(browserInstrumentation, { frequency: 300 + index * 110 });
        if (run.pull503 > 0)
          await context.route(/\/media\//u, async (route) => {
            const request = route.request();
            const tracks = request.method() === "POST" ? request.postDataJSON()?.tracks : null;
            if (!tracks?.length || !tracks.every((track) => track.location === "remote") || random() >= run.pull503) return route.continue();
            run.injected503.push({ at: Date.now() - origin, participant: index });
            return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "media.unavailable", message: "Media plane is unavailable" } }) });
          });
        const page = await context.newPage();
        await page.exposeFunction("matrixAccess", (request) => {
          const next = accessQueue.then(async () => {
            if (firstAccess) firstAccess = false;
            else access = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(access), request);
            connections[index].add(access.media.client_payload.connectionId);
            return access;
          });
          accessQueue = next.catch(() => undefined);
          return next;
        });
        page.on("console", (message) => {
          if (message.type() === "error") run.faults.push({ at: Date.now() - origin, participant: index, kind: "console-error", message: message.text().slice(0, 400) });
        });
        page.on("pageerror", (error) => run.faults.push({ at: Date.now() - origin, participant: index, kind: "pageerror", message: error.message }));
        const requestStarts = new WeakMap();
        page.on("request", (request) => requestStarts.set(request, Date.now() - origin));
        page.on("websocket", (socket) => {
          const socketPath = new URL(socket.url()).pathname.replace(/\/[0-9a-f-]{20,}/gu, "/:id");
          const frame = (direction) => (event) => (run.socketFrames ??= []).push({ at: Date.now() - origin, participant: index, direction, path: socketPath, bytes: typeof event.payload === "string" ? event.payload.length : event.payload.byteLength });
          (run.socketFrames ??= []).push({ at: Date.now() - origin, participant: index, direction: "open", path: socketPath, bytes: 0 });
          socket.on("framesent", frame("sent"));
          socket.on("framereceived", frame("received"));
          socket.on("close", () => (run.socketFrames ??= []).push({ at: Date.now() - origin, participant: index, direction: "close", path: socketPath, bytes: 0 }));
        });
        page.on("response", async (response) => {
          const path = new URL(response.url()).pathname;
          if (new URL(response.url()).origin === new URL(config.urls.api).origin)
            (run.apiRequests ??= []).push({ at: Date.now() - origin, startedAt: requestStarts.get(response.request()) ?? null, participant: index, method: response.request().method(), path: path.replace(/\/[0-9a-f-]{20,}/gu, "/:id"), status: response.status() });
          if (!/media\//u.test(path)) return;
          let body = {};
          try {
            body = await response.json();
          } catch {}
          const input = response.request().postDataJSON();
          const connectionId = input?.connection_id ?? null;
          if (connectionId) connections[index].add(connectionId);
          if (connectionId && input?.tracks?.[0]?.location === "remote" && response.status() < 300) pullSessions[index] = connectionId;
          const entry = {
            at: Date.now() - origin,
            startedAt: requestStarts.get(response.request()) ?? null,
            participant: index,
            method: response.request().method(),
            path: path.replace(/\/[0-9a-f-]{20,}/gu, "/:id"),
            status: response.status(),
            locations: input?.tracks?.map((track) => track.location).join(",") ?? null,
            targets: input?.tracks?.filter((track) => track.location === "remote").map((track) => ({ sessionId: track.sessionId ?? null, trackName: track.trackName ?? null })),
            bodyKeys: input?.tracks?.some((track) => track.location === "local") ? Object.keys(body).slice(0, 12) : undefined,
            localSessionId: input?.tracks?.some((track) => track.location === "local") ? (body.sessionId ?? body.session_id ?? null) : undefined,
            connectionNumber: connectionId ? [...connections[index]].indexOf(connectionId) + 1 : null,
            errorCode: body.code ?? body.error?.code ?? body.errorCode ?? null,
            trackErrors: (body.trackErrors ?? body.tracks?.filter((track) => track.errorCode || track.errorDescription))?.map((track) => track.code ?? track.errorCode ?? "unknown"),
            trackErrorDetail: body.tracks?.filter((track) => track.errorCode || track.errorDescription).map((track) => ({ code: track.errorCode ?? null, description: String(track.errorDescription ?? "").slice(0, 200) })),
          };
          run.network.push(entry);
          if (entry.targets?.length) appendFileSync(process.env.SR_TARGETS_FILE ?? "/tmp/sr-targets.jsonl", `${JSON.stringify({ at: Date.now(), participant: index, status: entry.status, trackErrors: entry.trackErrors?.length ?? 0, targets: entry.targets })}\n`);
          // First local publish by this participant's first SFU session: schedule the session kill.
          if (run.kill && entry.method === "POST" && entry.locations === "local" && entry.status < 300 && connectionId && !killed.has(index)) {
            killed.add(index);
            setTimeout(() => killSession(run, origin, index, connectionId), killDelayMs);
          }
        });
        await page.goto(config.urls.web);
        await page.evaluate((cfg) => window.matrixJoin(cfg), { space: space.slug, baseUrl: config.urls.api, syncUrl: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: `Synthetic ${index}`, microphone: false });
        await page.waitForFunction(() => window.matrixClient?.getSnapshot().connection.status === "live", null, { timeout: 120000 });
        participantIds[index] = await page.evaluate(() => window.matrixClient.getSnapshot().self.participantId);
        ids.set(participantIds[index], index);
        participants[index] = { context, page };
      }),
    );
    run.joinSeconds = (Date.now() - origin) / 1000;
    const start = performance.now(); // monotonic: the box clock can step mid-run
    const startWall = Date.now();
    const schedule = [];
    for (let speaker = 0; speaker < speakerCount; speaker++) {
      schedule.push({ at: run.firstUnmuteSeconds + speaker * 7, participant: speaker, kind: "unmute", first: true });
      if (run.toggle) {
        for (let mute = 30 + speaker * 3; mute + 12 <= runSeconds; mute += 12) schedule.push({ at: mute, participant: speaker, kind: "mute" }, { at: mute + 4, participant: speaker, kind: "unmute", first: false });
      } else {
        schedule.push({ at: 55 + speaker * 8, participant: speaker, kind: "mute" }, { at: 59 + speaker * 8, participant: speaker, kind: "unmute", first: false });
      }
    }
    let roomSeconds = runSeconds;
    if (run.muteCycle) {
      const gaps = seededRandom(run.runIndex * 104729 + 17);
      schedule.length = 0;
      for (let speaker = 0; speaker < speakerCount; speaker++) schedule.push({ at: run.firstUnmuteSeconds + speaker * 7, participant: speaker, kind: "unmute", first: true });
      let at = run.firstUnmuteSeconds;
      for (let cycle = 0; cycle < 10; cycle++) {
        at += 2 + gaps() * 4;
        schedule.push({ at, participant: 0, kind: "mute" });
        at += 2 + gaps() * 4;
        schedule.push({ at, participant: 0, kind: "unmute", first: false });
      }
      roomSeconds = Math.max(runSeconds, at + 10);
    }
    const ghosts = [1, 2, 5, 6];
    const ghostKillAt = 35;
    const ghostEndAt = ghostKillAt + 5;
    let ghostDone = false;
    let ghostStarted = false;
    if (run.ghostEnd) {
      assert.equal(participantsCount, 8);
      schedule.splice(0, schedule.length, ...schedule.filter((action) => action.first));
      roomSeconds = Math.max(runSeconds, ghostEndAt + 75);
    }
    schedule.sort((a, b) => a.at - b.at);
    run.speakerCount = speakerCount;
    // Every listener-speaker pair loses its pulled track once, in shuffled order, 0.7 s apart while all speakers are on.
    const pairKills = [];
    if (run.listenerKill) {
      const pairs = [];
      for (let speaker = 0; speaker < speakerCount; speaker++) for (let listener = 0; listener < participantsCount; listener++) if (listener !== speaker) pairs.push({ speaker, listener });
      pairs.sort(() => random() - 0.5).forEach((pair, order) => pairKills.push({ ...pair, at: listenerKillFrom + order * 0.7 }));
    }
    let killCursor = 0;
    let cursor = 0;
    // A user taps the microphone button only when it offers that action: unmute when the call is live and the mic is off,
    // mute when the mic is on. The button is a blind toggle, so a click at any other moment does the opposite or nothing.
    // Each speaker's actions run in order on their own chain; a tap that finds no ready button for 10 s is recorded as blocked.
    const READY_WAIT_MS = 10_000;
    const chains = participants.map(() => Promise.resolve());
    const tap = async (event) => {
      const page = participants[event.participant].page;
      const wantOn = event.kind === "unmute";
      const waitStart = performance.now();
      try {
        await page.waitForFunction((on) => (on ? window.srUi?.canToggle && window.srUi.state !== "enabled" && window.srUi.state !== "requesting" : window.srUi?.state === "enabled"), wantOn, { timeout: READY_WAIT_MS, polling: 50 });
      } catch {
        event.blocked = await page.evaluate(() => window.srUi).catch(() => null);
        event.waitedMs = Math.round(performance.now() - waitStart);
        return;
      }
      event.waitedMs = Math.round(performance.now() - waitStart);
      event.t = (performance.now() - start) / 1000;
      event.clickedAtMs = Date.now() - origin;
      try {
        await page.locator("#mic").click({ timeout: 3000 });
      } catch (error) {
        event.error = error.message;
      }
    };
    // Hard-kill four browsers (their SFU sessions stay behind as ghosts), then the owner taps end for everyone and each remaining page and the API are polled until the call and the Episode have ended.
    const runGhostEnd = async () => {
      const report = (run.ghostEndReport = { ghosts, killedAtMs: null, endTapMs: null, endReturnedMs: null, endError: null, remaining: [], episodeEndedAtMs: null, episodeStatuses: [] });
      const remaining = participants.map((_, index) => index).filter((index) => !ghosts.includes(index));
      await Promise.all(ghosts.map((index) => participants[index].context.close().catch(() => undefined)));
      report.killedAtMs = Date.now() - origin;
      await sleep((ghostEndAt - ghostKillAt) * 1000);
      report.endTapMs = Date.now() - origin;
      const tap = participants[0].page
        .evaluate(() => window.matrixClient.endEpisode())
        .then(
          () => (report.endReturnedMs = Date.now() - origin),
          (error) => {
            report.endError = error.message;
            report.endReturnedMs = Date.now() - origin;
          },
        );
      const deadline = performance.now() + 60_000;
      report.remaining = remaining.map((participant) => ({ participant, endedAtMs: null, status: null }));
      const watchPages = Promise.all(
        report.remaining.map(async (entry) => {
          while (performance.now() < deadline) {
            const snapshot = await participants[entry.participant].page.evaluate(() => ({ ended: window.matrixClient.getSnapshot().connection.episodeEnded, status: window.matrixClient.getSnapshot().connection.status })).catch(() => null);
            if (snapshot) entry.status = snapshot.status;
            if (snapshot && (snapshot.ended || snapshot.status === "left" || snapshot.status === "failed")) return void (entry.endedAtMs = Date.now() - origin);
            await sleep(100);
          }
        }),
      );
      const watchApi = (async () => {
        while (performance.now() < deadline) {
          const status = await episodeStatus(space.id, episode.id).catch((error) => `error:${error.message}`);
          report.episodeStatuses.push({ at: Date.now() - origin, status });
          if (status === "ended") return void (report.episodeEndedAtMs = Date.now() - origin);
          await sleep(250);
        }
      })();
      await Promise.all([tap, watchPages, watchApi]);
      ghostDone = true;
    };
    while ((performance.now() - start) / 1000 < roomSeconds && !ghostDone) {
      const t = (performance.now() - start) / 1000;
      if (run.ghostEnd && !ghostStarted && t >= ghostKillAt) {
        ghostStarted = true;
        void runGhostEnd();
      }
      while (cursor < schedule.length && schedule[cursor].at <= t) {
        const action = schedule[cursor++];
        const event = { ...action, t, scheduledT: t, clickedAtMs: Date.now() - origin };
        run.actions.push(event);
        chains[action.participant] = chains[action.participant].then(() => tap(event));
      }
      while (killCursor < pairKills.length && pairKills[killCursor].at <= t) {
        const { listener, speaker } = pairKills[killCursor++];
        const event = { listener, speaker, t, atMs: Date.now() - origin };
        run.listenerKills.push(event);
        void killListenerTrack(event, participants[listener].page, participantIds[speaker], pullSessions[listener] ?? [...connections[listener]].at(-1));
      }
      const states = await Promise.all(
        participants.map(async ({ page }, listener) => {
          try {
            const sample = await page.evaluate(() => window.srSample());
            return { listener, status: sample.status, mic: sample.mic, micDetail: sample.micDetail, commandError: sample.commandError, roster: sample.roster.map((id) => ids.get(id)), errors: sample.errors, remote: sample.remote.map((entry) => ({ ...entry, speaker: ids.get(entry.speaker) })) };
          } catch (error) {
            return { listener, error: error.message, remote: [] };
          }
        }),
      );
      run.samples.push({ t: (performance.now() - start) / 1000, atMs: Date.now() - origin, cpu: boxCpu(), states });
      // The cloud box sometimes freezes for tens of seconds; the analyzer drops rooms that recorded a stall.
      const sleepStart = performance.now();
      await sleep(1000);
      const overrunMs = performance.now() - sleepStart - 1000;
      if (overrunMs > 3000) (run.stalls ??= []).push({ t: (sleepStart - start) / 1000, overrunMs: Math.round(overrunMs) });
    }
    run.wallMinusMonotonicMs = Date.now() - startWall - (performance.now() - start);
    run.sessionsPerParticipant = connections.map((set) => set.size);
    await Promise.allSettled(chains);
    run.harness = "ui-ready-v2";
    run.originMs = origin;
    run.clickTrace = await Promise.all(participants.map(({ page }) => page.evaluate(() => window.srTrace ?? []).catch(() => [])));
    run.peerTimelines = await Promise.all(participants.map(({ page }) => page.evaluate(() => window.matrixPeers.map((pc) => pc.srTimeline)).catch(() => [])));
    for (const { page } of participants) await page.evaluate(() => window.matrixClient.leave()).catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Closes one pulled track in the listener's SFU session with force, so media stops without the SDK's help.
async function killListenerTrack(event, page, speakerParticipantId, sessionId) {
  try {
    let mid = null;
    for (event.attempts = 1; event.attempts <= 5; event.attempts++) {
      mid = await page.evaluate((speaker) => window.srMidFor(speaker), speakerParticipantId);
      if (mid) break;
      await sleep(1000); // the track may be mid-replacement
    }
    event.mid = mid;
    if (!mid || !sessionId) return;
    const response = await sfuFetch(`/sessions/${sessionId}/tracks/close`, { method: "PUT", body: JSON.stringify({ tracks: [{ mid }], force: true }) });
    event.closeStatus = response.status;
    if (!response.ok) event.closeBody = (await response.text()).slice(0, 200);
  } catch (error) {
    event.error = error.message;
  }
}

// Closing the publisher's tracks at Cloudflare with force removes media from the session without the SDK's help.
async function killSession(run, origin, participant, connectionId) {
  const event = { participant, connectionId: createHash("sha256").update(connectionId).digest("hex").slice(0, 8), at: Date.now() - origin };
  run.kills.push(event);
  try {
    const session = await (await sfuFetch(`/sessions/${connectionId}`)).json();
    const mids = (session.tracks ?? []).filter((track) => track.mid).map((track) => ({ mid: track.mid }));
    event.tracksBefore = mids.length;
    if (!mids.length) return;
    const response = await sfuFetch(`/sessions/${connectionId}/tracks/close`, { method: "PUT", body: JSON.stringify({ tracks: mids, force: true }) });
    event.closeStatus = response.status;
    const after = await sfuFetch(`/sessions/${connectionId}`);
    event.sessionStatusAfter = after.status;
  } catch (error) {
    event.error = error.message;
  }
}

try {
  for (const name of want) await runBuild(name);
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  clearNetem();
  await Promise.all(allBrowsers.map((browser) => browser.close().catch(() => undefined)));
  report.completed = new Date().toISOString();
  await save();
}
