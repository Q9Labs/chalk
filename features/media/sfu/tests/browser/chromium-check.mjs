// Runs one headless Chromium peer against a real SFU process.
//
// Connection A pushes a fake camera and microphone with the SDK's SDP shape
// (max-bundle, sendonly transceivers, camera simulcast h/l unless SIMULCAST=0).
// Connection B pulls both back: the SFU offers, the browser answers through
// Renegotiate. The check passes when B decodes video frames and receives audio
// packets. This script plays the API's part: it holds the client certificate and
// calls the control API.
//
// With simulcast, connection C pulls the camera's "l" layer while B wants "h".
// The check then stops and restarts each of the publisher's encodings and
// asserts that each subscriber falls back and returns, keeps decoding, and keeps
// its MID with no new SDP. Last it prints each encoding's resolution and encode
// time, the numbers behind the third-layer decision (ENCODINGS=3 adds "q").
//
// Usage, from features/media/sfu (needs `pnpm install` at the repository root
// and `pnpm exec playwright install chromium`):
//   node tests/browser/chromium-check.mjs
//   ENCODINGS=3 node tests/browser/chromium-check.mjs

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const identity = "chalk-api.test";
const simulcast = process.env.SIMULCAST !== "0";
const allEncodings = [
  { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2_500_000, scalabilityMode: "L1T1" },
  { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650_000, scalabilityMode: "L1T1" },
  { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 200_000, scalabilityMode: "L1T1" },
];
const encodings = simulcast ? allEncodings.slice(0, Number(process.env.ENCODINGS ?? 2)) : [];
const work = mkdtempSync(path.join(tmpdir(), "sfu-browser-"));
const children = [];
let browser;

async function main() {
  const certs = createPki(work);
  const control = await startService(certs);
  const tenant = { tenantId: "tenant-browser", episodeId: "episode-1", generation: 1 };
  const scopeA = { ...tenant, participantId: "browser-a" };
  const scopeB = { ...tenant, participantId: "browser-b" };
  const connectionA = (await control.post("/v1/sessions", { operationId: "browser-create-a", scope: scopeA })).body.connectionId;
  const connectionB = (await control.post("/v1/sessions", { operationId: "browser-create-b", scope: scopeB })).body.connectionId;
  // The node forwards a source only while Sync's grant stands.
  const controls = ["microphone", "camera"].map((source) => ({ participantId: scopeA.participantId, source, action: "grant", revision: 1 }));
  expect((await control.post("/v1/episodes/sources", { tenantId: tenant.tenantId, episodeId: tenant.episodeId, controls })).status === 200, "grant browser-a's sources");
  const page = await openPage();

  await push(page, control, connectionA, scopeA);
  await pull(page, control, connectionB, connectionA, scopeB, "subscriber", "h");

  const media = await waitFor("decoded video frames and audio packets", 30_000, () => receivedMedia(page));
  console.log(`PASS: simulcast=${simulcast} decoded ${media.video.framesDecoded} video frames (${media.video.packets} packets) and received ${media.audio.packets} audio packets`);

  const inspected = await control.post(`/v1/sessions/${connectionA}/inspect`, { scope: scopeA });
  expect(inspected.body.tracks?.length === 2, `inspect lists both published tracks: ${JSON.stringify(inspected.body)}`);
  if (!simulcast) return;

  const scopeC = { ...tenant, participantId: "browser-c" };
  const connectionC = (await control.post("/v1/sessions", { operationId: "browser-create-c", scope: scopeC })).body.connectionId;
  await pull(page, control, connectionC, connectionA, scopeC, "subscriberLow", "l");
  const viewers = [
    { name: "B", window: "subscriber", connection: connectionB, scope: scopeB },
    { name: "C", window: "subscriberLow", connection: connectionC, scope: scopeC },
  ];
  await checkLayerSwitching(page, control, viewers);
  await reportEncoders(page, control, viewers);
}

