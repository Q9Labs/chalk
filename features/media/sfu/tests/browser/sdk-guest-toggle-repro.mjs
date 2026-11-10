// Three real SDK/Chromium guests against a local node. No external services.
// Run from features/media/sfu: node tests/browser/sdk-guest-toggle-repro.mjs
// SFU_SOURCE_DIR selects a control node checkout; REPRO_ROUNDS defaults to three
// (mic-first, camera-first, staggered concurrent republish). Optional
// REPRO_EVIDENCE_DIR writes private SDP/stats/node logs; never commit that output.
// Uses the production FFT probe: ten consecutive post-unmute tone frames in 5 s.
// RTP/sample counters alone cannot prove the remote track produces audio.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { installFixture } from "../../../../../scripts/prod-proof/fixture.mjs";
import { hearAfterUnmute, proveAudioDecoded } from "../../../../../scripts/prod-proof/audio-decode.mjs";

const identity = "chalk-api.test";
const root = path.resolve(process.cwd(), "../../..");
const source = path.join(root, "sdks/typescript/client/src/media/client.ts");
const requireSDK = createRequire(path.join(root, "sdks/typescript/client/package.json"));
const { build } = requireSDK("esbuild");
const work = mkdtempSync(path.join(tmpdir(), "sfu-sdk-toggle-"));
const evidence = process.env.REPRO_EVIDENCE_DIR;
const rounds = Number(process.env.REPRO_ROUNDS ?? 3);
const results = [];
if (evidence) mkdirSync(evidence, { recursive: true });
const children = [];
const nodeLines = [];
const failures = [];
const publishers = new Map();
const guests = [];
let browser;
let sequence = 0;
let rosterSequence = 0;
let rosterActive = false;

function logResponse(label, status, body, requestDescription) {
  const description = body?.sessionDescription;
  results.push({ type: "signal", label, status, requestSDP: requestDescription?.sdp, responseSDP: description?.sdp, tracks: body?.tracks, errors: body?.trackErrors });
  if (status !== 200 && status !== 204) failures.push(`${label}: status=${status}`);
  for (const error of body?.trackErrors ?? []) failures.push(`${label}: trackError=${error.errorCode}`);
}

