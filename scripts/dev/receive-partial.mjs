// Linux/Instabox only. Local API + Sync and development Cloudflare SFU. Never production.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor } from "./chalk.mjs";
import { revisions } from "./receive-partial-prepare.mjs";

const root = resolve(import.meta.dirname, "../..");
const requireConsumer = createRequire(resolve(root, "tools/sdk-web-consumer-e2e/package.json"));
const { build } = requireConsumer("esbuild");
const { chromium } = requireConsumer("playwright");
const output = resolve(root, process.env.CHALK_PARTIAL_OUTPUT || "artifacts/receive-partial");
await mkdir(output, { recursive: true });
const duration = Number(process.env.CHALK_PARTIAL_SECONDS || 150);
assert.ok(duration >= 60 && duration <= 1200);
const versions = (process.env.CHALK_PARTIAL_VERSIONS || "master-1,fixed-1,master-2,fixed-2,master-3,fixed-3").split(",");
assert.ok(versions.every((version) => Object.hasOwn(revisions, version) && version !== "server"));
const credentialPath = process.env.CHALK_DEVELOPMENT_CREDENTIALS || "/root/chalk-development.json";
const credentials = JSON.parse(await readFile(credentialPath, "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
const serverRoot = root;
let systemToken, tenant, space;
const config = resolveDevConfig({
  root: serverRoot,
  env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "600000", CHALK_DEV_WEB_PORT: "4870" },
  requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"],
  secretResolver: async () => credentials,
});
config.webJoinPath = "/synthetic";
config.databaseName = process.env.CHALK_PARTIAL_DB || "chalk_audio_mute_matrix";
assert.match(config.databaseName, /^[a-z_]+$/u);
const services = [
  { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${serverRoot}/apps/api`, readiness: { url: `${config.urls.api}/readyz` } },
  { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${serverRoot}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` } },
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
const report = {
  started: new Date().toISOString(),
  serverRevision: revisions.server,
  serverDescription: "Fixed local server with receive-only close support; dedicated development SFU",
  durationSeconds: duration,
  sampleIntervalSeconds: 0.25,
  profile: "single-receiver-publication-close",

  machine: { cores: execFileSync("nproc", { encoding: "utf8" }).trim(), uptime: execFileSync("uptime", { encoding: "utf8" }).trim() },
  versions: [],
};
let http;
let bundle = "";
const allBrowsers = [];
await build({ entryPoints: [resolve(root, "sdks/typescript/client/src/server/index.ts")], bundle: true, outfile: `${output}/server-client.mjs`, platform: "node", format: "esm" });
const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(`${output}/server-client.mjs`).href);

// Browser instrumentation measures actual receiver stats, never the sender's UI state alone.
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
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
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
      // Retain the graph for the lifetime of the synthetic participant.
      (window.matrixToneGraphs ??= []).push({ context, oscillator, destination });
    }
    if (constraints.video) {
      const video = await nativeCapture({ video: constraints.video });
      video.getVideoTracks().forEach((track) => stream.addTrack(track));
    }
    return stream;
  };
  window.matrixSample = async () => {
    const snapshot = window.matrixClient.getSnapshot();
    const tracks = [];
    for (const remote of snapshot.media.remote.filter((remote) => remote.source === "microphone")) {
      for (const pc of window.matrixPeers) {
        if (pc.connectionState === "closed") continue;
        const receiver = pc.getReceivers().find((receiver) => receiver.track === remote.track);
        if (!receiver) continue;
        const stats = await receiver.getStats();
        stats.forEach((stat) => {
          if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio"))
            tracks.push({
              speaker: remote.participantId,
              track: remote.track.id,
              packets: stat.packetsReceived || 0,
              audioLevel: stat.audioLevel ?? null,
              energy: stat.totalAudioEnergy ?? null,
              readyState: remote.track.readyState,
              muted: remote.track.muted,
            });
        });
      }
    }
    return { connection: snapshot.connection.status, microphone: snapshot.media.local.microphone.state, participant: snapshot.self.participantId, peerConnections: window.matrixPeers.length, tracks, errors: window.matrixErrors.splice(0), commandError: window.matrixCommandError ?? null };
  };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const save = async () => writeFile(`${output}/matrix.json`, JSON.stringify(report, null, 2));