// The camera subscription's state and the decoder's view of one viewer.
async function viewerState(page, control, viewer) {
  const inspected = await control.post(`/v1/sessions/${viewer.connection}/inspect`, { scope: viewer.scope });
  const camera = inspected.body.tracks?.find((track) => track.trackName === "camera-1");
  const decoded = await page.evaluate(async (name) => {
    const connection = window[name];
    const report = await connection.getStats();
    const video = [...report.values()].find((entry) => entry.type === "inbound-rtp" && entry.kind === "video");
    const mids = connection
      .getTransceivers()
      .map((transceiver) => transceiver.mid)
      .join(",");
    return { video, mids, signaling: connection.signalingState, sdp: connection.currentLocalDescription?.sdp };
  }, viewer.window);
  const { framesDecoded: frames = 0, keyFramesDecoded: keyFrames = 0, frameHeight: height = 0 } = decoded.video ?? {};
  return { rid: camera?.subscription?.effectiveRid, mid: camera?.mid, frames, keyFrames, height, mids: decoded.mids, signaling: decoded.signaling, sdp: decoded.sdp };
}

// Waits until every viewer forwards its expected layer and has decoded frames
// on it, and settled(states) holds, then returns their states. On a timeout it
// prints what each viewer and each encoding was doing.
async function expectLayers(page, control, viewers, want, what, settled = () => true) {
  const start = await Promise.all(viewers.map((viewer) => viewerState(page, control, viewer)));
  let last = start;
  const states = await waitFor(what, 60_000, async () => {
    last = await Promise.all(viewers.map((viewer) => viewerState(page, control, viewer)));
    const forwarding = last.every((state, index) => state.rid === want[index] && state.frames >= start[index].frames + 30);
    return forwarding && settled(last) ? last : false;
  }).catch(async (error) => {
    for (const [index, state] of last.entries()) console.log(`STUCK viewer=${viewers[index].name} rid=${state.rid} height=${state.height} frames=${state.frames - start[index].frames}`);
    for (const layer of await publisherLayers(page)) console.log(`STUCK encoder rid=${layer.rid} ${layer.width}x${layer.height} limitation=${layer.limitation}`);
    throw error;
  });
  for (const [index, state] of states.entries()) {
    expect(state.mid === viewers[index].mid && state.mids === viewers[index].mids, `${viewers[index].name} kept its MID: ${state.mid} ${state.mids}`);
    expect(state.signaling === "stable" && state.sdp === viewers[index].sdp, `${viewers[index].name} exchanged no SDP`);
  }
  console.log(`PASS: ${what}: ${states.map((state, index) => `${viewers[index].name} on ${state.rid} at ${state.height}p, ${state.keyFrames} keyframes decoded`).join("; ")}`);
  return states;
}

async function setEncoding(page, rid, active) {
  await page.evaluate(
    async ({ rid, active }) => {
      const sender = window.publisher.getSenders().find((candidate) => candidate.track?.kind === "video");
      const parameters = sender.getParameters();
      parameters.encodings.find((encoding) => encoding.rid === rid).active = active;
      await sender.setParameters(parameters);
    },
    { rid, active },
  );
}

async function checkLayerSwitching(page, control, viewers) {
  for (const viewer of viewers) Object.assign(viewer, await viewerState(page, control, viewer));
  // Chrome ramps its estimate from loss reports alone until M5 adds congestion
  // feedback, so "h" can take a while to start and to reach full size.
  await expectLayers(page, control, viewers, ["h", "l"], "B on h and C on l, h decoding taller", ([b, c]) => b.height > c.height);
  for (const round of [1, 2]) {
    await setEncoding(page, "h", false);
    const fallen = await expectLayers(page, control, viewers, ["l", "l"], `round ${round}: h stopped, B falls back to l`);
    expect(fallen[0].height === fallen[1].height, `B decodes l's height: ${fallen[0].height} vs ${fallen[1].height}`);
    await setEncoding(page, "h", true);
    await expectLayers(page, control, viewers, ["h", "l"], `round ${round}: h restarted, B returns to h`);
    await setEncoding(page, "l", false);
    await expectLayers(page, control, viewers, ["h", "h"], `round ${round}: l stopped, C falls back to h`);
    await setEncoding(page, "l", true);
    await expectLayers(page, control, viewers, ["h", "l"], `round ${round}: l restarted, C returns to l`);
  }
}

