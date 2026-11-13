// Local end-to-end reproducer: the real TypeScript media client in three
// headless Chromium guests, talking to the real SFU over its control API.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const identity = "chalk-api.test";
const root = path.resolve(process.cwd(), "../../..");
const source = path.join(root, "sdks/typescript/client/src/media/client.ts");
const requireSDK = createRequire(path.join(root, "sdks/typescript/client/package.json"));
const { build } = requireSDK("esbuild");
const work = mkdtempSync(path.join(tmpdir(), "sfu-sdk-toggle-"));
const children = [];
const nodeLines = [];
const failures = [];
const publishers = new Map();
const guests = [];
let browser;
let sequence = 0;
let rosterSequence = 0;
let rosterActive = false;

function sdpMids(sdp) {
  const sections = [];
  let section;
  for (const line of (sdp ?? "").split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      if (section) sections.push(section);
      const [kind, port] = line.slice(2).split(/\s+/, 2);
      section = { kind, port, mid: "?", direction: "sendrecv" };
    } else if (section && line.startsWith("a=mid:")) section.mid = line.slice(6);
    else if (section && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) section.direction = line.slice(2);
  }
  if (section) sections.push(section);
  return sections.map(({ mid, kind, direction, port }) => `${mid}:${kind}/${port === "0" ? "rejected" : direction}`).join(",");
}

function sdpVideoExtmaps(sdp) {
  const sections = [];
  let section;
  for (const line of (sdp ?? "").split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      if (section) sections.push(section);
      section = { video: line.startsWith("m=video "), mid: "?", extmaps: [] };
    } else if (section && line.startsWith("a=mid:")) section.mid = line.slice(6);
    else if (section?.video && line.startsWith("a=extmap:")) section.extmaps.push(line.slice(line.indexOf(" ") + 1));
  }
  if (section) sections.push(section);
  return sections.filter((item) => item.video).map(({ mid, extmaps }) => `${mid}:${extmaps.join("|")}`).join(",");
}

