// Linux/Instabox only. Local API + Sync and a development Cloudflare SFU app. Never production.
// Classroom pattern: N participants join muted with cameras off, then speakers unmute. Each listener is
// sampled once per second per remote speaker through the whole ladder: roster, remote publication, track,
// inbound bytes, audioLevel, bound audio element, element paused, play() result.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
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
// netem is applied to the default interface only, so browser-to-local-API/Sync traffic on lo is untouched.
const conditions = {
  open: { netem: null, kill: false },
  netem: { netem: "delay 150ms 30ms loss 1.5%", kill: false },
  kill: { netem: null, kill: true },
  netemKill: { netem: "delay 150ms 30ms loss 1.5%", kill: true },
  slow: { netem: "delay 250ms 40ms loss 2%", kill: false },
};

const want = (process.env.SR_BUILDS || "5.2.6,master,pr716,pr708").split(",");
const wantConditions = (process.env.SR_CONDITIONS || "open,netem,netemKill").split(",");
const runsPerCell = Number(process.env.SR_RUNS || 2);
const participantsCount = Number(process.env.SR_N || 8);
const speakerCount = Number(process.env.SR_SPEAKERS || 4);
const runSeconds = Number(process.env.SR_SECONDS || 95);
const killDelayMs = Number(process.env.SR_KILL_DELAY_MS || 5000);
const output = resolve(root, process.env.SR_OUTPUT || "artifacts/silence-repro");
await mkdir(output, { recursive: true });
assert.ok(want.every((name) => Object.hasOwn(builds, name)));
assert.ok(wantConditions.every((name) => Object.hasOwn(conditions, name)));

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

const defaultInterface = () => execFileSync("sh", ["-c", "ip route show default | awk '{print $5; exit}'"], { encoding: "utf8" }).trim();
const setNetem = (netem) => {
  const dev = defaultInterface();
  clearNetem();
  if (netem) execFileSync("sudo", ["tc", "qdisc", "add", "dev", dev, "root", "netem", ...netem.split(" ")]);
};
const clearNetem = () => {
  try {
    execFileSync("sudo", ["tc", "qdisc", "del", "dev", defaultInterface(), "root"], { stdio: "ignore" });
  } catch {}
};