async function main() {
  const certs = createPki(work);
  const control = await startService(certs);
  const tenant = { tenantId: "tenant-sdk-toggle", episodeId: "episode-1", generation: 1 };
  for (let index = 0; index < 3; index++) {
    const scope = { ...tenant, participantId: `guest-${index + 1}` };
    const response = await control.post("/v1/sessions", { operationId: `create-${index}`, scope });
    if (response.status !== 200) throw new Error(`create session guest=${index + 1}: ${response.status}`);
    guests.push({ index, scope, connectionId: response.body.connectionId, page: null, started: false });
  }
  const controls = guests.flatMap(({ scope }) => ["microphone", "camera"].map((sourceName) => ({ participantId: scope.participantId, source: sourceName, action: "grant", revision: 1 })));
  const granted = await control.post("/v1/episodes/sources", { tenantId: tenant.tenantId, episodeId: tenant.episodeId, controls });
  if (granted.status !== 200) throw new Error(`grant sources: ${granted.status}`);

  const bundle = await build({
    stdin: {
      contents: `import { CloudflareSFUClient } from ${JSON.stringify(source)}; import { CloudflareSFUError } from ${JSON.stringify(path.join(root, "sdks/typescript/client/src/media/types.ts"))}; window.CloudflareSFUClient = CloudflareSFUClient; window.CloudflareSFUError = CloudflareSFUError;`,
      resolveDir: root,
      sourcefile: "guest-sdk-entry.ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  results.push({ type: "environment", chromium: browser.version(), rounds });
  for (const guest of guests) {
    const context = await browser.newContext();
    guest.page = await context.newPage();
    await guest.page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>local SDK media repro</title>" }));
    await guest.page.goto("http://localhost/");
    await guest.page.evaluate(installFixture, { guest: guest.index, tones: true });
    await guest.page.addScriptTag({ content: bundle.outputFiles[0].text });
    await guest.page.exposeFunction("sfuBridge", (operation, input) => bridge(control, guest, operation, input));
    await guest.page.evaluate(
      async ({ connectionId, participantId }) => {
        window.sfuEvents = [];
        window.sfuErrors = [];
        window.mediaRoster = [];
        window.proofClient = { getSnapshot: () => ({ media: { remote: window.mediaClient.getSnapshot().remoteTracks } }) };
        window.mediaClient = new window.CloudflareSFUClient({
          bootstrap: {
            connectionId,
            iceServers: [],
            capabilities: { serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, pullPublished: false, unifiedSignaling: false, muteInPlace: false },
          },
          participantId,
          pollIntervalMs: 15_000,
          unreportedVideoTileWaitMs: 0,
          peerConnectionFactory(configuration) {
            const pc = (window.sfuPC = new RTCPeerConnection(configuration));
            pc.addEventListener("track", (event) => window.sfuEvents.push({ type: "track", mid: event.transceiver.mid, kind: event.track.kind, id: event.track.id, readyState: event.track.readyState }));
            return pc;
          },
          onRemoteTrack(publication) {
            window.sfuEvents.push({ type: "remote-publication", participantId: publication.participantId, source: publication.source, publicationId: publication.publicationId, kind: publication.track.kind, id: publication.track.id });
          },
          onError(error) {
            window.sfuErrors.push({ name: error.name, message: error.message, code: error.code, status: error.options?.status });
          },
          onDiagnostic(event) {
            window.sfuEvents.push({ type: "diagnostic", ...event });
          },
          transport: {
            async addTracks(input) {
              return checked(await window.sfuBridge("tracks", input));
            },
            async closeTracks(input) {
              return checked(await window.sfuBridge("tracks_close", input));
            },
            async renegotiate(input) {
              checked(await window.sfuBridge("renegotiate", input));
            },
            async listPublications() {
              return checked(await window.sfuBridge("publications", {}));
            },
          },
        });
        window.mediaClient.remoteParticipantsChanged([]);
        function checked(result) {
          if (result.status >= 400) throw new window.CloudflareSFUError(result.body?.message ?? `signaling failed with ${result.status}`, "signaling_failed", { status: result.status });
          if (result.roster) {
            window.mediaRoster = result.roster;
            window.mediaClient.remotePublicationsChanged(result.roster);
          }
          return result.body;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720, frameRate: 30 } });
        await window.mediaClient.start(stream);
      },
      { connectionId: guest.connectionId, participantId: guest.scope.participantId },
    );
    guest.started = true;
    console.log(`SDK_START guest=${guest.index + 1} status=live`);
  }

  rosterActive = true;
  await publishRosterToAll();
  await Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(
        (participantIds) => window.mediaClient.remoteParticipantsChanged(participantIds),
        guests.filter((other) => other !== guest).map((other) => other.scope.participantId),
      ),
    ),
  );
  await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.mediaClient.refreshRemotePublications())));
  await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 12_000, "initial four remote tracks per guest");
  const proofGuests = { pages: guests.map((g) => g.page), participants: guests.map((g) => g.scope.participantId), tones: true };
  await proveAudioDecoded(proofGuests, { timeoutMs: 12_000 });
  console.log("INITIAL all six pairs decode their speaker's tone");
  await record("initial");
  // A suspended tone source must fail the exact decode probe, even with a live receiver.
  await guests[0].page.evaluate(async () => {
    await window.proofAudio.context.suspend();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const negative = await hearAfterUnmute(proofGuests, 0, { turnedOnAt: Date.now(), timeoutMs: 1500 });
  if (negative.some((v) => v.pass)) throw new Error("decode probe accepted digital silence");
  await guests[0].page.evaluate(() => window.proofAudio.context.resume());
  await proveAudioDecoded(proofGuests, { timeoutMs: 5000 });
  console.log("NEGATIVE digital silence rejected by both listeners");

  for (let round = 0; round < rounds; round++) {
    const order = round % 3 === 1 ? ["camera", "microphone"] : ["microphone", "camera"];
    await record(`round-${round + 1}-before-off`);
    await Promise.all(
      guests.map(async (guest) => {
        for (const source of order) await setTarget(guest, source, false);
      }),
    );
    await waitForSnapshots((snapshot) => snapshot.remote.length === 0, 8000, "all remote receivers retired");
    await record(`round-${round + 1}-off`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const turnedOn = [];
    const resume = async (guest) => {
      if (round % 3 === 2) await new Promise((resolve) => setTimeout(resolve, ((guest.index + round) % 3) * 80));
      for (const source of order) {
        if (source === "microphone") turnedOn[guest.index] = Date.now();
        await setTarget(guest, source, true);
      }
    };
    await Promise.all(guests.map(resume));
    await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 15000, "remote tracks re-pulled");
    const before = await record(`round-${round + 1}-resumed`);
    const verdicts = (await Promise.all(guests.map((guest) => hearAfterUnmute(proofGuests, guest.index, { turnedOnAt: turnedOn[guest.index] })))).flat();
    const after = await record(`round-${round + 1}-decoded`);
    results.push({ type: "decode", round: round + 1, verdicts, before, after });
    for (const verdict of verdicts) {
      console.log(`DECODE round=${round + 1} pair=${verdict.listener}->${verdict.speaker} pass=${verdict.pass} peakDb=${verdict.peakDb} sustained=${verdict.sustainedFrames}`);
      if (!verdict.pass) failures.push(`round=${round + 1} pair=${verdict.listener}->${verdict.speaker} no decoded tone`);
    }
    for (let i = 0; i < after.length; i++) {
      for (const track of after[i].remote.filter((t) => t.source === "camera")) {
        const previous = before[i].remote.find((t) => t.participantId === track.participantId && t.source === "camera");
        if (!track.stats.some((stat) => stat.framesDecoded > (previous?.stats.find((old) => old.ssrc === stat.ssrc)?.framesDecoded ?? 0))) {
          failures.push(`round=${round + 1} guest=${i + 1} camera from ${track.participantId} no decoded frames`);
        }
      }
    }
    if (failures.length) break;
  }
  console.log(`RESULT ${failures.length ? `FAIL ${JSON.stringify(failures)}` : `PASS ${rounds} rounds, six audio and video pairs per round`}`);
  if (failures.length) process.exitCode = 1;
}

async function record(label) {
  const states = await Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(async () => {
        const pc = window.sfuPC;
        const remote = await Promise.all(
          window.mediaClient.getSnapshot().remoteTracks.map(async (track) => {
            const transceiver = pc.getTransceivers().find((t) => t.receiver.track === track.track);
            const stats = transceiver ? [...(await transceiver.receiver.getStats()).values()].filter((s) => s.type === "inbound-rtp") : [];
            return { participantId: track.participantId, source: track.source, mid: transceiver?.mid, readyState: track.track.readyState, enabled: track.track.enabled, muted: track.track.muted, stats };
          }),
        );
        return {
          remote,
          localSDP: pc.localDescription?.sdp,
          remoteSDP: pc.remoteDescription?.sdp,
          transceivers: pc.getTransceivers().map((t) => ({ mid: t.mid, direction: t.direction, currentDirection: t.currentDirection, receiverId: t.receiver.track.id, muted: t.receiver.track.muted, readyState: t.receiver.track.readyState })),
          events: window.sfuEvents,
          errors: window.sfuErrors,
        };
      }),
    ),
  );
  results.push({ type: "state", label, states });
  return states;
}

