import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

// Proves the viewer layer switch against the real Cloudflare SFU: one publisher
// sends a noisy 540p simulcast camera, one viewer receives it behind a capped
// downlink, and the viewer's own stats pick h or l. Inject a disposable dev
// app's JSON credential with 2password run; provider credentials stay in this
// process. See real-sfu-viewer-netns.sh for the machine the viewer runs in.
//   CHALK_PROOF_ADAPT=0      control run: the viewer never switches layers
//   CHALK_PROOF_CAP_PPS=60   downlink cap in UDP packets per second (about 0.6 Mbps)
//   CHALK_PROOF_NETNS=1      run the viewer in the namespace (Linux, root helper)
//   CHALK_PROOF_CHROMIUM=…   system Chromium path
//   CHALK_PROOF_OUTPUT=…     directory for the JSON report
const SCRIPT = new URL(import.meta.url).pathname;
const NETNS_HELPER = new URL("./real-sfu-viewer-netns.sh", import.meta.url).pathname;
const VIEWER_HOST = "10.200.1.1";

if (process.argv[2] === "--launch-viewer") {
  // Runs inside the viewer namespace: a plain Playwright launch of the viewer page.
  // The namespace address is not localhost, so the page needs a secure context for the SDK's crypto.randomUUID.
  const secureOrigin = `--unsafely-treat-insecure-origin-as-secure=${new URL(process.argv[3]).origin}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHALK_PROOF_CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required", secureOrigin] });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(JSON.stringify({ viewer_page_error: error.message })));
  await page.goto(process.argv[3]);
  await new Promise((resolve) => process.stdin.on("end", resolve).resume());
  await browser.close();
  process.exit(0);
}

const app = JSON.parse(process.env.CHALK_SFU_DEV_APP ?? readFileSync(0, "utf8"));
delete process.env.CHALK_SFU_DEV_APP;
const appId = app.uid ?? app.id;
assert.ok(appId && app.secret, "A disposable SFU dev app is required");
const adapt = process.env.CHALK_PROOF_ADAPT !== "0";
const useNetns = process.env.CHALK_PROOF_NETNS === "1";
const capPps = Number(process.env.CHALK_PROOF_CAP_PPS ?? 60);
const output = process.env.CHALK_PROOF_OUTPUT ?? join(tmpdir(), "viewer-layer-proof");
mkdirSync(output, { recursive: true });
const browserBundle = await build({
  stdin: { contents: `export {CloudflareSFUClient} from './src/media/client.ts'; export {setVideoRenderSize} from './src/media/video-render-size.ts';`, resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ChalkMedia",
});
const states = new Map();
const startedAt = Date.now();
const timeline = [];
const layerEvents = [];
let phase = "setup";
let tile = null;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const note = (entry) => console.log(JSON.stringify({ t: Math.round((Date.now() - startedAt) / 100) / 10, phase, ...entry }));

async function provider(path, method, body) {
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/${path}`, { method, headers: { Authorization: `Bearer ${app.secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Dev SFU request failed: HTTP ${response.status}`);
  return result;
}
async function replace(state) {
  const session = await provider("sessions/new", "POST");
  state.sessionId = session.sessionId;
  state.publications = [];
  state.bootstrap = { connectionId: state.sessionId, stunServer: "stun:stun.cloudflare.com:3478" };
  return state.bootstrap;
}
function publicationId(sessionId, mid, trackName) {
  return `chalk_pub_v1.${Buffer.from(JSON.stringify({ c: sessionId, m: mid, t: trackName, g: 1 })).toString("base64url")}`;
}
async function rpc(index, method, input) {
  const state = states.get(index);
  if (method === "replace") return replace(state);
  if (method === "listPublications") return { incarnation: 1, sequence: [...states.values()].reduce((sum, item) => sum + item.version, 0), publications: [...states.values()].flatMap((item) => item.publications) };
  if (method === "sample") {
    timeline.push({ phase, ms: Date.now() - startedAt, ...input });
    return { tile };
  }
  if (method === "addTracks") {
    const result = await provider(`sessions/${input.connectionId}/tracks/new`, "POST", { sessionDescription: input.sessionDescription, tracks: input.tracks.map(({ source, publicationId, ...track }) => track) });
    result.tracks = result.tracks.map((track, slot) => ({ ...input.tracks[slot], ...track }));
    if (input.tracks.some((track) => track.location === "local")) {
      result.tracks = result.tracks.map((track, slot) => {
        const original = input.tracks[slot];
        const id = publicationId(input.connectionId, track.mid, original.trackName);
        state.publications.push({ participantId: `publisher-${index}`, source: original.source, publicationId: id });
        return { ...original, ...track, publicationId: id };
      });
      state.version++;
    }
    return result;
  }
  if (method === "updateTracks") {
    const rid = input.tracks[0].simulcast.preferredRid;
    try {
      const result = await provider(`sessions/${input.connectionId}/tracks/update`, "PUT", { tracks: input.tracks });
      layerEvents.push({ phase, ms: Date.now() - startedAt, rid, ok: !result.tracks?.some((track) => track.errorCode) });
      note({ event: "layer_switch", rid });
      return result;
    } catch (error) {
      layerEvents.push({ phase, ms: Date.now() - startedAt, rid, ok: false });
      throw error;
    }
  }
  if (method === "renegotiate") return provider(`sessions/${input.connectionId}/renegotiate`, "PUT", { sessionDescription: input.sessionDescription });
  if (method === "closeTracks") return provider(`sessions/${input.connectionId}/tracks/close`, "PUT", { sessionDescription: input.sessionDescription, tracks: input.tracks.map(({ mid }) => ({ mid })), force: input.force });
  throw new Error("Unknown dev RPC operation");
}
// Runs in the page. Index 0 publishes a noisy 540p camera; index 1 views it.
const participant = async function ({ index, bootstrap, adapt }) {
  const NativePeer = window.RTCPeerConnection;
  window.proofPCs = [];
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      window.proofPCs.push(this);
    }
  };
  const context = new AudioContext();
  await context.resume();
  const audio = context.createMediaStreamDestination();
  // A live tone keeps audio RTP flowing, so receive-stall recovery sees a healthy microphone.
  const tone = context.createOscillator();
  tone.frequency.value = 440 + index * 220;
  tone.connect(audio);
  tone.start();
  const tracks = [...audio.stream.getAudioTracks()];
  if (index === 0) {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const drawing = canvas.getContext("2d");
    // Random blocks defeat compression, so h needs far more bitrate than l.
    setInterval(() => {
      for (let block = 0; block < 20; block++) {
        drawing.fillStyle = `hsl(${Math.random() * 360},80%,50%)`;
        drawing.fillRect(Math.random() * 960, Math.random() * 540, 160, 100);
      }
    }, 42);
    tracks.push(canvas.captureStream(24).getVideoTracks()[0]);
  }
  let signature;
  let client;
  const call = async (method, input) => {
    const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ index, method, input }) });
    if (!response.ok) throw new Error("Dev RPC failed");
    const result = await response.json();
    if (method === "listPublications") {
      const next = JSON.stringify(result.publications);
      if (next !== signature) {
        signature = next;
        client.remotePublicationsChanged(result.publications.map((publication) => ({ ...publication, enabled: true })));
      }
    }
    return result;
  };
  const methods = ["addTracks", "listPublications", "renegotiate", "closeTracks", ...(index === 1 && adapt ? ["updateTracks"] : [])];
  window.proofErrors = [];
  client = window.client = new ChalkMedia.CloudflareSFUClient({
    participantId: `publisher-${index}`,
    bootstrap,
    pollIntervalMs: 1000,
    onError: (error) => window.proofErrors.push(`${error.code ?? "unclassified"}:${String(error.message).slice(0, 60)}`),
    transport: Object.fromEntries(methods.map((method) => [method, (input) => call(method, input)])),
    replaceMediaConnection: () => call("replace"),
    onRemoteTrack: (publication) => {
      if (publication.source !== "camera") return;
      const video = document.querySelector("video");
      video.srcObject = new MediaStream([publication.track]);
      void video.play();
      window.viewedTrack = publication.track;
    },
  });
  if (index === 1) {
    // The viewer reports what it receives once a second and gets back the tile size to apply.
    setInterval(async () => {
      const peer = window.proofPCs.find((pc) => pc.connectionState !== "closed");
      if (!peer) return;
      const row = {
        connection: peer.connectionState,
        ice: peer.iceConnectionState,
        clientPhase: window.client.getSnapshot().connection.phase,
        errors: window.proofErrors.join(),
        peers: window.proofPCs.filter((pc) => pc.connectionState !== "closed").length,
        stalls: (window.client.getSnapshot().receiveStalls ?? []).length,
      };
      for (const stat of (await peer.getStats()).values()) {
        if (stat.type === "inbound-rtp" && stat.kind === "video")
          Object.assign(row, {
            width: stat.frameWidth,
            height: stat.frameHeight,
            framesDecoded: stat.framesDecoded,
            fps: stat.framesPerSecond,
            packetsReceived: stat.packetsReceived,
            packetsLost: stat.packetsLost,
            bytesReceived: stat.bytesReceived,
            freezeCount: stat.freezeCount,
            freezeSeconds: stat.totalFreezesDuration,
            jitter: stat.jitter,
          });
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) row.availableIncomingBitrate = stat.availableIncomingBitrate;
      }
      const response = await call("sample", row);
      if (window.viewedTrack) ChalkMedia.setVideoRenderSize(window.viewedTrack, response.tile);
    }, 1000);
  }
  await client.start(new MediaStream(tracks));
};
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("Content-Type", "text/html");
    const index = Number(new URL(request.url, "http://proof").searchParams.get("index"));
    const start = JSON.stringify({ index, bootstrap: states.get(index)?.bootstrap, adapt });
    response.end(`<!doctype html><title>Viewer layer proof</title><video autoplay muted playsinline width="640" height="360"></video><script>${browserBundle.outputFiles[0].text}</script><script>(${participant})(${start})</script>`);
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { index, method, input } = JSON.parse(Buffer.concat(chunks));
    const result = await rpc(index, method, input);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(result ?? {}));
  } catch {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "dev_sfu_rpc_failed" }));
  }
});
await new Promise((resolve) => server.listen(0, useNetns ? "0.0.0.0" : "127.0.0.1", resolve));
const port = server.address().port;
const netns = (...args) => execFileSync("sudo", ["-n", "sh", NETNS_HELPER, ...args], { stdio: "inherit" });

