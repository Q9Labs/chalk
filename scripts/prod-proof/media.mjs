import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installFixture } from "./fixture.mjs";
import { installAgreementProbe, playProofMedia } from "../web-proof/agreement.mjs";
import { check, save, waitFor, maskCredentials } from "./runtime.mjs";
import { credentialExpiries, issueCredentialRefresh, waitForCredentialRefresh } from "./credential-refresh.mjs";
import { installLeaveObservation } from "./leave-observation.mjs";

const requireSDK = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
const { chromium } = requireSDK("playwright");
const { build } = requireSDK("esbuild");

async function sdkBundle(entry = "./sdks/typescript/client/src/index.ts") {
  const result = await build({
    stdin: {
      contents: `import {createSpaceClient} from ${JSON.stringify(entry)};
window.proofJoin=async(space,baseUrl,displayName)=>{
 const client=createSpaceClient({space,baseUrl,getAccess:({reason,replaceMediaConnection})=>window.proofAccess({reason,replaceMediaConnection})});
 window.proofClient=client;await client.join({displayName,microphone:true,camera:true});
};`,
      resolveDir: process.cwd(),
      sourcefile: "proof.ts",
    },
    logLevel: "silent",
    nodePaths: [new URL("../../sdks/typescript/client/node_modules", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  return result.outputFiles[0].text;
}
export async function launchGuests(run, space, episode, speech, origin, tones = false, guestCount = 2, options = {}) {
  const bundle = await sdkBundle(options.sdkEntry);
  const serverPath = `${run.directory}/sdk-server.mjs`;
  await build({ logLevel: "silent", entryPoints: [new URL("../../sdks/typescript/client/src/server/index.ts", import.meta.url).pathname], bundle: true, outfile: serverPath, format: "esm", platform: "node" });
  const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(serverPath).href);
  const chalk = createChalkServerClient({ apiKey: run.apiKey, tenantId: run.config.tenant_id, apiBaseURL: run.config.api_url, headers: { "User-Agent": "Chalk-Production-Proof/1.0" }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) });
  const pages = [];
  const reopen = [];
  const close = [];
  const participants = [];
  const refreshes = [];
  const networks = [];
  for (let guest = 0; guest < guestCount; guest++) {
    const admission = await chalk.participants.admit(space.id, episode.id, { name: `Proof guest ${guest + 1}`, role: "owner" });
    let grant = admission.access;
    maskCredentials(grant);
    const initial = credentialExpiries(grant);
    const refresh = { guest: guest + 1, count: 0, initialExpiry: initial.mediaExpiry, initialSyncExpiry: initial.syncExpiry, latestExpiry: 0, requests: [] };
    refreshes.push(refresh);
    let first = true;
    let queue = Promise.resolve();
    const open = async (replacing = false) => {
      let replaceOnNextAccess = replacing;
      const server = await chromium.launchServer({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--auto-select-tab-capture-source-by-title=Chalk proof screen share", "--enable-usermedia-screen-capturing"],
      });
      close[guest] = async () => {
        if (networks[guest]) await save(`${run.directory}/guest-${guest + 1}-network.json`, networks[guest]);
        await server.close();
      };
      run.resources.push({
        kind: "headless-browser",
        dispose: close[guest],
        force: () => {
          try {
            process.kill(-server.process().pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        },
      });
      const browser = await chromium.connect(server.wsEndpoint());
      const context = await browser.newContext({ permissions: ["camera", "microphone"] });
      await context.addInitScript(installAgreementProbe);
      await context.addInitScript(`window.proofPlayMedia = (${playProofMedia.toString()});`);
      await context.addInitScript(installFixture, { speech, guest, tones });
      if (options.observeLeave) await context.addInitScript(installLeaveObservation);
      const page = await context.newPage();
      const network = [];
      networks[guest] = network;
      const record = (event) => network.push({ at: new Date().toISOString(), ...event });
      const requests = new WeakMap();
      page.on("request", (request) => {
        const operation = signalingOperation(request.url());
        if (!operation) return;
        requests.set(request, performance.now());
        record({ type: "signaling-request", operation, method: request.method() });
      });
      page.on("response", (response) => {
        const operation = signalingOperation(response.url());
        if (!operation) return;
        const started = requests.get(response.request());
        record({ type: "signaling-response", operation, status: response.status(), ...(started === undefined ? {} : { durationMs: performance.now() - started }) });
      });
      page.on("requestfailed", (request) => {
        const operation = signalingOperation(request.url());
        if (operation) record({ type: "request-failed", operation, error: signalingFailure(request) });
      });
      page.on("websocket", (socket) => {
        socket.on("socketerror", () => record({ type: "websocket-error" }));
        socket.on("framereceived", ({ payload }) => {
          try {
            const frame = JSON.parse(String(payload));
            record({ type: "websocket-frame", frameType: frame.type, event: frame.event, code: frame.code, status: frame.status });
          } catch {
            record({ type: "websocket-frame", bytes: payload.length });
          }
        });
      });
      const issueRefresh = async (request) => {
        const replaceMediaConnection = replaceOnNextAccess || request.replaceMediaConnection;
        grant = await issueCredentialRefresh(run, refreshes, refresh, { reason: request.reason, replaceMediaConnection }, () => chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant), { replaceMediaConnection }));
        replaceOnNextAccess = false;
        return grant;
      };
      await page.exposeFunction("proofAccess", (request) => {
        const next = queue.then(async () => {
          if (first) {
            first = false;
            return grant;
          }
          return issueRefresh(request);
        });
        queue = next.catch(() => {}); // The caller receives errors; a failed refresh must not poison later calls.
        return next;
      });
      await page.goto(origin);
      await page.evaluate(installTransportDiagnostics);
      await page.addScriptTag({ content: bundle });
      try {
        await page.evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: space.slug, api: run.config.api_url, name: `Proof guest ${guest + 1}` });
      } finally {
        await save(`${run.directory}/guest-${guest + 1}-network.json`, network);
      }
      return page;
    };
    pages.push(await open());
    participants.push(admission.participant.id);
    reopen.push(open);
  }
  const ready = () =>
    waitFor("two live camera and voice publishers", async () => {
      for (const page of pages) {
        const live = await page.evaluate(() => {
          const snapshot = window.proofClient.getSnapshot();
          const readiness = [snapshot.connection.status === "live", snapshot.participants.roster.length === 2, snapshot.media.local.microphone.state === "enabled", snapshot.media.local.camera.state === "enabled"];
          return readiness.every(Boolean) && snapshot.media.remote.some((entry) => entry.track.readyState === "live");
        });
        if (!live) return false;
      }
      return true;
    });
  if (guestCount > 1) await ready();
  return {
    pages,
    participants,
    waitForRefresh: async () => {
      try {
        await waitForCredentialRefresh(run, refreshes, ready);
      } finally {
        await Promise.all(networks.map((network, guest) => save(`${run.directory}/guest-${guest + 1}-network.json`, network)));
      }
    },
    rejoin: async (guest) => {
      // Closing the entire browser drops transports without an SDK leave request.
      await close[guest]();
      await run.wait(2000);
      pages[guest] = await reopen[guest](true);
      await ready();
      const participant = await pages[guest].evaluate(() => window.proofClient.getSnapshot().self.participantId);
      check(participant === participants[guest], "Rejoin changed participant identity");
      return participant;
    },
  };
}
function signalingFailure(request) {
  const error = request.failure()?.errorText;
  return /^net::ERR_[A-Z_]+$/.test(error) ? error : "request_failed";
}