function logResponse(label, status, body, requestDescription) {
  const description = body?.sessionDescription;
  const tracks = (body?.tracks ?? []).map(({ mid, trackName, source, sessionId }) => ({ mid, trackName, source, sessionId }));
  const errors = body?.trackErrors ?? [];
  const error = status !== 200 && status !== 204 ? ` error=${JSON.stringify(body)}` : "";
  console.log(`SIGNAL ${label} status=${status} requestSDP=${requestDescription ? `${requestDescription.type}[${sdpMids(requestDescription.sdp)}]` : "none"} requestVideoExtmaps=${requestDescription ? `[${sdpVideoExtmaps(requestDescription.sdp)}]` : "none"} responseSDP=${description ? `${description.type}[${sdpMids(description.sdp)}]` : "none"} responseVideoExtmaps=${description ? `[${sdpVideoExtmaps(description.sdp)}]` : "none"} tracks=${JSON.stringify(tracks)} trackErrors=${JSON.stringify(errors)}${error}`);
  if (status !== 200 && status !== 204) failures.push(`${label}: status=${status}`);
  for (const error of errors) failures.push(`${label}: trackError=${JSON.stringify(error)}`);
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
    stdin: { contents: `import { CloudflareSFUClient } from ${JSON.stringify(source)}; import { CloudflareSFUError } from ${JSON.stringify(path.join(root, "sdks/typescript/client/src/media/types.ts"))}; window.CloudflareSFUClient = CloudflareSFUClient; window.CloudflareSFUError = CloudflareSFUError;`, resolveDir: root, sourcefile: "guest-sdk-entry.ts" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  for (const guest of guests) {
    const context = await browser.newContext();
    guest.page = await context.newPage();
    await guest.page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>local SDK media repro</title>" }));
    await guest.page.goto("http://localhost/");
    await guest.page.addScriptTag({ content: bundle.outputFiles[0].text });
    await guest.page.exposeFunction("sfuBridge", (operation, input) => bridge(control, guest, operation, input));
    await guest.page.evaluate(async ({ connectionId, participantId }) => {
      window.sfuEvents = [];
      window.sfuErrors = [];
      window.mediaRoster = [];
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
          const pc = new RTCPeerConnection(configuration);
          pc.addEventListener("track", (event) => window.sfuEvents.push({ type: "track", mid: event.transceiver.mid, kind: event.track.kind, id: event.track.id, readyState: event.track.readyState }));
          const setLocalDescription = pc.setLocalDescription.bind(pc);
          pc.setLocalDescription = async (description) => {
            try {
              const result = await setLocalDescription(description);
              if (description?.type === "offer" && description.sdp?.includes("a=simulcast:send")) {
                const sections = [];
                let section;
                for (const line of description.sdp.split(/\r?\n/)) {
                  if (line.startsWith("m=")) {
                    if (section) sections.push(section);
                    section = { media: line, lines: [] };
                  } else if (section && (/^a=mid:|^a=(sendrecv|sendonly|recvonly|inactive)$|^a=(extmap:|rid:|simulcast)/.test(line))) {
                    section.lines.push(line);
                  }
                }
                if (section) sections.push(section);
                window.sfuEvents.push({ type: "set-local-offer", sections });
              }
              return result;
            } catch (error) {
              const sections = [];
              let section;
              for (const line of (description?.sdp ?? "").split(/\r?\n/)) {
                if (line.startsWith("m=")) {
                  if (section) sections.push(section);
                  section = { media: line, lines: [] };
                } else if (section && (/^a=mid:|^a=(sendrecv|sendonly|recvonly|inactive)$|^a=(extmap:|rid:|simulcast)/.test(line))) {
                  section.lines.push(line);
                }
              }
              if (section) sections.push(section);
              window.sfuEvents.push({ type: "set-local-error", descriptionType: description?.type, sections, error: error.message });
              throw error;
            }
          };
          return pc;
        },
        onRemoteTrack(publication) { window.sfuEvents.push({ type: "remote-publication", participantId: publication.participantId, source: publication.source, publicationId: publication.publicationId, kind: publication.track.kind, id: publication.track.id }); },
        onError(error) { window.sfuErrors.push({ name: error.name, message: error.message, code: error.code, status: error.options?.status }); },
        onDiagnostic(event) { window.sfuEvents.push({ type: "diagnostic", ...event }); },
        transport: {
          async addTracks(input) { return checked(await window.sfuBridge("tracks", input)); },
          async closeTracks(input) { return checked(await window.sfuBridge("tracks_close", input)); },
          async renegotiate(input) { checked(await window.sfuBridge("renegotiate", input)); },
          async listPublications() { return checked(await window.sfuBridge("publications", {})); },
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
    }, { connectionId: guest.connectionId, participantId: guest.scope.participantId });
    guest.started = true;
    console.log(`SDK_START guest=${guest.index + 1} status=live`);
  }

  rosterActive = true;
  await publishRosterToAll();
  await Promise.all(guests.map((guest) => guest.page.evaluate((participantIds) => window.mediaClient.remoteParticipantsChanged(participantIds), guests.filter((other) => other !== guest).map((other) => other.scope.participantId))));
  await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.mediaClient.refreshRemotePublications())));
  await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 12_000, "initial four remote tracks per guest");
  console.log(`SDK_READY ${JSON.stringify(await snapshots())}`);

  // This is toggle-offers' round body: all guests do mic-off then camera-off,
  // the client retires removed remote tracks, wait 300 ms, then mic-on/camera-on.
  await Promise.all(guests.map(async (guest) => {
    for (const sourceName of ["microphone", "camera"]) await setTarget(guest, sourceName, false);
  }));
  await waitForSnapshots((snapshot) => snapshot.remote.length === 0, 8_000, "remote receivers retired after all sources went off");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await Promise.all(guests.map(async (guest) => {
    await setTarget(guest, "microphone", true);
    await setTarget(guest, "camera", true);
  }));
  await waitForSnapshots((snapshot) => snapshot.local.length === 2 && snapshot.local.every((track) => track.enabled), 8_000, "local microphone and camera re-published");
  await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 15_000, "remote tracks re-pulled");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`SDK_FINAL ${JSON.stringify(await snapshots())}`);
  console.log(`TRACK_EVENTS ${JSON.stringify(await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.sfuEvents.filter((event) => event.type === "track")))) )}`);
  console.log(`LOCAL_SDP_OFFERS ${JSON.stringify(await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.sfuEvents.filter((event) => event.type === "set-local-offer")))) )}`);
  console.log(`LOCAL_SDP_FAILURES ${JSON.stringify(await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.sfuEvents.filter((event) => event.type === "set-local-error")))) )}`);
  console.log(`SDK_ERRORS ${JSON.stringify(await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.sfuErrors))))}`);
  console.log(`RESULT ${failures.length ? `FAIL ${JSON.stringify(failures)}` : "PASS"}`);
  for (const line of nodeLines.filter((item) => /WARN|ERROR|error|failed|invalid/i.test(item))) console.log(`NODE ${line.replace(/127\.0\.0\.1:\d+/g, "<local-endpoint>")}`);
  if (failures.length) process.exitCode = 1;
}

