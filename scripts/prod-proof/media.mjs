import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installFixture } from "./fixture.mjs";
import { check, save, waitFor } from "./runtime.mjs";

const requireSDK = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
const { chromium } = requireSDK("playwright");
const { build } = requireSDK("esbuild");

async function sdkBundle() {
  const result = await build({
    stdin: {
      contents: `import {createSpaceClient} from './sdks/typescript/client/src/index.ts';
window.proofJoin=async(space,baseUrl,displayName)=>{
 const client=createSpaceClient({space,baseUrl,getAccess:()=>window.proofAccess()});
 window.proofClient=client;await client.join({displayName,microphone:true,camera:true});
};`,
      resolveDir: process.cwd(),
      sourcefile: "proof.ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    plugins: [
      {
        name: "proof-workspace-source",
        setup(builder) {
          builder.onResolve({ filter: /^@q9labsai\/diagnostics-contracts$/ }, () => ({ path: new URL("../../packages/diagnostics-contracts/src/index.ts", import.meta.url).pathname }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}
export async function launchGuests(run, space, episode, speech, origin) {
  const bundle = await sdkBundle();
  const serverPath = `${run.directory}/sdk-server.mjs`;
  await build({ entryPoints: [new URL("../../sdks/typescript/client/src/server/index.ts", import.meta.url).pathname], bundle: true, outfile: serverPath, format: "esm", platform: "node" });
  const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(serverPath).href);
  const chalk = createChalkServerClient({ apiKey: run.apiKey, tenantId: run.config.tenant_id, apiBaseURL: run.config.api_url, headers: { "User-Agent": "Chalk-Production-Proof/1.0" }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) });
  const pages = [];
  for (let guest = 0; guest < 2; guest++) {
    const admission = await chalk.participants.admit(space.id, episode.id, { name: `Proof guest ${guest + 1}`, role: "owner" });
    let grant = admission.access;
    let first = true;
    let queue = Promise.resolve();
    const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--auto-select-tab-capture-source-by-title=Chalk proof screen share", "--enable-usermedia-screen-capturing"] });
    run.resources.push({ kind: "headless-browser", dispose: () => browser.close() });
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    await context.addInitScript(installFixture, { speech, guest });
    const page = await context.newPage();
    const network = [];
    page.on("requestfailed", (request) => network.push({ type: "request-failed", path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on("websocket", (socket) => {
      socket.on("socketerror", (error) => network.push({ type: "websocket-error", error }));
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          network.push({ type: "websocket-frame", frameType: frame.type, event: frame.event, code: frame.code, status: frame.status });
        } catch {
          network.push({ type: "websocket-frame", bytes: payload.length });
        }
      });
    });
    await page.exposeFunction("proofAccess", () => {
      const next = queue.then(async () => {
        if (first) {
          first = false;
          return grant;
        }
        grant = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant));
        return grant;
      });
      queue = next.catch(() => {}); // The caller receives errors; a failed refresh must not poison later calls.
      return next;
    });
    await page.goto(origin);
    await page.addScriptTag({ content: bundle });
    try {
      await page.evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: space.slug, api: run.config.api_url, name: `Proof guest ${guest + 1}` });
    } finally {
      await save(`${run.directory}/guest-${guest + 1}-network.json`, network);
    }
    pages.push(page);
  }
  await waitFor("two live camera and voice publishers", async () => {
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
  return pages;
}
function browserStats() {
  function sourceFor(row, cameraMids, screenMids, remote) {
    if (row.type === "inbound-rtp") return remote.find((entry) => entry.track.id === row.trackIdentifier)?.source;
    const sources = new Map([...cameraMids.map((mid) => [mid, "camera"]), ...screenMids.map((mid) => [mid, "screen"])]);
    return sources.get(row.mid);
  }
  function serialize(row, index, cameraMids, screenMids, remote) {
    return {
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
      framesEncoded: row.framesEncoded,
      framesDecoded: row.framesDecoded,
      frameWidth: row.frameWidth,
      frameHeight: row.frameHeight,
      framesPerSecond: row.framesPerSecond,
      qualityLimitationReason: row.qualityLimitationReason,
      audioLevel: row.audioLevel,
      totalAudioEnergy: row.totalAudioEnergy,
    };
  }
  return (async () => {
    const rows = [];
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
      for (const row of (await connection.getStats()).values()) {
        if (["outbound-rtp", "inbound-rtp", "media-source"].includes(row.type)) rows.push(serialize(row, index, cameraMids, screenMids, snapshot.media.remote));
      }
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