export function signalingOperation(url) {
  const path = new URL(url).pathname;
  const operation = /\/media\/sfu\/(tracks\/close|tracks|renegotiate|publications)$/.exec(path)?.[1];
  return operation ?? (path.endsWith("/access-grant") ? "access-grant" : null);
}

export function installTransportDiagnostics() {
  const NativePC = window.RTCPeerConnection;
  const events = (window.proofTransportDiagnostics = []);
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) {
      super(...args);
      const connection = window.proofConnections.indexOf(this);
      const observed = new WeakSet();
      const capture = () => {
        events.push({ at: new Date().toISOString(), connection, type: "peer-state", signalingState: this.signalingState, iceConnectionState: this.iceConnectionState, connectionState: this.connectionState });
        for (const transceiver of this.getTransceivers()) {
          const dtls = transceiver.sender.transport;
          if (!dtls || observed.has(dtls)) continue;
          observed.add(dtls);
          const record = () => events.push({ at: new Date().toISOString(), connection, type: "dtls-state", state: dtls.state });
          dtls.addEventListener("statechange", record);
          record();
        }
      };
      for (const name of ["signalingstatechange", "iceconnectionstatechange", "connectionstatechange", "track"]) this.addEventListener(name, capture);
      capture();
    }
  };
}

export function browserStats() {
  function sourceFor(row, cameraMids, screenMids, remote) {
    if (row.type === "inbound-rtp") return remote.find((entry) => entry.track.id === row.trackIdentifier)?.source;
    const sources = new Map([...cameraMids.map((mid) => [mid, "camera"]), ...screenMids.map((mid) => [mid, "screen"])]);
    return sources.get(row.mid);
  }
  function serialize(row, index, cameraMids, screenMids, remote) {
    if (row.type === "transport") return { at: new Date().toISOString(), connection: index, type: "transport", dtlsState: row.dtlsState, iceState: row.iceState, packetsSent: row.packetsSent, packetsReceived: row.packetsReceived, bytesSent: row.bytesSent, bytesReceived: row.bytesReceived };
    return {
      at: new Date().toISOString(),
      connection: index,
      id: row.id,
      type: row.type,
      camera: cameraMids.includes(row.mid),
      source: sourceFor(row, cameraMids, screenMids, remote),
      kind: row.kind,
      rid: row.rid,
      mid: row.mid,
      trackIdentifier: row.trackIdentifier,
      bytesSent: row.bytesSent,
      bytesReceived: row.bytesReceived,
      packetsReceived: row.packetsReceived,
      packetsSent: row.packetsSent,
      packetsLost: row.packetsLost,
      jitter: row.jitter,
      framesDropped: row.framesDropped,
      retransmittedPacketsSent: row.retransmittedPacketsSent,
      framesEncoded: row.framesEncoded,
      framesDecoded: row.framesDecoded,
      frameWidth: row.frameWidth,
      frameHeight: row.frameHeight,
      framesPerSecond: row.framesPerSecond,
      qualityLimitationReason: row.qualityLimitationReason,
      audioLevel: row.audioLevel,
      totalAudioEnergy: row.totalAudioEnergy,
      totalSamplesDuration: row.totalSamplesDuration,
    };
  }
  return (async () => {
    const rows = [...(window.proofTransportDiagnostics ?? [])];
    for (let index = 0; index < window.proofConnections.length; index++) {
      const connection = window.proofConnections[index];
      const snapshot = window.proofClient.getSnapshot();
      const cameraMids = connection
        .getTransceivers()
        .filter((transceiver) => transceiver.sender.track?.id === window.proofCameraId)
        .map((transceiver) => transceiver.mid);
      const screenMids = connection
        .getTransceivers()
        .filter((transceiver) => transceiver.sender.track?.id === snapshot.media.screenShare.track?.id)
        .map((transceiver) => transceiver.mid);
      rows.push({ at: new Date().toISOString(), connection: index, type: "peer-state", signalingState: connection.signalingState, iceConnectionState: connection.iceConnectionState, connectionState: connection.connectionState });
      const selected = [...(await connection.getStats()).values()].filter((row) => ["transport", "outbound-rtp", "inbound-rtp", "media-source"].includes(row.type));
      rows.push(...selected.map((row) => serialize(row, index, cameraMids, screenMids, snapshot.media.remote)));
    }
    return rows;
  })();
}
export async function stats(pages) {
  return Promise.all(pages.map((page) => page.evaluate(browserStats)));
}
export function movingLayers(before, after) {
  const outbound = after.filter((row) => row.type === "outbound-rtp" && row.camera && row.rid);
  return outbound.filter((row) => before.some((previous) => previous.id === row.id && previous.connection === row.connection && row.framesEncoded > previous.framesEncoded));
}
export async function limitCamera(page) {
  return page.evaluate(async () => {
    async function limit(sender) {
      const parameters = sender.getParameters();
      if (parameters.encodings.length !== 3) throw new Error("Camera did not negotiate three simulcast encodings");
      for (const encoding of parameters.encodings) {
        encoding.active = encoding.rid === "q";
        encoding.maxBitrate = 80_000;
      }
      await sender.setParameters(parameters);
      return sender.getParameters().encodings;
    }
    const senders = window.proofConnections.flatMap((connection) => connection.getSenders()).filter((sender) => sender.track?.id === window.proofCameraId);
    if (!senders.length) throw new Error("No camera sender found");
    const applied = [];
    for (const sender of senders) applied.push(await limit(sender));
    return applied;
  });
}
export async function restoreCamera(page) {
  await page.evaluate(async () => {
    const senders = window.proofConnections.flatMap((connection) => connection.getSenders()).filter((sender) => sender.track?.id === window.proofCameraId);
    for (const sender of senders) {
      const parameters = sender.getParameters();
      for (const encoding of parameters.encodings) {
        encoding.active = true;
        encoding.maxBitrate = { q: 120_000, h: 450_000, f: 1_500_000 }[encoding.rid];
      }
      await sender.setParameters(parameters);
    }
  });
}
function lowerCamera(previous, current) {
  return [previous.id === current.id, previous.connection === current.connection, current.frameWidth > 0, previous.frameWidth > current.frameWidth, current.framesDecoded > previous.framesDecoded].every(Boolean);
}
function receivingCameras(rows) {
  return rows.filter((row) => row.type === "inbound-rtp" && row.source === "camera");
}
async function proveLimitedLayers(run, moving, receiveBefore, after) {
  check(
    moving.some((row) => row.rid === "q"),
    "Low layer stopped transmitting under the limit",
  );
  check(!moving.some((row) => row.rid === "f" || row.rid === "h"), "Upper layers still transmitting under the limit");
  const previousReceive = receivingCameras(receiveBefore[1]);
  const changed = receivingCameras(after[1]).find((row) => previousReceive.some((old) => lowerCamera(old, row)));
  check(changed, "No inbound resolution/layer switch observed; a throttle acknowledgement is not proof");
  await save(`${run.directory}/layer-switch.json`, { method: "RTCRtpSender.setParameters", maxBitrate: 80_000, activeRid: "q", inboundBefore: previousReceive, inboundAfter: changed, moving });
}
export async function proveLayers(run, { before, after, limited = false, receiveBefore = before }) {
  const moving = movingLayers(before[0], after[0]);
  if (limited) await proveLimitedLayers(run, moving, receiveBefore, after);
  else {
    for (let guest = 0; guest < after.length; guest++) {
      const layers = movingLayers(before[guest], after[guest]);
      check(new Set(layers.map((row) => row.rid)).size === 3, "Stats did not prove three live simulcast encodings");
    }
  }
  return moving;
}