async function setTarget(guest, sourceName, enabled) {
  const result = await guest.page.evaluate(
    async ({ source, enabled, participantId }) => {
      const started = performance.now();
      const target = { operationId: `toggle-${source}-${enabled}-${Date.now()}`, participantId, source, enabled };
      if (!enabled) {
        await window.mediaClient.setLocalSourceIntent(source, false, "user_pause");
      } else {
        window.mediaClient.setLocalSourceIntent(source, true);
        if (source === "camera") {
          await window.mediaClient.clearPreparedLocalTrack("camera", { stopTrack: false });
          const capture = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } });
          window.mediaClient.prepareLocalTrack("camera", capture.getVideoTracks()[0]);
        }
      }
      const outcome = await window.mediaClient.setLocalPublicationTarget(target);
      return { ...outcome, durationMs: performance.now() - started, snapshot: window.mediaClient.getSnapshot() };
    },
    { source: sourceName, enabled, participantId: guest.scope.participantId },
  );

  if (enabled && result.outcome !== "confirmed" && result.outcome !== "satisfied") failures.push(`guest=${guest.index + 1} ${sourceName}-on outcome=${result.outcome} code=${result.errorCode}`);
  return result;
}

async function snapshots() {
  return Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(() => {
        const snapshot = window.mediaClient.getSnapshot();
        return {
          connection: snapshot.connection,
          local: snapshot.localTracks.map((track) => ({ source: track.source, enabled: track.enabled, publicationId: track.publicationId })),
          remote: snapshot.remoteTracks.map((track) => ({ participantId: track.participantId, source: track.source, publicationId: track.publicationId, readyState: track.track.readyState })),
          failure: snapshot.failure,
        };
      }),
    ),
  );
}