try {
  console.log("Starting isolated, pinned server stack.");
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  assert.ok(tenant && space && systemToken);
  const chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: tenant.id, apiKey: systemToken });
  http = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<html><body><main id="root"></main><script>${bundle}</script></body></html>`);
  });
  http.listen(config.ports.web, "127.0.0.1");
  await once(http, "listening");
  for (const version of versions) {
    console.log(`Starting SDK ${version}.`);
    const sdkRoot = resolve(root, ".private/receive-partial", version, "sdks/typescript");
    const clientEntry = `${sdkRoot}/client/src/index.ts`;
    const effectEntry = `${sdkRoot}/client/src/effect.ts`;
    const aliases = {
      "@q9labsai/chalk-client/effect": effectEntry,
      "@q9labsai/chalk-client": clientEntry,
    };
    const built = await build({
      entryPoints: [resolve(root, "tools/sdk-web-consumer-e2e/consumer/receive-partial.jsx")],
      alias: aliases,
      plugins: [
        {
          name: "pinned-react-controls",
          setup(builder) {
            const sources = {
              "../../../sdks/typescript/react/src/bindings/context": `${sdkRoot}/react/src/bindings/context.tsx`,
              "../../../sdks/typescript/react/src/bindings/hooks": `${sdkRoot}/react/src/bindings/hooks.ts`,
              "../../../sdks/typescript/react/src/components/control-bar/control-bar-behavior": `${sdkRoot}/react/src/components/control-bar/control-bar-behavior.ts`,
            };
            builder.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/sdks\/typescript\/react\/src\// }, ({ path }) => (sources[path] ? { path: sources[path] } : undefined));
          },
        },
      ],
      nodePaths: [resolve(root, "node_modules"), resolve(root, "sdks/typescript/client/node_modules"), resolve(root, "sdks/typescript/react/node_modules"), resolve(root, "tools/sdk-web-consumer-e2e/node_modules")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
    });
    bundle = built.outputFiles[0].text;
    // Each version gets a fresh Space; the stack and SFU app are held fixed.
    const fixtureSpace = await chalk.spaces.create({ name: `Synthetic audio ${version}`, slug: `audio-${version.replaceAll(".", "-")}-${Date.now()}`, mediaPlane: "cf_sfu", defaultEpisodeDurationSeconds: 3600, maximumEpisodeDurationSeconds: 7200, lingerWindowSeconds: 600 });
    const episode = await chalk.episodes.create(fixtureSpace.id, {});
    const run = { version, sdkRevision: revisions[version], started: new Date().toISOString(), network: [], actions: [], samples: [], faults: [] };
    const logOffset = (await readFile(config.aggregateLog, "utf8")).length;
    report.versions.push(run);
    const participants = [];
    const ids = new Map();
    const connections = [new Set(), new Set(), new Set(), new Set()];
    const intents = [true, true, true, true];
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    allBrowsers.push(browser);
    const origin = Date.now();
    for (let index = 0; index < 4; index++) {
      const admission = await chalk.participants.admit(fixtureSpace.id, episode.id, { name: index === 0 ? "Synthetic teacher" : `Synthetic student ${index}`, role: index === 0 ? "owner" : "collaborator" });
      let access = admission.access;
      assert.ok(access, "synthetic participant must be admitted");
      connections[index].add(access.media.client_payload.connectionId);
      let firstAccess = true;
      let accessQueue = Promise.resolve();
      const context = await browser.newContext({ permissions: ["camera", "microphone"] });
      await context.addInitScript(browserInstrumentation, { frequency: [440, 660, 880, 1100][index] });
      const page = await context.newPage();
      await page.exposeFunction("matrixAccess", (request) => {
        const next = accessQueue.then(async () => {
          if (firstAccess) firstAccess = false;
          else access = await chalk.participants.issueAccess(fixtureSpace.id, episode.id, admission.participant.id, getAccessRefreshState(access), request);
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
        let body;
        try {
          body = await response.json();
        } catch {
          body = {};
        }
        const input = response.request().postDataJSON();
        if (input?.connection_id) connections[index].add(input.connection_id);
        run.network.push({
          at: Date.now() - origin,
          participant: index,
          path: path.replace(/\/[0-9a-f-]{20,}/gu, "/:id"),
          status: response.status(),
          operation: input?.tracks?.map((track) => track.location).join(",") ?? null,
          receiveOnly: input?.receive_only === true,
          replacementCause: new URL(response.url()).searchParams.get("replacement_cause"),
          connectionNumber: input?.connection_id ? [...connections[index]].indexOf(input.connection_id) + 1 : null,
          hasConnection: Boolean(body.connection_id || body.connectionId),
          errorCode: body.code ?? body.error?.code ?? null,
        });
        const trackErrors = body.trackErrors?.map((track) => ({ code: track.code ?? null })) ?? body.tracks?.filter((track) => track.errorCode || track.errorDescription).map((track) => ({ location: track.location, code: track.errorCode ?? null }));
        if (trackErrors?.length) run.network.at(-1).trackErrors = trackErrors;
      });
      await page.goto(config.urls.web);
      await page.evaluate((config) => window.matrixJoin(config), { space: fixtureSpace.slug, baseUrl: config.urls.api, syncUrl: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: `Synthetic ${index}` });
      await page.waitForFunction(() => window.matrixClient?.getSnapshot().connection.status === "live", null, { timeout: 90000 });
      const id = await page.evaluate(() => window.matrixClient.getSnapshot().self.participantId);
      ids.set(id, index);
      participants.push({ context, page });
    }
    run.joinSeconds = (Date.now() - origin) / 1000;
    const start = Date.now();
    const schedule = [];
    for (let index = 0; index < 4; index++) {
      const at = 10 + index * 8;
      schedule.push({ at, participant: index, kind: "mic", enabled: false }, { at: at + 4, participant: index, kind: "mic", enabled: true });
    }
    schedule.push({ at: 60, participant: 1, kind: "partial", enabled: true });
    for (const [at, participant] of [
      [90, 0],
      [110, 3],
    ])
      schedule.push({ at, participant, kind: "mic", enabled: false }, { at: at + 4, participant, kind: "mic", enabled: true });
    schedule.sort((a, b) => a.at - b.at);
    let cursor = 0;
    while ((Date.now() - start) / 1000 < duration) {
      const t = (Date.now() - start) / 1000;
      while (cursor < schedule.length && schedule[cursor].at <= t) {
        const action = schedule[cursor++];
        const event = { ...action, t: (Date.now() - start) / 1000 };
        run.actions.push(event);
        try {
          if (action.kind === "partial") {
            const speaker = [...ids].find(([, index]) => index === 2)[0];
            const mid = await participants[1].page.evaluate((speaker) => {
              const remote = window.matrixClient.getSnapshot().media.remote.find((track) => track.participantId === speaker && track.source === "microphone");
              for (const pc of window.matrixPeers) {
                if (pc.connectionState === "closed") continue;
                const transceiver = pc.getTransceivers().find((item) => item.receiver.track === remote?.track);
                if (transceiver) return transceiver.mid;
              }
            }, speaker);
            assert.ok(mid !== undefined && mid !== null, "fault requires the exact receive MID");
            const connection = [...connections[1]].at(-1);
            const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${credentials.appId}/sessions/${connection}/tracks/close`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${credentials.appSecret}`, "Content-Type": "application/json" },
              body: JSON.stringify({ force: true, tracks: [{ mid }] }),
            });
            const body = await response.json();
            assert.equal(response.status, 200);
            assert.ok(!body.errorCode && body.tracks?.every((track) => !track.errorCode), "provider must accept the targeted fault");
            run.partialFault = { t: (Date.now() - start) / 1000, listener: 1, speaker: 2, mid };
          } else {
            if (action.kind === "mic") intents[action.participant] = action.enabled;
            const actor = action.participant;
            await participants[actor].page.locator(`#${action.kind}`).click({ timeout: 3000 });
          }
        } catch (error) {
          event.error = error.message;
        }
      }
      const states = await Promise.all(
        participants.map(async ({ page }, listener) => {
          try {
            const sample = await page.evaluate(() => window.matrixSample());
            return { listener, ...sample, participant: ids.get(sample.participant), tracks: sample.tracks.map((track) => ({ ...track, speaker: ids.get(track.speaker) })) };
          } catch (error) {
            return { listener, error: error.message, tracks: [] };
          }
        }),
      );
      run.samples.push({ t: (Date.now() - start) / 1000, expected: [...intents], states });
      if (run.samples.length % 120 === 0) {
        await save();
        console.log(`SDK ${version}: ${Math.round(t)} seconds, ${run.actions.length} actions.`);
      }
      await sleep(250);
    }
    run.sessionsPerParticipant = connections.map((connections) => connections.size);
    run.receiverAllocations = await Promise.all(
      connections.map(async (sessions) => {
        const connection = [...sessions].at(-1);
        const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${credentials.appId}/sessions/${connection}`, { headers: { Authorization: `Bearer ${credentials.appSecret}` } });
        const body = await response.json();
        return { status: response.status, remote: body.tracks?.filter((track) => track.location === "remote").map(({ mid, status }) => ({ mid, status })) };
      }),
    );
    run.providerFailures = (await readFile(config.aggregateLog, "utf8"))
      .slice(logOffset)
      .split("\n")
      .filter((line) => line.includes("cloudflare_sfu.request_failed"))
      .map((line) => {
        let entry;
        try {
          entry = JSON.parse(line.slice(line.indexOf("{")));
        } catch {
          entry = {};
        }
        return Object.fromEntries(["time", "operation", "http_status", "failure_stage", "provider_code", "provider_raw_code", "request_local_track_count", "request_remote_track_count"].map((key) => [key, entry[key] ?? line.match(new RegExp(`\\b${key}=([^ ]+)`))?.[1] ?? null]));
      });
    await save();
    for (const { page } of participants) await page.evaluate(() => window.matrixClient.leave()).catch((error) => run.faults.push({ kind: "leave", message: error.message }));
    await browser.close();
    run.completed = new Date().toISOString();
    await save();
    console.log(`Completed SDK ${version}.`);
  }
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  await save();
  throw error;
} finally {
  await Promise.all(allBrowsers.map((browser) => browser.close()));
  await runtime.stop();
  if (http) await new Promise((resolve) => http.close(resolve));
  await save();
}
