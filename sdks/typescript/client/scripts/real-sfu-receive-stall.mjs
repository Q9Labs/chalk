import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";

// Inject a disposable dev app's JSON credential with 2password run. Provider
// credentials stay in this process; this script never uses a Chalk tenant.
const app = JSON.parse(process.env.CHALK_SFU_DEV_APP ?? readFileSync(0, "utf8"));
delete process.env.CHALK_SFU_DEV_APP;
const appId = app.uid ?? app.id;
assert.ok(appId && app.secret, "A disposable SFU dev app is required");
const browserBundle = await build({ stdin: { contents: `export {CloudflareSFUClient} from './src/media/client.ts';`, resolveDir: new URL("..", import.meta.url).pathname }, bundle: true, write: false, format: "iife", globalName: "ChalkMedia" });
const states = new Map();
const statuses = new Map();
async function provider(path, method, body) {
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/${path}`, { method, headers: { Authorization: `Bearer ${app.secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  if (!response.ok) throw new Error(`Dev SFU request failed: HTTP ${response.status}`);
  return response.json();
}
async function replace(state) {
  state.lastReplacementStarted = Date.now();
  const session = await provider("sessions/new", "POST");
  state.sessionId = session.sessionId;
  state.publications = [];
  state.pulls = [];
  state.replacements++;
  return { connectionId: state.sessionId, stunServer: "stun:stun.cloudflare.com:3478" };
}
function publicationId(sessionId, mid, trackName) {
  return `chalk_pub_v1.${Buffer.from(JSON.stringify({ c: sessionId, m: mid, t: trackName, g: 1 })).toString("base64url")}`;
}
async function rpc(index, method, input) {
  const state = states.get(index);
  if (method === "replace") return replace(state);
  if (method === "listPublications") return { incarnation: 1, sequence: [...states.values()].reduce((sum, item) => sum + item.version, 0), publications: [...states.values()].flatMap((item) => item.publications) };
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
    } else {
      for (const [slot, track] of result.tracks.entries()) {
        const source = input.tracks[slot].trackName.includes("microphone") ? "microphone" : "camera";
        state.pulls = [...state.pulls.filter((pull) => pull.source !== source), { mid: track.mid, source }];
      }
      state.pullCalls++;
    }
    return result;
  }
  if (method === "renegotiate") return provider(`sessions/${input.connectionId}/renegotiate`, "PUT", { sessionDescription: input.sessionDescription });
  if (method === "closeTracks") return provider(`sessions/${input.connectionId}/tracks/close`, "PUT", { sessionDescription: input.sessionDescription, tracks: input.tracks.map(({ mid }) => ({ mid })), force: input.force });
  throw new Error("Unknown dev RPC operation");
}
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Receive recovery proof</title><audio autoplay></audio><script>${browserBundle.outputFiles[0].text}</script>`);
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { index, method, input } = JSON.parse(Buffer.concat(chunks));
    const result = await rpc(index, method, input);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "dev_sfu_rpc_failed" }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browsers = [];
const pages = [];
async function until(check, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  console.log(JSON.stringify({ stage: "starting_browsers" }));
  for (let index = 0; index < 2; index++) {
    const state = { version: 0, replacements: -1, pullCalls: 0 };
    states.set(index, state);
    const bootstrap = await replace(state);
    const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
    browsers.push(browser);
    const page = await browser.newPage();
    pages.push(page);
    await page.goto(origin);
    await page.evaluate(
      async ({ index, bootstrap }) => {
        const NativePeer = window.RTCPeerConnection;
        window.proofPCs = [];
        window.RTCPeerConnection = class extends NativePeer {
          constructor(...args) {
            super(...args);
            window.proofPCs.push(this);
          }
        };
        const context = new AudioContext();
        window.audioContext = context;
        await context.resume();
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 440 + index * 220;
        const gain = context.createGain();
        gain.gain.value = 0.2;
        const output = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(output);
        oscillator.start();
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const drawing = canvas.getContext("2d");
        let frame = 0;
        setInterval(() => {
          drawing.fillStyle = frame++ % 2 ? "blue" : "green";
          drawing.fillRect(0, 0, 320, 180);
        }, 100);
        const camera = canvas.captureStream(10).getVideoTracks()[0];
        const audio = document.querySelector("audio");
        const analyser = context.createAnalyser();
        analyser.connect(context.destination);
        let remoteAudio;
        window.level = () => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        };
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
        window.proofErrors = [];
        client = window.client = new ChalkMedia.CloudflareSFUClient({
          participantId: `publisher-${index}`,
          bootstrap,
          pollIntervalMs: 1000,
          onError: (error) => window.proofErrors.push(error.code ?? "unclassified"),
          transport: Object.fromEntries(["addTracks", "listPublications", "renegotiate", "closeTracks"].map((method) => [method, (input) => call(method, input)])),
          replaceMediaConnection: () => call("replace"),
          onRemoteTrack: (publication) => {
            if (publication.source === "microphone") {
              audio.srcObject = new MediaStream([publication.track]);
              remoteAudio?.disconnect();
              remoteAudio = context.createMediaStreamSource(audio.srcObject);
              remoteAudio.connect(analyser);
              void audio.play();
            }
          },
        });
        await client.start(new MediaStream([...output.stream.getAudioTracks(), camera]));
      },
      { index, bootstrap },
    );
  }
  for (const page of pages) await until(() => page.evaluate(() => window.level() > 0.02), 30_000, "baseline rendered remote audio");
  // Observe flowing RTP in at least two one-second samples before the fault.
  await pages[1].waitForTimeout(3000);
  console.log(JSON.stringify({ stage: "rendered_audio_baseline" }));
  const receiver = states.get(1);
  const previousReplacements = receiver.replacements;
  const pulls = receiver.pulls;
  const allStarted = Date.now();
  await provider(`sessions/${receiver.sessionId}/tracks/close`, "PUT", { force: true, tracks: pulls.map(({ mid }) => ({ mid })) });
  await until(() => pages[1].evaluate(() => window.level() < 0.001), 5000, "all inbound forwarding loss");
  await until(() => pages[1].evaluate(() => window.level() > 0.02), 14_000, "rendered remote audio after connection rebuild");
  const allElapsedMs = Date.now() - allStarted;
  assert.equal(receiver.replacements - previousReplacements, 1, "All-track stall must rebuild exactly once");
  assert.ok(receiver.lastReplacementStarted - allStarted <= 10_000, "All-track recovery did not start within the window plus sampling/backoff");
  const allocations = await pages[1].evaluate(() => {
    const livePeers = window.proofPCs.filter((peer) => peer.connectionState !== "closed");
    return { livePeers: livePeers.length, receivers: livePeers.flatMap((peer) => peer.getTransceivers()).filter((transceiver) => ["recvonly", "sendrecv"].includes(transceiver.currentDirection) && transceiver.receiver.track.readyState === "live").length };
  });
  assert.deepEqual(allocations, { livePeers: 1, receivers: 2 });
  const providerSnapshot = await provider(`sessions/${receiver.sessionId}`, "GET");
  const providerPulls = providerSnapshot.tracks.filter((track) => track.location === "remote");
  assert.deepEqual(providerPulls.map((track) => track.trackName.split("-")[0]).sort(), ["camera", "microphone"]);
  allocations.providerPulls = providerPulls.length;
  console.log(
    JSON.stringify({
      result: "passed",
      browsers: 2,
      allocations,
      allTracks: { renderedAudioRecovered: true, elapsedMs: allElapsedMs, recoveryStartedMs: receiver.lastReplacementStarted - allStarted, replacements: receiver.replacements - previousReplacements },
      upstreamStatuses: Object.fromEntries(statuses),
    }),
  );
} catch (error) {
  for (const page of pages)
    console.log(
      JSON.stringify({
        browser: await page.evaluate(async () => ({
          level: window.level?.(),
          context: window.audioContext?.state,
          paused: document.querySelector("audio").paused,
          time: document.querySelector("audio").currentTime,
          errors: window.proofErrors,
          remoteTracks: window.client?.getSnapshot().remoteTracks.map(({ track }) => ({ kind: track.kind, state: track.readyState })),
          rtp: (await Promise.all(window.proofPCs.map(async (pc) => [...(await pc.getStats()).values()].filter((row) => row.type.includes("bound-rtp")).map((row) => ({ type: row.type, kind: row.kind, sent: row.packetsSent, received: row.packetsReceived, energy: row.totalAudioEnergy }))))).flat(),
        })),
      }),
    );
  console.error(JSON.stringify({ result: "failed", error: error.message, upstreamStatuses: Object.fromEntries(statuses), receivers: [...states.values()].map((state) => ({ replacements: state.replacements, pullCalls: state.pullCalls })) }));
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