function receivedStreamMoved(rows, current) {
  const previous = rows.find((row) => row.id === current.id && row.connection === current.connection);
  if (!previous) return false;
  if (!(current.bytesReceived > previous.bytesReceived)) return false;
  return current.kind !== "video" || current.framesDecoded > previous.framesDecoded;
}
export async function waitForMediaProgress(pages) {
  let before = await stats(pages);
  let evidence;
  await waitFor(
    "initial bidirectional audio and video progress",
    async () => {
      const after = await stats(pages);
      const ready = after.length === 2 && after.every((rows, guest) => ["audio", "video"].every((kind) => rows.some((row) => row.type === "inbound-rtp" && row.kind === kind && row.source === { audio: "microphone", video: "camera" }[kind] && receivedStreamMoved(before[guest], row))));
      if (ready) evidence = { before, after };
      before = after;
      return ready;
    },
    30_000,
    1000,
  );
  return evidence;
}
export function checkMediaProgress(before, after) {
  check(before.length === after.length && after.length === 2, "Post-refresh media requires both clients");
  for (let guest = 0; guest < after.length; guest++) {
    for (const kind of ["audio", "video"]) {
      const source = { audio: "microphone", video: "camera" }[kind];
      const receivers = after[guest].filter((row) => row.type === "inbound-rtp" && row.kind === kind && row.source === source);
      check(
        receivers.some((current) => receivedStreamMoved(before[guest], current)),
        `Client ${guest + 1} stopped receiving ${kind} after credential refresh`,
      );
    }
  }
}
