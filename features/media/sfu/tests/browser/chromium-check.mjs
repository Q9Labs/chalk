// Runs one headless Chromium peer against a real SFU process.
//
// Connection A pushes a fake camera and microphone with the SDK's SDP shape
// (max-bundle, sendonly transceivers, camera simulcast h/l unless SIMULCAST=0).
// Connection B pulls both back: the SFU offers, the browser answers through
// Renegotiate. The check passes when B decodes video frames and receives audio
// packets. This script plays the API's part: it holds the client certificate and
// calls the control API.
//
// Usage, from features/media/sfu (needs `pnpm install` at the repository root
// and `pnpm exec playwright install chromium`):
//   node tests/browser/chromium-check.mjs

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
const work = mkdtempSync(path.join(tmpdir(), "sfu-browser-"));
const children = [];
let browser;

async function main() {
  const certs = createPki(work);
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
    },
  });
  children.push(sfu);
  const control = controlClient(controlPort, certs);
  await waitFor("the SFU to become ready", 15_000, async () => (await control.get("/readyz").catch(() => ({ status: 0 }))).status === 200);

  const tenant = { tenantId: "tenant-browser", episodeId: "episode-1", generation: 1 };
  const scopeA = { ...tenant, participantId: "browser-a" };
  const scopeB = { ...tenant, participantId: "browser-b" };
  const connectionA = (await control.post("/v1/sessions", { operationId: "browser-create-a", scope: scopeA })).body.connectionId;
  const connectionB = (await control.post("/v1/sessions", { operationId: "browser-create-b", scope: scopeB })).body.connectionId;

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext()).newPage();
  page.on("console", (message) => console.log(`[page] ${message.text()}`));
  // getUserMedia needs a secure context, and http://localhost is one.
  await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>sfu</title>" }));
  await page.goto("http://localhost/");

  // Connection A: the SDK offers without waiting for ICE gathering.
  const offer = await page.evaluate(async (useSimulcast) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const connection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    window.publisher = connection;
    const microphone = connection.addTransceiver(stream.getAudioTracks()[0], { direction: "sendonly" });
    const [videoTrack] = stream.getVideoTracks();
    let camera;
    try {
      if (!useSimulcast) throw new Error("single encoding requested");
      camera = connection.addTransceiver(videoTrack, {
        direction: "sendonly",
        sendEncodings: [
          { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2_500_000, scalabilityMode: "L1T1" },
          { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650_000, scalabilityMode: "L1T1" },
        ],
      });
    } catch {
      camera = connection.addTransceiver(videoTrack, { direction: "sendonly" });
    }
    const description = await connection.createOffer();
    await connection.setLocalDescription(description);
    return { sdp: description.sdp, type: description.type, microphoneMid: microphone.mid, cameraMid: camera.mid };
  }, simulcast);
  const pushed = await control.post(`/v1/sessions/${connectionA}/tracks`, {
    scope: scopeA,
    sessionDescription: { sdp: offer.sdp, type: offer.type },
    tracks: [
      { location: "local", mid: offer.microphoneMid, trackName: "microphone-1", source: "microphone" },
      { location: "local", mid: offer.cameraMid, trackName: "camera-1", source: "camera" },
    ],
  });
  expect(pushed.status === 200 && pushed.body.sessionDescription?.type === "answer" && pushed.body.tracks?.length === 2 && !pushed.body.trackErrors, `push answered: ${JSON.stringify(pushed.body).slice(0, 300)}`);
  await page.evaluate((answer) => window.publisher.setRemoteDescription(answer), pushed.body.sessionDescription);

  // Connection B: the SFU offers, the browser answers.
  const pulled = await control.post(`/v1/sessions/${connectionB}/tracks`, {
    scope: scopeB,
    tracks: [
      { location: "remote", sessionId: connectionA, trackName: "microphone-1" },
      { location: "remote", sessionId: connectionA, trackName: "camera-1", simulcast: { preferredRid: "h", priorityOrdering: "none", ridNotAvailable: "asciibetical" } },
    ],
  });
  expect(pulled.status === 200 && pulled.body.sessionDescription?.type === "offer" && pulled.body.tracks?.length === 2 && !pulled.body.trackErrors, `pull offered: ${JSON.stringify(pulled.body).slice(0, 300)}`);
  const answer = await page.evaluate(async (serverOffer) => {
    const connection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    window.subscriber = connection;
    await connection.setRemoteDescription(serverOffer);
    const description = await connection.createAnswer();
    await connection.setLocalDescription(description);
    return { sdp: description.sdp, type: description.type };
  }, pulled.body.sessionDescription);
  const renegotiated = await control.post(`/v1/sessions/${connectionB}/renegotiate`, { scope: scopeB, sessionDescription: answer });
  expect(renegotiated.status === 204, `renegotiate answered with ${renegotiated.status}`);

  const media = await waitFor("decoded video frames and audio packets", 30_000, async () => {
    const stats = await page.evaluate(async () => {
      const report = await window.subscriber.getStats();
      const inbound = [...report.values()].filter((entry) => entry.type === "inbound-rtp");
      const pick = (kind) => inbound.find((entry) => entry.kind === kind) ?? {};
      return { video: { framesDecoded: pick("video").framesDecoded ?? 0, packets: pick("video").packetsReceived ?? 0 }, audio: { packets: pick("audio").packetsReceived ?? 0 } };
    });
    return stats.video.framesDecoded >= 30 && stats.audio.packets >= 50 ? stats : false;
  });
  console.log(`PASS: simulcast=${simulcast} decoded ${media.video.framesDecoded} video frames (${media.video.packets} packets) and received ${media.audio.packets} audio packets`);

  const inspected = await control.post(`/v1/sessions/${connectionA}/inspect`, { scope: scopeA });
  expect(inspected.body.tracks?.length === 2, `inspect lists both published tracks: ${JSON.stringify(inspected.body)}`);
}

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
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
