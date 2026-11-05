import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";

// Visible-tile video subscriptions on a real SFU: 8 publishers, one viewer that shows 4 tiles.
// Inject a disposable dev app's JSON credential with 2password run (or on stdin). Provider
// credentials stay in this process; this script never uses a Chalk tenant.
const app = JSON.parse(process.env.CHALK_SFU_DEV_APP ?? readFileSync(0, "utf8"));
delete process.env.CHALK_SFU_DEV_APP;
const appId = app.uid ?? app.id;
assert.ok(appId && app.secret, "A disposable SFU dev app is required");
const PUBLISHERS = 8;
const VISIBLE = 4;
const VIEWER = PUBLISHERS;
const browserBundle = await build({
  stdin: {
    contents: `export {CloudflareSFUClient} from './src/media/client.ts'; export {setVideoTileVisibility, HIDDEN_TILE_CLOSE_MS} from './src/media/video-tile-visibility.ts'; export {createCallStatsCollector} from './src/media/call-stats.ts';`,
    resolveDir: new URL("..", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ChalkMedia",
});
const states = new Map();
const statuses = new Map();
async function provider(path, method, body) {
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/${path}`, { method, headers: { Authorization: `Bearer ${app.secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  if (!response.ok) throw new Error(`Dev SFU request failed: HTTP ${response.status}`);
  return response.json();
}
async function replace(state) {
  const session = await provider("sessions/new", "POST");
  state.sessionId = session.sessionId;
  state.publications = [];
  state.replacements++;
  return { connectionId: state.sessionId, stunServer: "stun:stun.cloudflare.com:3478" };
}
function publicationId(sessionId, mid, trackName) {
  return `chalk_pub_v1.${Buffer.from(JSON.stringify({ c: sessionId, m: mid, t: trackName, g: 1 })).toString("base64url")}`;
}
const sourceOf = (trackName) => trackName.split("-")[0];
async function rpc(index, method, input) {
  const state = states.get(index);
  if (method === "replace") return replace(state);
  if (method === "listPublications") {
    // Publishers see only their own publications, so only the viewer pulls.
    const visible = index === VIEWER ? [...states.values()] : [state];
    return { incarnation: 1, sequence: visible.reduce((sum, item) => sum + item.version, 0), publications: visible.flatMap((item) => item.publications) };
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
    } else {
      state.pulls.push({ at: Date.now(), sources: input.tracks.map((track) => sourceOf(track.trackName)) });
    }
    return result;
  }
  if (method === "renegotiate") return provider(`sessions/${input.connectionId}/renegotiate`, "PUT", { sessionDescription: input.sessionDescription });
  if (method === "closeTracks") {
    state.closes.push({ at: Date.now(), publicationIds: input.tracks.map((track) => track.publicationId) });
    return provider(`sessions/${input.connectionId}/tracks/close`, "PUT", { sessionDescription: input.sessionDescription, tracks: input.tracks.map(({ mid }) => ({ mid })), force: input.force });
  }
  throw new Error("Unknown dev RPC operation");
}
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Visible tiles proof</title><body></body><script>${browserBundle.outputFiles[0].text}</script>`);
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
async function until(check, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
let viewerPage;
try {
  console.log(JSON.stringify({ stage: "starting_publishers" }));
  for (let index = 0; index <= PUBLISHERS; index++) {
    const state = { version: 0, replacements: -1, pulls: [], closes: [] };
    states.set(index, state);
    const bootstrap = await replace(state);
    if (index === VIEWER) await until(() => [...states.values()].filter((item) => item.publications.length === 2).length === PUBLISHERS, 30_000, "every publisher published camera and microphone");
    const page = await (await browser.newContext()).newPage();
    if (index === VIEWER) viewerPage = page;
    await page.goto(origin);
    await page.evaluate(
      async ({ index, bootstrap, viewer, visible }) => {
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
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 220 + index * 55;
        const output = context.createMediaStreamDestination();
        oscillator.connect(output);
        oscillator.start();
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const drawing = canvas.getContext("2d");
        let frame = 0;
        setInterval(() => {
          drawing.fillStyle = `hsl(${(frame++ * 37) % 360} 70% 50%)`;
          drawing.fillRect(0, 0, 640, 360);
        }, 1000 / 15);
        const camera = canvas.captureStream(15).getVideoTracks()[0];
        const tileSize = { width: 640, height: 360 };
        const videos = new Map();
        window.cameraIds = [];
        let reported = false;
        let client;
        const call = async (method, input) => {
          const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ index, method, input }) });
          if (!response.ok) throw new Error("Dev RPC failed");
          const result = await response.json();
          if (method === "listPublications" && viewer && !reported) {
            // The UI lays out its tiles before any video arrives: report them before the client sees the list.
            window.cameraIds = result.publications.filter((publication) => publication.source === "camera").map((publication) => publication.publicationId);
            window.cameraIds.forEach((id, slot) => ChalkMedia.setVideoTileVisibility(id, slot < visible ? tileSize : null));
            reported = true;
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
            if (publication.source !== "camera") return;
            let video = videos.get(publication.publicationId);
            if (!video) {
              video = Object.assign(document.createElement("video"), { autoplay: true, muted: true, playsInline: true, width: 320, height: 180 });
              document.body.append(video);
              videos.set(publication.publicationId, video);
            }
            video.srcObject = new MediaStream([publication.track]);
            void video.play();
          },
        });
        // Resolves with the time the tile's next video frame is presented after `since`.
        window.nextFrame = (id, since) =>
          new Promise((resolve) => {
            const wait = () => {
              const video = videos.get(id);
              const live = video?.srcObject?.getVideoTracks()[0]?.readyState === "live";
              if (!live) return void setTimeout(wait, 5);
              video.requestVideoFrameCallback((now) => (now >= since ? resolve(now) : wait()));
            };
            wait();
          });
        window.show = async (id) => {
          const since = performance.now();
          ChalkMedia.setVideoTileVisibility(id, tileSize);
          return (await window.nextFrame(id, since)) - since;
        };
        window.hide = (id) => ChalkMedia.setVideoTileVisibility(id, null);
        window.page = (ids) => window.cameraIds.forEach((id) => ChalkMedia.setVideoTileVisibility(id, ids.includes(id) ? tileSize : null));
        window.inboundVideo = async () => {
          const byTrack = new Map(client.getSnapshot().remoteTracks.map((item) => [item.track.id, item.publicationId]));
          const rows = (await Promise.all(window.proofPCs.map(async (pc) => [...(await pc.getStats()).values()]))).flat();
          return rows.filter((row) => row.type === "inbound-rtp" && row.kind === "video").map((row) => ({ id: row.id, publicationId: byTrack.get(row.trackIdentifier) ?? null, bytes: row.bytesReceived ?? 0 }));
        };
        window.receivers = () => {
          const transceivers = window.proofPCs.filter((pc) => pc.connectionState !== "closed").flatMap((pc) => pc.getTransceivers());
          const open = transceivers.filter((transceiver) => !transceiver.stopped && transceiver.currentDirection === "recvonly" && transceiver.receiver.track.readyState === "live");
          return { video: open.filter((transceiver) => transceiver.receiver.track.kind === "video").length, audio: open.filter((transceiver) => transceiver.receiver.track.kind === "audio").length };
        };
        // The SDK's own call-stats summary: receive bitrate over one window.
        window.callStatsWindow = async (milliseconds) => {
          let sample;
          const collector = ChalkMedia.createCallStatsCollector({ upload: async () => undefined });
          const until = Date.now() + milliseconds;
          while (Date.now() < until + 500) {
            for (const pc of window.proofPCs.filter((item) => item.connectionState !== "closed")) collector.observe(await pc.getStats());
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          await collector.flush(async (request) => void (sample = request.samples.at(-1)));
          return sample?.recv_bitrate_kbps ?? null;
        };
        await client.start(new MediaStream([...output.stream.getAudioTracks(), ...(viewer ? [] : [camera])]));
      },
      { index, bootstrap, viewer: index === VIEWER, visible: VISIBLE },
    );
  }
  const viewer = states.get(VIEWER);
  const evaluate = (fn, arg) => viewerPage.evaluate(fn, arg);
  await until(async () => (await evaluate(() => window.cameraIds.length)) === PUBLISHERS, 10_000, "viewer listed every camera");
  const cameraIds = await evaluate(() => window.cameraIds);
  const pulled = (source) => viewer.pulls.flatMap((pull) => pull.sources).filter((item) => item === source).length;
  await until(async () => (await evaluate(() => window.receivers())).video === VISIBLE && (await evaluate(() => window.receivers())).audio === PUBLISHERS, 30_000, "4 videos and 8 microphones received");
  await pause(3000);
  const grid = { videoPulls: pulled("camera"), audioPulls: pulled("microphone"), pullCalls: viewer.pulls.length, receivers: await evaluate(() => window.receivers()) };
  assert.deepEqual({ video: grid.videoPulls, audio: grid.audioPulls }, { video: VISIBLE, audio: PUBLISHERS }, "first pull is 4 videos and 8 microphones");
  const providerSession = await provider(`sessions/${viewer.sessionId}`, "GET");
  grid.providerRemoteTracks = providerSession.tracks.filter((track) => track.location === "remote").reduce((count, track) => ({ ...count, [`${sourceOf(track.trackName)}:${track.status ?? "listed"}`]: (count[`${sourceOf(track.trackName)}:${track.status ?? "listed"}`] ?? 0) + 1 }), {});
  const before = await evaluate(() => window.inboundVideo());
  await pause(3000);
  const after = await evaluate(() => window.inboundVideo());
  const flowing = after.filter((row) => row.bytes > (before.find((item) => item.id === row.id)?.bytes ?? 0)).map((row) => row.publicationId);
  grid.flowingVideo = flowing.length;
  grid.hiddenVideoBytes = after.filter((row) => !cameraIds.slice(0, VISIBLE).includes(row.publicationId)).reduce((sum, row) => sum + row.bytes, 0);
  assert.deepEqual(flowing.sort(), cameraIds.slice(0, VISIBLE).sort(), "only on-screen tiles receive video bytes");
  assert.equal(grid.hiddenVideoBytes, 0, "hidden tiles receive no video bytes");
  console.log(JSON.stringify({ stage: "grid", ...grid }));

  // Within the debounce: the pull stays, so showing the tile again costs no pull.
  const warm = [];
  for (const id of cameraIds.slice(0, VISIBLE)) {
    const pulls = viewer.pulls.length;
    await evaluate((tile) => window.hide(tile), id);
    await pause(1000);
    warm.push(Math.round(await evaluate((tile) => window.show(tile), id)));
    assert.equal(viewer.pulls.length, pulls, "a tile shown within the debounce is not pulled again");
  }
  console.log(JSON.stringify({ stage: "warm_resume", firstFrameMs: warm }));

  // A tile never pulled scrolls in, then leaves; it is closed after the debounce and pulled again when it returns.
  const debounceMs = await evaluate(() => ChalkMedia.HIDDEN_TILE_CLOSE_MS);
  const firstPull = [];
  const closeAfterMs = [];
  const repull = [];
  for (const id of cameraIds.slice(VISIBLE)) {
    firstPull.push(Math.round(await evaluate((tile) => window.show(tile), id)));
    const hiddenAt = Date.now();
    const closes = viewer.closes.length;
    await evaluate((tile) => window.hide(tile), id);
    await until(() => viewer.closes.slice(closes).some((close) => close.publicationIds.includes(id)), debounceMs + 5000, "hidden tile closed after the debounce");
    closeAfterMs.push(Date.now() - hiddenAt);
    repull.push(Math.round(await evaluate((tile) => window.show(tile), id)));
    await evaluate((tile) => window.hide(tile), id);
  }
  await until(async () => (await evaluate(() => window.receivers())).video === VISIBLE, debounceMs + 5000, "scrolled-away tiles closed");
  assert.ok(Math.min(...closeAfterMs) >= debounceMs, "no tile is closed before the debounce");
  console.log(JSON.stringify({ stage: "cold_resume", firstPullFrameMs: firstPull, closeAfterHideMs: closeAfterMs, repullFrameMs: repull }));

  // Rapid scrolling between the two pages, ending on the first.
  const storm = { pullCalls: viewer.pulls.length, closeCalls: viewer.closes.length };
  for (let flip = 0; flip < 30; flip++) {
    await evaluate((ids) => window.page(ids), flip % 2 ? cameraIds.slice(0, VISIBLE) : cameraIds.slice(VISIBLE));
    await pause(50);
  }
  await evaluate((ids) => window.page(ids), cameraIds.slice(0, VISIBLE));
  await pause(debounceMs + 4000);
  storm.pullCalls = viewer.pulls.length - storm.pullCalls;
  storm.closeCalls = viewer.closes.length - storm.closeCalls;
  storm.receivers = await evaluate(() => window.receivers());
  storm.transceivers = await evaluate(
    () =>
      window.proofPCs
        .filter((pc) => pc.connectionState !== "closed")
        .flatMap((pc) => pc.getTransceivers())
        .filter((transceiver) => !transceiver.stopped).length,
  );
  const stormSession = await provider(`sessions/${viewer.sessionId}`, "GET");
  storm.providerRemoteTracks = stormSession.tracks.filter((track) => track.location === "remote").reduce((count, track) => ({ ...count, [`${sourceOf(track.trackName)}:${track.status ?? "listed"}`]: (count[`${sourceOf(track.trackName)}:${track.status ?? "listed"}`] ?? 0) + 1 }), {});
  assert.deepEqual(storm.receivers, { video: VISIBLE, audio: PUBLISHERS }, "rapid scrolling leaks no receivers");
  console.log(JSON.stringify({ stage: "storm", ...storm }));

  // The same call-stats window with 4 tiles and then with every tile on screen.
  const recvKbpsFourTiles = await evaluate(() => window.callStatsWindow(10_000));
  await evaluate((ids) => window.page(ids), cameraIds);
  await until(async () => (await evaluate(() => window.receivers())).video === PUBLISHERS, 30_000, "every tile received");
  const recvKbpsAllTiles = await evaluate(() => window.callStatsWindow(10_000));
  const errors = await evaluate(() => window.proofErrors);
  console.log(
    JSON.stringify({
      result: "passed",
      publishers: PUBLISHERS,
      visible: VISIBLE,
      grid,
      warmResumeFrameMs: warm,
      cold: { firstPullFrameMs: firstPull, repullFrameMs: repull, closeAfterHideMs: closeAfterMs, debounceMs },
      storm,
      callStats: { recvKbpsFourTiles, recvKbpsAllTiles },
      viewerErrors: errors,
      replacements: viewer.replacements,
      upstreamStatuses: Object.fromEntries(statuses),
    }),
  );
} catch (error) {
  const viewer = states.get(VIEWER);
  console.error(
    JSON.stringify({
      result: "failed",
      error: error.message,
      viewer: viewer && { pulls: viewer.pulls, closes: viewer.closes.map((close) => ({ at: close.at, count: close.publicationIds.length })), replacements: viewer.replacements },
      browser: viewerPage && (await viewerPage.evaluate(() => ({ errors: window.proofErrors, receivers: window.receivers?.(), remote: window.client?.getSnapshot().remoteTracks.map((item) => item.source) })).catch(() => null)),
      upstreamStatuses: Object.fromEntries(statuses),
    }),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
