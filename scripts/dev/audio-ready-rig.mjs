// Linux/Instabox only. Local API + Sync and a development Cloudflare SFU app. Never production.
// Classroom pattern: N participants join muted with cameras off, then speakers unmute. Each listener is
// sampled once per second per remote speaker through the whole ladder: roster, remote publication, track,
// inbound bytes, audioLevel, bound audio element, element paused, play() result.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
const output = resolve(root, process.env.SR_OUTPUT || "artifacts/audio-ready");
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
  const destination = resolve(root, ".private/audio-ready/packages", version);
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
const userspaceShaper = process.env.AR_SHAPER === "userspace";
// Kernels without netem or ifb (Instabox): audio-ready-shaper.py impairs UDP between the browser namespace and the host from /dev/shm/ar-shape.json.
const shaperParams = (spec) => {
  const words = spec.split(" ");
  const after = (key, count) => words.slice(words.indexOf(key) + 1, words.indexOf(key) + 1 + count);
  const params = {};
  if (words.includes("delay")) {
    const [delay, jitter] = after("delay", 2);
    params.delay_ms = parseFloat(delay);
    params.jitter_ms = jitter?.endsWith("ms") ? parseFloat(jitter) : 0;
  }
  if (words.includes("loss")) params.loss = parseFloat(after("loss", 1)[0]);
  if (words.includes("rate")) params.rate = parseFloat(after("rate", 1)[0]) * 1_000_000;
  if (words.includes("limit")) params.limit = Number(after("limit", 1)[0]);
  return params;
};
const shaperControl = "/dev/shm/ar-shape.json";
const setUserspaceShaper = (profile) => writeFileSync(shaperControl, JSON.stringify(profile ? { egress: shaperParams(profile.egress), ingress: shaperParams(profile.ingress) } : {}));
const setNetem = (profile) => {
  if (userspaceShaper) return setUserspaceShaper(profile);
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
  if (userspaceShaper) {
    const { egress, ingress } = JSON.parse(readFileSync("/dev/shm/ar-shape-stats.json", "utf8"));
    return { egress: { packets: egress.shaped, dropped: egress.dropped }, ingress: { packets: ingress.shaped, dropped: ingress.dropped } };
  }
  const stats = (dev) => {
    const text = execFileSync("sudo", ["tc", "-s", "qdisc", "show", "dev", dev], { encoding: "utf8" });
    const netem = text.slice(text.indexOf("qdisc netem"));
    const match = /Sent \d+ bytes (\d+) pkt \(dropped (\d+)/u.exec(netem);
    return match ? { packets: Number(match[1]), dropped: Number(match[2]) } : null;
  };
  return { egress: stats(defaultInterface()), ingress: stats("ifb0") };
};
const clearNetem = () => {
  if (userspaceShaper) return setUserspaceShaper(null);
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
const save = async () => writeFile(`${output}/audio-ready.json`, JSON.stringify(report));
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
  const dir = resolve(root, ".private/audio-ready", name.replaceAll(/\W/gu, "_"));
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
    entryPoints: [resolve(root, "scripts/dev/audio-ready-rig-page.jsx")],
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

// Audio-ready proof. One room per call: an empty-room listener joins first, three speakers join with their microphones on and
// publish, two listeners then join together (their cohort is those three), and a late speaker joins last.
// Every page polls every 50 ms: the SDK's media.audioReadiness, and for each remote microphone the first time its receiver's
// totalAudioEnergy rose above 0, i.e. decoded audio reached the playout element. Wall times are comparable on one box.
const READY_PROBE = () => {
  const probe = (window.arProbe = { joinCalledAt: null, liveAt: null, readiness: [], remoteSeen: {}, audible: {}, energy: {} });
  const tick = async () => {
    const client = window.matrixClient;
    const snapshot = client?.getSnapshot?.();
    if (snapshot) {
      const now = Date.now();
      const state = snapshot.media.audioReadiness;
      if (probe.readiness.at(-1)?.state !== state) probe.readiness.push({ state, at: now });
      if (probe.liveAt === null && snapshot.connection.status === "live") probe.liveAt = now;
      for (const entry of snapshot.media.remote.filter((candidate) => candidate.source === "microphone")) {
        probe.remoteSeen[entry.participantId] ??= now;
        if (probe.audible[entry.participantId]) continue;
        for (const pc of window.matrixPeers) {
          if (pc.connectionState === "closed") continue;
          const receiver = pc.getReceivers().find((candidate) => candidate.track?.id === entry.track.id);
          if (!receiver) continue;
          (await receiver.getStats()).forEach((stat) => {
            if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio") && (stat.totalAudioEnergy ?? 0) > 0) probe.audible[entry.participantId] ??= Date.now();
          });
        }
      }
    }
    setTimeout(tick, 50);
  };
  tick();
};

async function runRoom(run, { chalk, config, getAccessRefreshState, name, conditionName }) {
  const space = await chalk.spaces.create({
    name: `Ready ${name}`,
    slug: `ar-${Date.now().toString(36)}-${conditionName.replaceAll(/\W/gu, "-").toLowerCase()}-${name.replaceAll(/\W/gu, "-")}`.slice(0, 60),
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
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", ...(process.env.AR_TONE ? [`--use-file-for-fake-audio-capture=${process.env.AR_TONE}`] : [])],
  });
  allBrowsers.push(browser);
  const pages = [];
  const join = async (label, role, microphone) => {
    let admission;
    for (let attempt = 1; ; attempt++) {
      try {
        admission = await chalk.participants.admit(space.id, episode.id, { name: label, role });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    let first = true;
    const context = await browser.newContext({ permissions: ["microphone"] });
    await context.addInitScript(browserInstrumentation, { frequency: 400 });
    const page = await context.newPage();
    await page.exposeFunction("matrixAccess", async (request) => {
      if (first) {
        first = false;
        return admission.access;
      }
      return chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(admission.access), request);
    });
    page.on("pageerror", (error) => run.faults.push({ label, kind: "pageerror", message: error.message }));
    await page.goto(config.urls.web);
    await page.evaluate(READY_PROBE);
    const entry = { label, role, page, participantId: null, microphone };
    pages.push(entry);
    await page.evaluate(() => (window.arProbe.joinCalledAt = Date.now()));
    await page.evaluate((cfg) => window.matrixJoin(cfg), { space: space.slug, baseUrl: config.urls.api, syncUrl: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: label, microphone });
    await page.waitForFunction(() => window.matrixClient?.getSnapshot().connection.status === "live", null, { timeout: 120000 });
    entry.participantId = await page.evaluate(() => window.matrixClient.getSnapshot().self.participantId);
    return entry;
  };
  const speakersLive = (entries) => Promise.all(entries.map((entry) => entry.page.waitForFunction(() => window.matrixClient.getSnapshot().media.local.microphone.state === "enabled", null, { timeout: 60000 })));
  try {
    const empty = await join("Listener empty", "collaborator", false);
    await sleep(Number(process.env.AR_EMPTY_OBSERVE_MS || 8000));
    const speakers = [];
    for (let index = 0; index < 3; index++) speakers.push(await join(`Speaker ${index + 1}`, index === 0 ? "owner" : "collaborator", true));
    await speakersLive(speakers);
    await sleep(Number(process.env.AR_FLOW_MS || 6000));
    const cohortListeners = await Promise.all([join("Listener A", "collaborator", false), join("Listener B", "collaborator", false)]);
    run.cohort = speakers.map((entry) => entry.participantId);
    await sleep(Number(process.env.AR_OBSERVE_MS || 25000));
    const late = await join("Late speaker", "collaborator", true);
    run.lateSpeaker = late.participantId;
    await sleep(Number(process.env.AR_LATE_MS || 12000));
    run.listeners = [];
    for (const [kind, entries] of [
      ["empty", [empty]],
      ["cohort", cohortListeners],
    ]) {
      for (const entry of entries) {
        const probe = await entry.page.evaluate(() => window.arProbe);
        run.listeners.push({ kind, label: entry.label, participantId: entry.participantId, probe });
      }
    }
    for (const entry of pages) await entry.page.evaluate(() => window.matrixClient.leave()).catch(() => undefined);
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