async function setTarget(guest, sourceName, enabled) {
  const result = await guest.page.evaluate(async ({ source, enabled, participantId }) => {
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
  }, { source: sourceName, enabled, participantId: guest.scope.participantId });
  console.log(`SDK_TARGET guest=${guest.index + 1} source=${sourceName} enabled=${enabled} outcome=${result.outcome} errorCode=${result.errorCode} durationMs=${result.durationMs.toFixed(1)}`);
  if (enabled && result.outcome !== "confirmed" && result.outcome !== "satisfied") failures.push(`guest=${guest.index + 1} ${sourceName}-on outcome=${result.outcome} code=${result.errorCode}`);
  return result;
}

async function snapshots() {
  return Promise.all(guests.map((guest) => guest.page.evaluate(() => {
    const snapshot = window.mediaClient.getSnapshot();
    return {
      connection: snapshot.connection,
      local: snapshot.localTracks.map((track) => ({ source: track.source, enabled: track.enabled, publicationId: track.publicationId })),
      remote: snapshot.remoteTracks.map((track) => ({ participantId: track.participantId, source: track.source, publicationId: track.publicationId, readyState: track.track.readyState })),
      failure: snapshot.failure,
    };
  })));
}

async function waitForSnapshots(predicate, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < until) {
    latest = await snapshots();
    if (latest.every(predicate)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  failures.push(`timed out: ${label}; last=${JSON.stringify(latest)}`);
  console.log(`WAIT_TIMEOUT ${label} last=${JSON.stringify(latest)}`);
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
      responseBody.tracks = responseBody.tracks.map((item) => item.mid === track.mid && item.trackName === track.trackName ? { ...item, publicationId } : item);
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
  if (rosterActive && operation !== "tracks_close" || rosterActive && !input.receiveOnly) void publishRosterToAll(guest);
  return { status: response.status, body: responseBody, ...(rosterActive ? { roster } : {}) };
}

async function startService(certs) {
  const binary = path.join(work, "sfu");
  const sourceDir = process.env.SFU_SOURCE_DIR ?? process.cwd();
  execFileSync("go", ["build", "-o", binary, "./cmd/sfu"], { cwd: sourceDir, stdio: "inherit" });
  const controlPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const sfu = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], env: {
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
  } });
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
  const send = (method, route, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request({ ...options, method, path: route, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined }); });
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
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => { const { port } = socket.address(); socket.close(() => resolve(port)); });
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
  await browser?.close().catch(() => undefined);
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve()));
  }
  rmSync(work, { recursive: true, force: true });
}

try {
  await main();
} finally {
  await cleanup();
}