function browserInstrumentation({ frequency }) {
  window.matrixErrors = [];
  window.matrixPeers = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      window.matrixPeers.push(this);
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

async function runBuild(name) {
  const spec = builds[name];
  const dir = resolve(root, ".private/silence-repro", name);
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
    for (const conditionName of wantConditions)
      for (let runIndex = 0; runIndex < runsPerCell; runIndex++) {
        const condition = conditions[conditionName];
        setNetem(condition.netem);
        const run = { build: name, serverSha, sdkSha, condition: conditionName, netem: condition.netem, kill: condition.kill, runIndex, started: new Date().toISOString(), network: [], actions: [], samples: [], faults: [], kills: [] };
        report.runs.push(run);
        try {
          await runRoom(run, { chalk, config, getAccessRefreshState, name, conditionName });
        } catch (error) {
          run.error = error.message;
          console.log(`Run failed ${name}/${conditionName}/${runIndex}: ${error.message}`);
        } finally {
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

async function runRoom(run, { chalk, config, getAccessRefreshState, name, conditionName }) {
  const space = await chalk.spaces.create({ name: `Silence ${name}`, slug: `sr-${name.replaceAll(/\W/gu, "-")}-${conditionName.toLowerCase()}-${Date.now()}`, mediaPlane: "cf_sfu", defaultEpisodeDurationSeconds: 3600, maximumEpisodeDurationSeconds: 7200, lingerWindowSeconds: 600 });
  const episode = await chalk.episodes.create(space.id, {});
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SR_CHROMIUM || undefined, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  allBrowsers.push(browser);
  const origin = Date.now();
  const ids = new Map();
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
        page.on("pageerror", (error) => run.faults.push({ at: Date.now() - origin, participant: index, kind: "pageerror", message: error.message }));
        page.on("response", async (response) => {
          const path = new URL(response.url()).pathname;
          if (!/media\//u.test(path)) return;
          let body = {};
          try {
            body = await response.json();
          } catch {}
          const input = response.request().postDataJSON();
          const connectionId = input?.connection_id ?? null;
          if (connectionId) connections[index].add(connectionId);
          const entry = {
            at: Date.now() - origin,
            startedAt: Math.round(response.request().timing().startTime - origin),
            participant: index,
            method: response.request().method(),
            path: path.replace(/\/[0-9a-f-]{20,}/gu, "/:id"),
            status: response.status(),
            locations: input?.tracks?.map((track) => track.location).join(",") ?? null,
            connectionNumber: connectionId ? [...connections[index]].indexOf(connectionId) + 1 : null,
            errorCode: body.code ?? body.error?.code ?? body.errorCode ?? null,
            trackErrors: (body.trackErrors ?? body.tracks?.filter((track) => track.errorCode || track.errorDescription))?.map((track) => track.code ?? track.errorCode ?? "unknown"),
          };
          run.network.push(entry);
          // First local publish by this participant's first SFU session: schedule the session kill.
          if (run.kill && entry.method === "POST" && entry.locations === "local" && entry.status < 300 && connectionId && !killed.has(index)) {
            killed.add(index);
            setTimeout(() => killSession(run, origin, index, connectionId), killDelayMs);
          }
        });
        await page.goto(config.urls.web);
        await page.evaluate((cfg) => window.matrixJoin(cfg), { space: space.slug, baseUrl: config.urls.api, syncUrl: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: `Synthetic ${index}`, microphone: false });
        await page.waitForFunction(() => window.matrixClient?.getSnapshot().connection.status === "live", null, { timeout: 120000 });
        ids.set(await page.evaluate(() => window.matrixClient.getSnapshot().self.participantId), index);
        participants[index] = { context, page };
      }),
    );
    run.joinSeconds = (Date.now() - origin) / 1000;
    const start = Date.now();
    const schedule = [];
    for (let speaker = 0; speaker < speakerCount; speaker++) {
      schedule.push({ at: 3 + speaker * 7, participant: speaker, kind: "unmute", first: true });
      schedule.push({ at: 55 + speaker * 8, participant: speaker, kind: "mute" }, { at: 59 + speaker * 8, participant: speaker, kind: "unmute", first: false });
    }
    schedule.sort((a, b) => a.at - b.at);
    run.speakerCount = speakerCount;
    let cursor = 0;
    while ((Date.now() - start) / 1000 < runSeconds) {
      const t = (Date.now() - start) / 1000;
      while (cursor < schedule.length && schedule[cursor].at <= t) {
        const action = schedule[cursor++];
        const event = { ...action, t, clickedAtMs: Date.now() - origin };
        run.actions.push(event);
        try {
          await participants[action.participant].page.locator("#mic").click({ timeout: 3000 });
        } catch (error) {
          event.error = error.message;
        }
      }
      const states = await Promise.all(
        participants.map(async ({ page }, listener) => {
          try {
            const sample = await page.evaluate(() => window.srSample());
            return { listener, status: sample.status, mic: sample.mic, roster: sample.roster.map((id) => ids.get(id)), errors: sample.errors, remote: sample.remote.map((entry) => ({ ...entry, speaker: ids.get(entry.speaker) })) };
          } catch (error) {
            return { listener, error: error.message, remote: [] };
          }
        }),
      );
      run.samples.push({ t: (Date.now() - start) / 1000, atMs: Date.now() - origin, states });
      await sleep(1000);
    }
    run.sessionsPerParticipant = connections.map((set) => set.size);
    for (const { page } of participants) await page.evaluate(() => window.matrixClient.leave()).catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
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