// The publisher's video encodings as Chrome reports them.
function publisherLayers(page) {
  return page.evaluate(async () => {
    const report = await window.publisher.getStats();
    return [...report.values()]
      .filter((entry) => entry.type === "outbound-rtp" && entry.kind === "video")
      .map((entry) => ({ rid: entry.rid, width: entry.frameWidth, height: entry.frameHeight, frames: entry.framesEncoded ?? 0, encodeSeconds: entry.totalEncodeTime ?? 0, bytes: entry.bytesSent ?? 0, limitation: entry.qualityLimitationReason }));
  });
}

// Prints each encoding's resolution and encode time per frame, and what each
// viewer decodes, over a 20-second window.
async function reportEncoders(page, control, viewers) {
  const sample = () => publisherLayers(page);
  const before = await sample();
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const after = await sample();
  let total = 0;
  for (const layer of after) {
    const start = before.find((entry) => entry.rid === layer.rid) ?? { frames: 0, encodeSeconds: 0, bytes: 0 };
    const frames = layer.frames - start.frames;
    const encodeMs = (layer.encodeSeconds - start.encodeSeconds) * 1000;
    total += encodeMs / 20;
    console.log(`ENCODER rid=${layer.rid} ${layer.width}x${layer.height} fps=${(frames / 20).toFixed(1)} encodeMsPerFrame=${(encodeMs / Math.max(frames, 1)).toFixed(2)} kbps=${(((layer.bytes - start.bytes) * 8) / 20 / 1000).toFixed(0)} limitation=${layer.limitation}`);
  }
  console.log(`ENCODER total encodeMsPerSecond=${total.toFixed(1)} encodings=${after.length}`);
  for (const viewer of viewers) {
    const state = await viewerState(page, control, viewer);
    console.log(`DECODER viewer=${viewer.name} rid=${state.rid} height=${state.height}`);
  }
}

async function startService(certs) {
  const binary = path.join(work, "sfu");
  execFileSync("go", ["build", "-o", binary, "./cmd/sfu"], { stdio: "inherit" });
  const controlPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const sfu = spawn(binary, [], {
    stdio: ["ignore", "inherit", "inherit"],
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
      // Sync renews source grants; this check grants once, so the lease must outlast it.
      SFU_SOURCE_LEASE_TTL: "2m",
    },
  });
  children.push(sfu);
  const control = controlClient(controlPort, certs);
  await waitFor("the SFU to become ready", 15_000, async () => (await control.get("/readyz").catch(() => ({ status: 0 }))).status === 200);
  return control;
}

async function openPage() {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext()).newPage();
  page.on("console", (message) => console.log(`[page] ${message.text()}`));
  // getUserMedia needs a secure context, and http://localhost is one.
  await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>sfu</title>" }));
  await page.goto("http://localhost/");
  return page;
}

// Connection A: the SDK offers without waiting for ICE gathering.
async function push(page, control, connectionId, scope) {
  const offer = await page.evaluate(async (sendEncodings) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720, frameRate: 30 } });
    const connection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    window.publisher = connection;
    const microphone = connection.addTransceiver(stream.getAudioTracks()[0], { direction: "sendonly" });
    const [videoTrack] = stream.getVideoTracks();
    let camera;
    try {
      if (sendEncodings.length === 0) throw new Error("single encoding requested");
      camera = connection.addTransceiver(videoTrack, { direction: "sendonly", sendEncodings });
    } catch {
      camera = connection.addTransceiver(videoTrack, { direction: "sendonly" });
    }
    const description = await connection.createOffer();
    await connection.setLocalDescription(description);
    return { sdp: description.sdp, type: description.type, microphoneMid: microphone.mid, cameraMid: camera.mid };
  }, encodings);
  const pushed = await control.post(`/v1/sessions/${connectionId}/tracks`, {
    operationId: `push-${connectionId}`,
    scope,
    sessionDescription: { sdp: offer.sdp, type: offer.type },
    tracks: [
      { location: "local", mid: offer.microphoneMid, trackName: "microphone-1", source: "microphone" },
      { location: "local", mid: offer.cameraMid, trackName: "camera-1", source: "camera" },
    ],
  });
  expect(isCleanTrackResponse(pushed, "answer"), `push answered: ${JSON.stringify(pushed.body).slice(0, 300)}`);
  await page.evaluate((answer) => window.publisher.setRemoteDescription(answer), pushed.body.sessionDescription);
}