const browsers = [];
let viewerLauncher;
async function until(check, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(200);
  }
  throw new Error(`Timed out: ${label}`);
}
const phaseStart = {};
async function runPhase(name, seconds) {
  phase = name;
  phaseStart[name] = Date.now() - startedAt;
  note({ event: "phase_start" });
  await wait(seconds * 1000);
}
function summarize(name) {
  const rows = timeline.filter((row) => row.phase === name && row.framesDecoded !== undefined);
  if (rows.length < 2) return { samples: rows.length };
  const first = rows[0];
  const last = rows.at(-1);
  const seconds = (last.ms - first.ms) / 1000;
  const heights = {};
  for (const row of rows) heights[row.height] = (heights[row.height] ?? 0) + 1;
  let longestDecodeGapSeconds = 0;
  let gapStart = rows[0].ms;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].framesDecoded > rows[i - 1].framesDecoded) gapStart = rows[i].ms;
    longestDecodeGapSeconds = Math.max(longestDecodeGapSeconds, (rows[i].ms - gapStart) / 1000);
  }
  const received = last.packetsReceived - first.packetsReceived;
  const lost = last.packetsLost - first.packetsLost;
  return {
    samples: rows.length,
    seconds: Math.round(seconds),
    decodedFps: Math.round(((last.framesDecoded - first.framesDecoded) / seconds) * 10) / 10,
    receivedKbps: Math.round(((last.bytesReceived - first.bytesReceived) * 8) / seconds / 1000),
    lossPercent: Math.round((lost / Math.max(1, received + lost)) * 1000) / 10,
    freezes: last.freezeCount - first.freezeCount,
    freezeSeconds: Math.round((last.freezeSeconds - first.freezeSeconds) * 10) / 10,
    longestDecodeGapSeconds,
    framesByHeight: heights,
  };
}
let failure;
try {
  for (const index of [0, 1]) states.set(index, { version: 0 });
  await replace(states.get(0));
  await replace(states.get(1));
  if (useNetns) netns("setup");
  const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHALK_PROOF_CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
  const publisherBrowser = await launch();
  browsers.push(publisherBrowser);
  const publisherPage = await publisherBrowser.newPage();
  publisherPage.on("pageerror", (error) => console.error(JSON.stringify({ publisher_page_error: error.message })));
  await publisherPage.goto(`http://127.0.0.1:${port}/?index=0`);
  await wait(4000);
  // The viewer joins after the camera is publishing, so its first pull gets media.
  if (useNetns) {
    const env = ["env", `PATH=${process.env.PATH}`, `CHALK_PROOF_CHROMIUM=${process.env.CHALK_PROOF_CHROMIUM ?? ""}`, "INSTABOX_HEADLESS=1"];
    viewerLauncher = spawn("sudo", ["-n", "ip", "netns", "exec", "chalkviewer", "sudo", "-n", "-u", process.env.USER, ...env, "node", SCRIPT, "--launch-viewer", `http://${VIEWER_HOST}:${port}/?index=1`], { stdio: ["pipe", "inherit", "inherit"] });
  } else {
    const viewerBrowser = await launch();
    browsers.push(viewerBrowser);
    await (await viewerBrowser.newPage()).goto(`http://127.0.0.1:${port}/?index=1`);
  }
  await until(() => timeline.some((row) => row.framesDecoded > 30), 45_000, "viewer decoding the camera");
  await runPhase("baseline", 20);
  if (useNetns) {
    netns("cap", String(capPps));
    await runPhase("throttled", 50);
    netns("clear");
    await runPhase("recovered", 90);
  }
  tile = { width: 480, height: 270 };
  await runPhase("tile_small", 25);
  tile = { width: 1280, height: 720 };
  await runPhase("tile_large", 40);
  phase = "done";
} catch (error) {
  failure = error;
} finally {
  if (useNetns) {
    viewerLauncher?.stdin.end();
    await wait(1500);
    viewerLauncher?.kill();
    try {
      netns("teardown");
    } catch {
      /* Teardown is best effort; the machine is disposable. */
    }
  }
  for (const browser of browsers) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const phases = Object.fromEntries(Object.keys(phaseStart).map((name) => [name, summarize(name)]));
const switches = layerEvents.map((event) => ({ phase: event.phase, secondsIntoPhase: Math.round((event.ms - phaseStart[event.phase]) / 100) / 10, rid: event.rid, ok: event.ok }));
const report = { adapt, capPps: useNetns ? capPps : null, phases, switches, error: failure?.message, lastSample: failure ? timeline.at(-1) : undefined };
writeFileSync(join(output, `viewer-layer-${adapt ? "adaptive" : "control"}.json`), JSON.stringify({ ...report, timeline }, null, 1));
console.log(JSON.stringify(report, null, 1));
if (failure) process.exit(1);
if (adapt) {
  const after = (name, rid) => switches.find((entry) => entry.phase === name && entry.rid === rid && entry.ok);
  const tailHeights = (name) =>
    new Set(
      timeline
        .filter((row) => row.phase === name && row.height)
        .slice(-5)
        .map((row) => row.height),
    );
  if (useNetns) {
    assert.ok(after("throttled", "l") && after("throttled", "l").secondsIntoPhase <= 20, "The viewer did not drop to l within 20 s of the cap");
    assert.ok(phases.throttled.longestDecodeGapSeconds < 6, "Video stalled under the cap even after the switch");
    assert.ok(after("recovered", "h"), "The viewer did not return to h after the link recovered");
  }
  assert.deepEqual([...tailHeights("tile_small")], [270], "A small tile did not end on l");
  assert.deepEqual([...tailHeights("tile_large")], [540], "A large tile did not return to h");
  console.log(JSON.stringify({ result: "passed" }));
}