async function waitForSnapshots(predicate, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < until) {
    latest = await snapshots();
    if (latest.every(predicate)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  results.push({ type: "timeout", label, latest });
  failures.push(`timed out: ${label}`);
  return latest;
}

function registrySnapshot() {
  return { incarnation: 1, sequence: rosterSequence, publications: [...publishers.values()].map(({ participantId, source, publicationId }) => ({ participantId, source, publicationId })) };
}

async function publishRosterToAll(exceptGuest) {
  const roster = registrySnapshot().publications.map((publication) => ({ ...publication, enabled: true }));
  await Promise.all(guests.filter((guest) => guest.started && guest !== exceptGuest).map((guest) => guest.page.evaluate((rows) => window.mediaClient.remotePublicationsChanged(rows), roster)));
}

async function bridge(control, guest, operation, input) {
  if (operation === "publications") return { status: 200, body: registrySnapshot() };
  const operationId = `sdk-${guest.index}-${++sequence}`;
  const { connectionId: _connectionId, allowPartialRemoteTracks: _partial, ...request } = input;
  if (operation === "tracks_close") request.tracks = (input.tracks ?? []).map(({ mid }) => ({ mid }));
  const body = { ...request, operationId, scope: guest.scope };
  const route = operation === "tracks" ? `/v1/sessions/${guest.connectionId}/tracks` : operation === "tracks_close" ? `/v1/sessions/${guest.connectionId}/tracks/close` : `/v1/sessions/${guest.connectionId}/renegotiate`;
  const response = await control.post(route, body);
  let responseBody = response.body;
  logResponse(`${operation} guest=${guest.index + 1}`, response.status, responseBody, input.sessionDescription);

  if (operation === "tracks" && response.status === 200) {
    for (const track of input.tracks ?? []) {
      if (track.location !== "local") continue;
      const returned = responseBody?.tracks?.find((item) => item.mid === track.mid && item.trackName === track.trackName);
      if (!returned) continue;
      const publicationId = `${guest.connectionId}|${track.trackName}`;
      publishers.set(publicationId, { participantId: guest.scope.participantId, source: track.source, publicationId, connectionId: guest.connectionId, trackName: track.trackName, mid: track.mid });
      responseBody.tracks = responseBody.tracks.map((item) => (item.mid === track.mid && item.trackName === track.trackName ? { ...item, publicationId } : item));
      rosterSequence++;
    }
  }
  if (operation === "tracks_close" && response.status === 200 && !input.receiveOnly) {
    for (const item of input.tracks ?? []) {
      const found = [...publishers].find(([, publication]) => publication.connectionId === guest.connectionId && publication.mid === item.mid);
      if (found) publishers.delete(found[0]);
      rosterSequence++;
    }
  }
  const roster = registrySnapshot().publications.map((publication) => ({ ...publication, enabled: true }));
  if (rosterActive && (operation !== "tracks_close" || !input.receiveOnly)) void publishRosterToAll(guest);
  return { status: response.status, body: responseBody, ...(rosterActive ? { roster } : {}) };
}

async function startService(certs) {
  const binary = path.join(work, "sfu");
  const sourceDir = process.env.SFU_SOURCE_DIR ?? process.cwd();
  execFileSync("go", ["build", "-o", binary, "./cmd/sfu"], { cwd: sourceDir, stdio: "inherit" });
  const controlPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const sfu = spawn(binary, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SFU_CONTROL_ADDR: `127.0.0.1:${controlPort}`,
      SFU_UDP_ADDR: `127.0.0.1:${udpPort}`,
      SFU_ANNOUNCE_IPS: "127.0.0.1",
      SFU_ICE_LOOPBACK: "true",
      SFU_TLS_CERT_FILE: certs.server.cert,
      SFU_TLS_KEY_FILE: certs.server.key,
      SFU_CLIENT_CA_FILE: certs.ca,
      SFU_CLIENT_IDENTITY: identity,
      SFU_SOURCE_LEASE_TTL: "2m",
    },
  });
  for (const stream of [sfu.stdout, sfu.stderr]) stream.setEncoding("utf8").on("data", (data) => nodeLines.push(...data.split(/\r?\n/).filter(Boolean)));
  children.push(sfu);
  const control = controlClient(controlPort, certs);
  await waitForReady(control, 15_000);
  return control;
}