// A subscriber: the SFU offers, the browser answers. The page keeps the
// connection as window[name].
async function pull(page, control, connectionId, publisherId, scope, name, preferredRid) {
  const pulled = await control.post(`/v1/sessions/${connectionId}/tracks`, {
    operationId: `pull-${connectionId}`,
    scope,
    tracks: [
      { location: "remote", sessionId: publisherId, trackName: "microphone-1" },
      { location: "remote", sessionId: publisherId, trackName: "camera-1", simulcast: { preferredRid, priorityOrdering: "none", ridNotAvailable: "asciibetical" } },
    ],
  });
  expect(isCleanTrackResponse(pulled, "offer"), `pull offered: ${JSON.stringify(pulled.body).slice(0, 300)}`);
  const answer = await page.evaluate(
    async ({ serverOffer, name }) => {
      const connection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
      window[name] = connection;
      await connection.setRemoteDescription(serverOffer);
      const description = await connection.createAnswer();
      await connection.setLocalDescription(description);
      return { sdp: description.sdp, type: description.type };
    },
    { serverOffer: pulled.body.sessionDescription, name },
  );
  // The node paces and adapts a browser by its transport-wide feedback, so an answer without it would run unadapted.
  expect(/a=rtcp-fb:\d+ transport-cc/.test(answer.sdp) && /transport-wide-cc-extensions/.test(answer.sdp), `${name} answered without transport-wide congestion control`);
  const renegotiated = await control.post(`/v1/sessions/${connectionId}/renegotiate`, {
    operationId: `renegotiate-${connectionId}`,
    scope,
    sessionDescription: answer,
  });
  expect(renegotiated.status === 204, `renegotiate answered with ${renegotiated.status}`);
}

// A track request succeeded when it returned the expected SDP for both tracks and no per-track error.
function isCleanTrackResponse(response, sdpType) {
  const body = response.body ?? {};
  return [response.status === 200, body.sessionDescription?.type === sdpType, body.tracks?.length === 2, !body.trackErrors].every(Boolean);
}

async function receivedMedia(page) {
  const stats = await page.evaluate(async () => {
    const report = await window.subscriber.getStats();
    const inbound = [...report.values()].filter((entry) => entry.type === "inbound-rtp");
    const pick = (kind) => inbound.find((entry) => entry.kind === kind) ?? {};
    return { video: { framesDecoded: pick("video").framesDecoded ?? 0, packets: pick("video").packetsReceived ?? 0 }, audio: { packets: pick("audio").packetsReceived ?? 0 } };
  });
  lastMedia = stats;
  return stats.video.framesDecoded >= 30 && stats.audio.packets >= 50 ? stats : false;
}
let lastMedia;

function createPki(directory) {
  const run = (...args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "inherit"] });
  const ca = { key: path.join(directory, "ca.key"), cert: path.join(directory, "ca.pem") };
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ca.key);
  run("req", "-new", "-x509", "-key", ca.key, "-sha256", "-days", "1", "-subj", "/CN=sfu-browser-ca", "-out", ca.cert, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  const issue = (name, subjectAltName, usage) => {
    const files = { key: path.join(directory, `${name}.key`), csr: path.join(directory, `${name}.csr`), cert: path.join(directory, `${name}.pem`), ext: path.join(directory, `${name}.ext`) };
    run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", files.key);
    run("req", "-new", "-key", files.key, "-subj", `/CN=${name}`, "-out", files.csr);
    writeFileSync(files.ext, `subjectAltName=${subjectAltName}\nextendedKeyUsage=${usage}\nkeyUsage=digitalSignature\n`);
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

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last media ${JSON.stringify(lastMedia)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
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
  await cleanup();
} catch (error) {
  console.error(error);
  await cleanup();
  process.exit(1);
}