function createPki(directory) {
  const run = (...args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "inherit"] });
  const ca = { key: path.join(directory, "ca.key"), cert: path.join(directory, "ca.pem") };
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ca.key);
  run("req", "-new", "-x509", "-key", ca.key, "-sha256", "-days", "1", "-subj", "/CN=sfu-browser-ca", "-out", ca.cert, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  const issue = (name, san, usage) => {
    const files = { key: path.join(directory, `${name}.key`), csr: path.join(directory, `${name}.csr`), cert: path.join(directory, `${name}.pem`), ext: path.join(directory, `${name}.ext`) };
    run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", files.key);
    run("req", "-new", "-key", files.key, "-subj", `/CN=${name}`, "-out", files.csr);
    writeFileSync(files.ext, `subjectAltName=${san}\nextendedKeyUsage=${usage}\nkeyUsage=digitalSignature\n`);
    run("x509", "-req", "-in", files.csr, "-CA", ca.cert, "-CAkey", ca.key, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", files.ext, "-out", files.cert);
    return { key: files.key, cert: files.cert };
  };
  return { ca: ca.cert, server: issue("server", "DNS:localhost,IP:127.0.0.1", "serverAuth"), client: issue("client", `DNS:${identity}`, "clientAuth") };
}

function controlClient(port, certs) {
  const options = { host: "127.0.0.1", port, servername: "localhost", ca: readFileSync(certs.ca), cert: readFileSync(certs.client.cert), key: readFileSync(certs.client.key) };
  const send = (method, route, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = https.request({ ...options, method, path: route, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined });
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
  return { get: (route) => send("GET", route), post: (route, body) => send("POST", route, body) };
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function waitForReady(control, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await control.get("/readyz").catch(() => ({ status: 0 }))).status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SFU did not become ready");
}

async function cleanup() {
  if (evidence) {
    writeFileSync(path.join(evidence, "browser.json"), JSON.stringify(results));
    writeFileSync(path.join(evidence, "node.log"), nodeLines.join("\n"));
  }
  await browser?.close().catch(() => undefined);
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve()));
  }
  rmSync(work, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  console.error(error.message.replace(/https?:\/\/\S+/g, "<endpoint>"));
  process.exitCode = 1;
} finally {
  await cleanup();
}
